# Global Value-at-Risk Caps (Guarded Launch)

**GitHub issue:** [#240](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/240)

## Problem

The contract enforces per-user spend limits but has no protocol-wide ceiling on
how much value can leave the wallet in a given period. During a guarded launch,
an unknown bug (re-entrancy, oracle error, misconfigured allowlist) could drain
funds from many accounts before anyone can respond. A global cap bounds the
worst-case loss.

## Threat Model

| Threat | Without caps | With caps |
|---|---|---|
| Smart-contract bug affecting multiple users | Unlimited drain | Capped at daily volume limit |
| Compromised guardian key triggering mass recovery | Full TVL at risk | Capped per token |
| Misconfigured fee or amount multiplier | All affected sends go through | Halts at cap |

## Design

### Per-token global daily cap in `send`

A new storage entry `GlobalDailyCap { asset_code: Symbol, cap: i128 }` is set
by the admin. `send` reads the global rolling accumulator for the token and
rejects the transaction with `GlobalCapExceeded` if adding the requested amount
would breach the cap.

The global accumulator uses the same hourly-bucket rolling window as per-user
spend limits (see [spend-limits.md](specs/spend-limits.md)), so the cap applies
to any 24-hour window, not a calendar day.

```
GlobalDailyCap(asset_code)  →  i128           # 0 = no cap
GlobalDailySpent(asset_code, bucket)  →  i128  # rolling hourly buckets
```

### Admin controls with timelock

Cap changes go through a two-step timelock to prevent a compromised admin key
from silently raising limits:

1. `propose_global_cap(asset_code, new_cap)` — records the proposal and emits
   `GlobalCapProposed { asset_code, new_cap, effective_at_ledger }`.
2. After `CAP_TIMELOCK_LEDGERS` (initially 2 880 ledgers ≈ 4 hours at ~5 s/ledger),
   `apply_global_cap(asset_code)` activates the change.

Lowering a cap takes effect immediately without a timelock (reducing exposure
is always safe).

### Events

Every relevant state change emits an event so the backend and monitoring can
react without polling:

| Event | Fields |
|---|---|
| `global_cap_proposed` | `asset_code`, `new_cap`, `effective_at_ledger` |
| `global_cap_applied` | `asset_code`, `cap` |
| `global_cap_exceeded` | `asset_code`, `attempted`, `remaining` |
| `global_daily_spend` | `asset_code`, `amount`, `cumulative` |

### Backend display

`GET /api/v1/contract/global-caps` returns the current cap, cumulative spend
for the rolling window, and the remaining headroom per token:

```json
{
  "caps": [
    {
      "asset_code": "XLM",
      "cap": "10000000000000",
      "spent": "3200000000000",
      "remaining": "6800000000000",
      "window_resets_at": "2025-01-16T10:00:00Z"
    }
  ]
}
```

`cap: null` means no global cap is set for that token.

The admin dashboard additionally shows pending timelock proposals and their
`effective_at_ledger`.

## Tasks

- [ ] Add `GlobalDailyCap` and `GlobalDailySpent` storage entries to `lib.rs`
- [ ] Enforce cap check in `send`; emit `global_cap_exceeded` on rejection
- [ ] Implement `propose_global_cap` and `apply_global_cap` with timelock
- [ ] Emit `global_cap_proposed`, `global_cap_applied`, `global_daily_spend` events
- [ ] Add `GET /api/v1/contract/global-caps` backend endpoint
- [ ] Expose cap headroom in admin dashboard
- [ ] Update OpenAPI spec and SDK
- [ ] Update this doc and README once live
- [ ] Add tests (see test plan below)

## Test Plan

1. Set a global XLM cap of 1 000 XLM across 10 test accounts. Confirm the cap
   is enforced when cumulative sends from distinct users exceed the cap.
2. Confirm a single user cannot breach the cap even if they are under their
   personal limit.
3. Raise the cap via `propose_global_cap`, confirm the new cap is not in force
   until after the timelock ledger; confirm it activates after.
4. Lower the cap immediately (no timelock); confirm it takes effect in the same
   ledger.
5. Confirm `GlobalCapExceeded` is emitted with the correct `remaining` field.
6. Confirm that `GET /api/v1/contract/global-caps` reflects state within one
   ledger of a cap change.

## Acceptance Criteria

- Global cap is enforced across users; individual users cannot collectively
  exceed the cap in any 24-hour window.
- Cap changes above the current value require the timelock; reductions are
  immediate.
- `global_cap_exceeded` event is emitted on every blocked send.
- Backend endpoint exposes current cap, spent, remaining, and window reset time.
- CI is green (lint, type-check, tests).
- No new TODOs without a linked issue.

## References

- Contract: [`contract/contracts/globe-wallet/src/lib.rs`](../contract/contracts/globe-wallet/src/lib.rs)
- Related: [Spend Limits UX Spec](specs/spend-limits.md)
- Related: [Issue #239 — Mainnet launch checklist](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/239)
