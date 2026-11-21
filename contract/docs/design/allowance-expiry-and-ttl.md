# token-wrapper: allowance expiry vs storage TTL (issue #244)

Status: proposed. Source: [`contracts/token-wrapper/src/lib.rs`](../../contracts/token-wrapper/src/lib.rs).

## Problem

An allowance has two lifetimes that are supposed to agree but are set
independently:

| Lifetime | Where it lives | Who decides it |
|---|---|---|
| **Expiry** | `Allowance.expiry_ledger`, inside the entry | The owner, in `approve` |
| **Storage TTL** | The ledger entry's `live_until_ledger` | `extend_ttl` calls, clamped by network settings |

Today `approve` and `transfer_from` call
`extend_ttl(key, expiry_ledger - now, expiry_ledger - now)`. That is right
when the arithmetic fits in the network's limits. It goes wrong in two ways:

1. **The allowance disappears early.** The network caps how far an entry can
   be extended (`max_entry_ttl`, a network config setting of roughly six months
   on Mainnet; check the current value). If `expiry_ledger - now` is larger
   than that, the host either rejects the extension or clamps it, depending
   on protocol version. In both cases the entry can archive before
   `expiry_ledger`.
2. **An expired allowance stays around.** A new persistent entry always gets
   at least the network's minimum persistent TTL. An allowance approved for
   100 ledgers therefore stays readable long after it expired. `transfer_from`
   correctly rejects it with `AllowanceExpired`, but `allowance()` still
   returns the stale amount, and wallets that show "remaining allowance"
   without checking `expiry_ledger` mislead the user.

When an entry has archived, any read of it needs a restore first. Simulation
returns a restore preamble instead of a value. Clients that don't handle this,
and test environments where the entry is simply gone, see
`Allowance { amount: 0, expiry_ledger: 0 }`, so `transfer_from` fails with
`InsufficientAllowance` even though the owner never revoked anything.

## Decision

**`expiry_ledger` is the only source of truth for whether an allowance is
valid. Storage TTL is a cost-and-liveness detail that the contract manages on
its own.** In detail:

### 1. Clamp every extension to the network maximum

```rust
fn extend_allowance(env: &Env, key: &WrapperDataKey, expiry_ledger: u32) -> u32 {
    let now = env.ledger().sequence();
    let wanted = expiry_ledger.saturating_sub(now);
    let extend_to = wanted.min(env.storage().max_ttl());
    if extend_to > 0 {
        env.storage().persistent().extend_ttl(key, extend_to, extend_to);
    }
    extend_to
}
```

`approve`, `transfer_from` and `extend_allowance_ttl` all go through this one
helper. With the clamp, behaviour no longer depends on how the host treats an
over-long extension.

Because `live_until_ledger = now + extend_to` and both the entry and the
allowance are inclusive of their last ledger, an unclamped extension makes the
entry live **exactly through** `expiry_ledger`. There is no off-by-one.

### 2. Keep long allowances alive: extend on use, plus the keeper

When `expiry_ledger - now > max_ttl`, the entry only lives `max_ttl` ledgers
past the latest extension. Two paths cover the remaining time:

* **Extend on use.** Every successful `transfer_from` re-extends the entry
  (already true today, now clamped). An allowance in regular use never
  archives.
* **Keeper.** `extend_allowance_ttl(owner, spender, token_id)` is
  permissionless and already exists (issue #185). The backend TTL keeper
  ([`backend/src/services/ttlKeeper.ts`](../../../backend/src/services/ttlKeeper.ts))
  adds the wallet's `TokenAllowance` keys to the entries it watches, and
  calls this function when the remaining TTL drops below `max_ttl / 2`.

Expiries beyond `max_ttl` are **not** rejected. Rejecting them would break
the "approve once for a long session" flow, and the keeper makes them safe.
Expiries within `max_ttl` need no keeper at all.

### 3. Make expiry visible in reads

* `allowance()` keeps returning the stored value unchanged (no breaking
  change to the binding).
* New view: `allowance_status(owner, spender, token_id) -> AllowanceStatus`

  ```rust
  pub struct AllowanceStatus {
      pub amount: i128,           // 0 once expired
      pub expiry_ledger: u32,
      pub expired: bool,          // expiry_ledger < current ledger
      pub live_until_ledger: u32, // storage TTL, 0 if absent
  }
  ```

  Wallet UIs use it instead of comparing ledgers themselves.
  `live_until_ledger` lets the backend tell "about to archive" apart from
  "about to expire".

### 4. Leave expired entries to archive

The contract doesn't delete expired entries. A failed `transfer_from` reverts,
so it can't clean up, and a dedicated cleanup call would cost more than the
rent it saves. Expired entries are inert and archive on their own TTL, like the
legacy `Allowance(owner, spender)` entries (issue #174).

## Behaviour summary

| Situation | Before | After |
|---|---|---|
| `expiry - now <= max_ttl` | Entry lives through expiry | Unchanged |
| `expiry - now > max_ttl`, unused | Host-dependent: trap or archive early | Entry lives `max_ttl`; keeper extends it through expiry |
| `expiry - now > max_ttl`, used regularly | Same as above | Each use re-extends (clamped) |
| Short expiry, entry still readable | `allowance()` shows stale amount | `allowance_status().expired = true`, `amount = 0` |
| Entry archived before expiry | Reads as zero, `InsufficientAllowance` | Should not happen if the keeper runs. If it does, a restore brings back the original allowance |

## Tests (ledger advancement)

Add to `token-wrapper`'s test module. Each test sets `sequence_number` and the
test ledger's `max_entry_ttl` explicitly.

1. **Short expiry**: approve with expiry 100 ledgers ahead. `transfer_from`
   succeeds at `expiry`, fails with `AllowanceExpired` at `expiry + 1`.
   `allowance_status` reports `expired` only from `expiry + 1`.
2. **Expiry past max TTL**: set `max_entry_ttl = 1_000`, approve with expiry
   5_000 ahead. `approve` succeeds (no trap). The entry's TTL is 1_000.
3. **Keeper bridges the gap**: continue from (2). Advance 900 ledgers, call
   `extend_allowance_ttl` (returns `1_000`, not `4_100`). Repeat until past
   expiry. `transfer_from` works at every step up to and including `expiry`.
4. **Use extends**: same as (3), but `transfer_from` is called instead of the
   keeper. The entry stays live.
5. **No keeper, no use**: same as (2), advance past `max_entry_ttl`. Assert the
   entry is archived, not silently read as a zero allowance. Use the
   test-env TTL accessors; the test documents the failure the keeper prevents.
6. **Boundary**: approve at `max_entry_ttl` exactly. The entry's live-until
   equals `expiry_ledger`.

## Docs to update when this lands

* [`contract/README.md`](../../README.md), token-wrapper section: one
  paragraph stating "allowance validity is `expiry_ledger`; storage TTL is
  clamped to the network max and kept alive by use and the keeper".
* Doc comments on `approve`, `transfer_from`, `extend_allowance_ttl`.
* [`contract/docs/events.md`](../events.md) if `allowance_ttl_extended`'s
  payload changes. It shouldn't: it already carries the actual `extend_to`.
* Backend TTL keeper header comment: list `TokenAllowance` among the watched
  keys.
