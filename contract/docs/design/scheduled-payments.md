# globe-wallet: scheduled and recurring payments (issue #246)

Status: proposed. Source: [`contracts/globe-wallet/src/lib.rs`](../../contracts/globe-wallet/src/lib.rs).

## Problem

Every payment needs the owner online to sign it. Subscriptions, rent and
remittance schedules need a payment to happen on time without the owner
signing each one, while staying within caps the owner set in advance.

## Model

The owner signs a **payment intent** once. The contract stores it. After that,
anyone (a **keeper**) may call `execute_intent` when a payment is due. The
contract enforces every rule, so the keeper has no discretion: it can only
make a payment that is due, at the amount fixed in the intent, to the fixed
recipient.

```rust
#[contracttype]
pub struct PaymentIntent {
    pub owner: Address,
    pub token_id: Address,
    pub to: Address,
    pub amount: i128,          // per run, smallest unit
    pub interval_secs: u64,    // >= MIN_INTENT_INTERVAL_SECS
    pub next_run_at: u64,      // ledger timestamp of the next due run
    pub runs_left: u32,        // 0 = no run-count cap
    pub max_total: i128,       // lifetime cap incl. keeper fees; > 0
    pub spent_total: i128,
    pub keeper_fee: i128,      // per run, paid to the executing keeper
    pub grace_secs: u64,       // how late a run may still execute
}

pub fn create_intent(env, owner, token_id, to, amount, interval_secs,
                     first_run_at, runs_left, max_total, keeper_fee, grace_secs)
    -> Result<u64 /* intent_id */, WalletError>;
pub fn cancel_intent(env, owner, intent_id) -> Result<(), WalletError>;
pub fn execute_intent(env, keeper, intent_id) -> Result<(), WalletError>;
pub fn intent(env, intent_id) -> Option<PaymentIntent>;
pub fn intents_of(env, owner) -> Vec<u64>;
```

"Signed" means `create_intent` requires `owner.require_auth()`. The stored
intent is the owner's signed authorization. No off-chain signature is replayed
later.

## The authorization problem, and the chosen fix

