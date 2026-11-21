# globe-wallet: batched multi-send with atomic limits (issue #245)

Status: proposed. Source: `send` and `record_spend` in
[`contracts/globe-wallet/src/lib.rs`](../../contracts/globe-wallet/src/lib.rs).

## Problem

`send` moves one amount to one recipient. Payroll, bill splitting and
remittance fan-out need N transactions today. That means N signatures, N fees,
and no atomicity: if transfer 7 of 10 fails, the first six have already
settled.

## API

```rust
#[contracttype]
pub struct BatchTransfer {
    pub to: Address,
    pub amount: i128,
}

/// Send `token_id` to every recipient in `transfers`, all-or-nothing.
pub fn send_batch(
    env: Env,
    user: Address,
    token_id: Address,
    transfers: Vec<BatchTransfer>,
) -> Result<(), WalletError>;

pub const MAX_BATCH_SIZE: u32 = /* set from budget measurement, see below */;
```

**One token per batch.** Mixed-token batches would need per-token limit
accounting and per-token allowance checks in one call, for little gain. A
client that pays in two tokens submits two batches. A multi-token variant can
be added later without changing this one.

## Semantics

Checks run in the same order as `send`, so a batch behaves like N `send`s that
succeed or fail together:

1. `is_send_paused` → `SendsPaused`; `is_paused` → `ContractPaused`.
2. `token_id` allowlisted → else `TokenNotAllowed`.
3. Validate the batch **before** any state change:
   * `transfers.len() == 0` → `BatchEmpty`
   * `transfers.len() > MAX_BATCH_SIZE` → `BatchTooLarge`
   * any `amount <= 0` → `InvalidSpendLimit` (same code `record_spend` uses)
   * `total = Σ amount` with `checked_add` → `SpendOverflow` on overflow
4. `user.require_auth()`, **once**.
5. **Limit accounting, once, for `total`.** One spend-window update for the
   whole batch, so the check is "last 24 h + total ≤ limit". A batch that
   would cross the limit fails with `SpendLimitExceeded` and records nothing.
6. For each transfer, `token-wrapper::transfer_from(self, token_id, user, to,
   amount)`. Any failure → `TokenTransferFailed`, and the whole invocation
   reverts, including step 5.
7. Events (see below).

### Why `record_spend` can't be called in a loop

`record_spend` calls `user.require_auth()`. As the comment in `send` notes, a
second `require_auth` for the same address in the same frame fails. Batching
therefore needs `record_spend`'s body split out:

```rust
fn record_spend_unchecked(env: &Env, user: &Address, token_id: &Address, amount: i128)
    -> Result<i128 /* new window total */, WalletError>;

pub fn record_spend(env, user, token_id, amount) -> Result<(), WalletError> {
    user.require_auth();
    if amount <= 0 { return Err(WalletError::InvalidSpendLimit); }
    Self::record_spend_unchecked(&env, &user, &token_id, amount).map(|_| ())
}
```

`send` and `send_batch` call `require_auth` themselves and then the unchecked
helper. The helper still contains no external call between reading and writing
`SpendWindow`, so the reentrancy proof in
[`record-spend-reentrancy.md`](../record-spend-reentrancy.md) still holds.
Update that doc to name the helper.

### Allowance

The user's token-wrapper allowance for `(user, wallet, token_id)` is debited
once per transfer, so it must cover `total`. If it doesn't, the transfer that
runs out fails and the batch reverts. Clients should check
`allowance >= total` before submitting, the same way they pre-check the spend
limit.

### Auth tree

The user signs one tree rooted at `send_batch` with N nested
`token.transfer(user, to_i, amount_i)` sub-invocations, one per recipient.
Clients build it from simulation, as they do for `send`. Auth entry size grows
with N, which is one of the reasons `MAX_BATCH_SIZE` exists.

## Resource limits

Each transfer costs one cross-contract call into token-wrapper, which makes one
into the token, plus one allowance read/write and the token balance entries.
Footprint and CPU grow linearly with N, and the transaction has to fit within
the network's per-transaction limits (read/write entries, instructions, tx
size).

Set `MAX_BATCH_SIZE` from measurement, not by guessing:

1. Add a `bench_send_batch_*` case to
   [`tests/budgets.rs`](../../contracts/globe-wallet/tests/budgets.rs) for N =
   1, 5, 10, 20, 40 with distinct recipients and a SAC token.
2. Pick the largest N whose CPU, memory **and** footprint entry count stay
   under ~60% of the current Mainnet per-transaction limits. The headroom
   covers custom-account `__check_auth` cost and future protocol changes.
3. Record the chosen N and the measurements in
   [`budgets/baseline.json`](../../contracts/globe-wallet/budgets/baseline.json)
   so a regression shows up in CI.

Expect a value in the low tens. Repeated recipients are allowed and add no
footprint, since they hit the same balance entry.

## Events

* One `send_executed` per transfer, with exactly the payload `send` emits
  today (`SendExecutedEvent { user, token_id, to, amount }`). Indexers and the
  activity feed then need no changes to see batch payments.
* One `spend_recorded` for the batch total, as the one window update.
* One summary `batch_executed(user, token_id, count, total)`, emitted last.

All events use the versioned `(name, EVENT_VERSION)` topics. Adding
`batch_executed` is additive, so `EVENT_VERSION` stays `1`. Add it to
[`events.md`](../events.md).

## Errors

Two new `WalletError` variants, appended at the next free codes after 1050:

| Variant | Meaning |
|---|---|
| `BatchEmpty` | `transfers` is empty |
| `BatchTooLarge` | `transfers.len() > MAX_BATCH_SIZE` |

Update `error-codes.snapshot.json`, [`errors.md`](../errors.md) and the
backend's contract-error mapping. Coordinate code numbers with #246, which
also adds variants.

## Tests

1. **Happy path**: 3 recipients. Balances, allowance and spend window all
   reflect the total. 3 × `send_executed` + 1 `batch_executed`.
2. **Batch exceeding limit fails atomically** (the acceptance test): limit
   1_000, batch [400, 400, 400]. Result `SpendLimitExceeded`. No balance
   changed, `get_spent_today` unchanged, no `send_executed` emitted.
3. **Fits only as a whole**: limit 1_000, 300 already spent, batch [300, 300]
   succeeds, then batch [300, 200] fails.
4. **Late transfer failure reverts everything**: the allowance covers only
   the first two of three transfers. `TokenTransferFailed`, nothing moved,
   spend window unchanged.
5. Validation: empty → `BatchEmpty`; `MAX_BATCH_SIZE + 1` → `BatchTooLarge`;
   a zero or negative amount → `InvalidSpendLimit`; overflow →
   `SpendOverflow`; non-allowlisted token, paused, sends-paused.
6. **Single `require_auth`**: with `mock_all_auths`, assert
   `env.auths()` has one root invocation for `user` covering `send_batch`.
7. **Budget**: `MAX_BATCH_SIZE` recipients fits the budget test's limits.

## Client / backend

* SDK: `sendBatch(tokenId, transfers)` pre-checks size, positive amounts,
  `total <= remaining` (from `get_spend_allowance`) and
  `total <= allowance`, then simulates.
* Backend: the transaction-submission path accepts the new function name.
  Activity history needs nothing new because it is built from per-transfer
  events.

## Docs to update when this lands

* [`contract/README.md`](../../README.md): add `send_batch` to the function
  list, plus one line under "Spend Limit Logic": "a batch is charged as one
  spend of its total".
* [`docs/specs/spend-limits.md`](../../../docs/specs/spend-limits.md): the
  "would exceed" message for a batch shows the batch total.
