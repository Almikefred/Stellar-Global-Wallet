# `record_spend` rolling window (issue #177)

The old fixed bucket (`day = timestamp / 86_400`) let the full limit be spent
at 23:59 UTC and again at 00:00 UTC, so the real worst case was 2× the limit.
`record_spend` now enforces a rolling 24 h window.

## Threat model

A compromised key can sign any `record_spend`/`send`. The limit is the only
thing capping loss, so the guarantee must hold for every 24 h interval, not
only for calendar days.

## Data model

One persistent entry per (user, asset): `DataKey::SpendWindow(user, code)` →

```rust
struct SpendWindow { head_hour: u64, buckets: Vec<i128> } // 25 buckets
```

- Bucket `h % 25` holds the amount spent during hour `h = timestamp / 3600`.
- Before every read the ring is advanced to the current hour, zeroing buckets
  that fell out. Storage and CPU are O(1) (25 slots, at most 25 writes).
- 24 buckets cover the window; the extra guard bucket means a spend is only
  dropped once it is **more than** 24 h old.

**Guarantee:** for the last accepted spend in any interval shorter than 24 h,
every earlier spend in that interval is less than 24 h old, so it was counted
when that spend was checked. The total is therefore ≤ the limit. The cost is
that a spend can stay counted for up to 25 h.

A token bucket (capacity = limit, refill = limit/86 400 per second) was
considered and rejected: it keeps refilling while you spend, so it allows up
to 2× the limit inside one 24 h interval, which is the bug being fixed.

## Related behaviour

- Spends are recorded whether or not a limit is set (issue #179). Enabling a
  limit later is checked against what was already spent.
- `get_spend_allowance` returns `spent`, `remaining`, `window_start`,
  `window_resets_at` (every counted spend gone) and `next_refill_at` (oldest
  counted bucket rolls off; 0 when nothing is counted).
- `migrate_user_assets` never deletes `SpendLimit` or `SpendWindow` (#178).

## Failure modes

- **Upgrade from the fixed bucket:** if no `SpendWindow` exists but a legacy
  `DailySpent` record could still overlap the last 24 h, its amount is put in
  the current hour's bucket. That over-counts for at most 25 h, never
  under-counts. `record_spend` removes the legacy entry once folded in.
- **Archival:** the entry lives in persistent storage and its TTL is extended
  to ~2 days on every write, longer than the 25 h it needs to live.
- **Clock:** buckets use ledger close time. Validator drift (±1 s) can move a
  spend into the neighbouring hour bucket. Because of the guard bucket that
  can only make the window stricter by up to one hour.
- **Overflow:** with a limit set, a total that would overflow `i128` returns
  `SpendOverflow`. Without a limit the bookkeeping saturates and never blocks.

Tests: `test_rolling_window_*`, `test_property_rolling_window_never_exceeds_limit_in_any_24h`
and the #179 order-of-operations tests in `contracts/globe-wallet/src/lib.rs`.