`send` works because the owner signs each call: token-wrapper is bookkeeping
only, and the token's `transfer(owner, ..)` still needs the owner's auth (see
the token-wrapper module doc, issue #174). A keeper can't produce that
signature, so `execute_intent` can't go through `send`'s path.

Options considered:

| Option | Verdict |
|---|---|
| **A. Native SAC allowance.** The owner calls `token.approve(owner, globe_wallet, cap, expiration_ledger)` on the token itself. `execute_intent` calls `token.transfer_from(globe_wallet, owner, to, amount)`, and the wallet contract authorizes itself as the direct caller. | **Chosen.** No custody, standard token interface, and the owner can revoke at the token level as a backstop. |
| B. Escrow. The owner deposits into the wallet contract, which pays from its own balance. | Rejected: custody, more attack surface, and funds are locked up. |
| C. Smart-account policy. The owner's account contract `__check_auth` allows `execute_intent`. | Later option for passkey/smart accounts. Doesn't work for classic G-accounts. |

So creating an intent is a two-step client flow, ideally in one transaction:

1. `token.approve(owner, wallet_contract, max_total - spent_total, expiration_ledger)`
2. `globe_wallet.create_intent(...)`

The SAC allowance expiry has the same archival/max-TTL constraints as
token-wrapper allowances. See
[`allowance-expiry-and-ttl.md`](allowance-expiry-and-ttl.md). The client sets
`expiration_ledger` to cover the intent's last expected run, within the network
max, and re-approves when a long-running intent nears it. `intent_status`
(below) reports the gap so the app can prompt the owner.

## `execute_intent` rules

In order, with no state change before step 6:

1. `keeper.require_auth()` (so the fee goes to whoever signs).
2. `is_send_paused` / `is_paused` → `SendsPaused` / `ContractPaused`. Pause
   covers intents too.
3. Intent exists → else `IntentNotFound`. Token still allowlisted → else
   `TokenNotAllowed`.
4. `now >= next_run_at` → else `IntentNotDue`.
5. `now <= next_run_at + grace_secs`. If not, the run is **missed**: advance
   `next_run_at` past `now` in `interval_secs` steps, emit `intent_missed`,
   and return `Ok` with no payment. This is the only state change a late
   keeper can cause. Missed runs are never paid in bulk.
6. Cap: `spent_total + amount + keeper_fee <= max_total`, else
   `IntentCapReached`. The run-count cap needs no check here: an intent
   whose last run executed is deleted in step 9.
7. **Spend limit**: charge `amount + keeper_fee` to the owner's rolling window
   through the same `record_spend_unchecked` helper `send_batch` introduces
   (#245). Over the limit → `SpendLimitExceeded`, and the run stays due, so a
   keeper can retry once the window refills, until grace runs out. The keeper
   fee counts against the limit because it leaves the owner's balance.
8. Interactions, last: `token.transfer_from(self, owner, to, amount)` then
   `token.transfer_from(self, owner, keeper, keeper_fee)` if the fee is
   non-zero. Either fails → `TokenTransferFailed`, full revert.
9. Update: `spent_total += amount + keeper_fee`, `next_run_at +=
   interval_secs` (anchored to the schedule, not to execution time, so late
   execution doesn't drift the schedule), decrement `runs_left`. When the
   intent is exhausted, delete it and emit `intent_completed`.

The reentrancy reasoning matches `send`: all of globe-wallet's own writes for
the spend window happen before the external token calls, and normal Soroban
calls prohibit re-entry. Step 9 writes the intent after the call. That is safe
under prohibited re-entry, but the implementation PR should either move it
before step 8 (preferred, the transaction reverts anyway on failure) or extend
the threat model doc.

## Cancellation

* `cancel_intent(owner, intent_id)`: owner auth. Deletes the intent and emits
  `intent_cancelled`. A cancelled intent can never execute, because
  `execute_intent` finds nothing.
* Guardians can't cancel. Intents are the owner's spending decision, unlike
  limit increases, which guardians can veto (issue #176).
* The owner can also revoke the SAC allowance directly (`approve(.., 0, ..)`).
  The intent then fails at step 8 until it is cancelled or re-approved.

## Validation on create

* `amount > 0`, `keeper_fee >= 0`, `max_total >= amount + keeper_fee`.
* `interval_secs >= MIN_INTENT_INTERVAL_SECS` (proposal: 3_600, the
  spend-window bucket size).
* `keeper_fee <= amount / 10`, capped as a fraction so a misconfigured client
  can't set a fee that dwarfs the payment.
* `first_run_at >= now`. `grace_secs <= interval_secs`.
* Token allowlisted. Owner has fewer than `MAX_INTENTS_PER_OWNER` (proposal:
  20, bounded like `MAX_ASSETS` so `intents_of` stays cheap).
* Any failure → `InvalidIntent`.

## Storage and TTL

| Key | Storage | Value |
|---|---|---|
| `IntentCounter` | instance | `u64`, next id |
| `Intent(u64)` | persistent | `PaymentIntent` |
| `OwnerIntents(Address)` | persistent | `Vec<u64>` (≤ `MAX_INTENTS_PER_OWNER`) |

Keys are appended to `DataKey`, never reordered. Every write extends with the
existing `PERSISTENT_TTL_THRESHOLD` / `PERSISTENT_TTL_EXTEND_TO`, and so does
each execution. `extend_user_ttl` additionally extends the owner's intent
entries, so the existing TTL keeper covers intents whose interval is longer
than the persistent threshold.

## Keepers

* Execution is permissionless. Any account can run a keeper. The fee covers
  the network fee plus a small margin.
* The backend runs a reference keeper next to the TTL keeper
  ([`ttlKeeper.ts`](../../../backend/src/services/ttlKeeper.ts)). Each sweep
  lists due intents (indexed from `intent_created`/`intent_executed` events),
  simulates `execute_intent`, and submits only when simulation succeeds, so
  `IntentNotDue` and `SpendLimitExceeded` cost nothing.
* Competing keepers racing for the same run: the first one wins, and the
  others fail `IntentNotDue` in simulation. Nobody can be paid twice for one
  run.

## Events

`intent_created(owner, intent_id, token_id, to, amount, interval_secs,
next_run_at)`, `intent_executed(intent_id, keeper, amount, keeper_fee,
next_run_at)`, `intent_missed(intent_id, next_run_at)`,
`intent_cancelled(owner, intent_id)`, `intent_completed(owner, intent_id)`.
All of them are additive under `EVENT_VERSION = 1`. Add them to
[`events.md`](../events.md).

## Errors

New `WalletError` variants at the next free codes (coordinate with #245):
`InvalidIntent`, `IntentNotFound`, `IntentNotDue`, `IntentCapReached`,
`TooManyIntents`. Update `error-codes.snapshot.json`,
[`errors.md`](../errors.md) and the backend's error mapping.

## Tests

1. **Keeper executes on schedule** (acceptance): create with `first_run_at =
   T`. At `T - 1`, `IntentNotDue`. At `T`, the payment lands, the keeper gets
   the fee, and `next_run_at = T + interval`.
2. **Cancelled intent not executed** (acceptance): create, cancel, advance
   past `next_run_at`, then `execute_intent` returns `IntentNotFound` and no
   balance changes.
3. Caps: with `runs_left = 2`, the intent is deleted after run 2 and
   `intent_completed` is emitted. A third call returns `IntentNotFound`.
   With `max_total`, the run that would exceed it fails with
   `IntentCapReached`.
4. Spend limit: a limit below `amount + fee` gives `SpendLimitExceeded`, and
   the run stays due. After the window refills, the retry within grace
   succeeds.
5. Missed run: execute at `next_run_at + grace + 1`. No payment, schedule
   advanced, `intent_missed` emitted.
6. Late but within grace: the schedule stays anchored (`next_run_at` advances
   by exactly `interval`).
7. Paused / sends-paused / de-allowlisted token block execution.
8. SAC allowance revoked → `TokenTransferFailed`, intent state unchanged.
9. Double execution in one ledger: the second call gives `IntentNotDue`.
10. Validation matrix for `create_intent`, and `MAX_INTENTS_PER_OWNER + 1`
    gives `TooManyIntents`.

## Out of scope

* Variable-amount pulls (merchant-set amounts). The amount is fixed per
  intent.
* Cross-token or path payments.
* Calendar schedules (the "1st of the month" kind). The interval is a fixed
  number of seconds. Clients approximate calendar schedules, or recreate the
  intent.

## Docs to update when this lands

* [`contract/README.md`](../../README.md): function list, plus a "Recurring
  payments" section summarising the model and the SAC-approve step.
* [`docs/specs/spend-limits.md`](../../../docs/specs/spend-limits.md):
  scheduled payments and keeper fees count against the limit.
* [`architecture.md`](architecture.md): the SAC-native allowance path next to
  the token-wrapper path.
