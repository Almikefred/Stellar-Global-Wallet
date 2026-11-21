# Spend Limits — UX Spec

How users set a daily spend limit per asset, what they see when a send would
exceed it, and when it resets. This is a behaviour spec for the web and mobile
apps; it does not define visuals (see the design file linked from the README).

Source of truth: `set_spend_limit`, `get_spend_limit` and `record_spend` in
[`contract/contracts/globe-wallet/src/lib.rs`](../../contract/contracts/globe-wallet/src/lib.rs).
New to Soroban? Start with the
[smart contracts overview](https://developers.stellar.org/docs/build/smart-contracts/overview).

## Contract behaviour the UI must respect

| Rule | Contract detail |
|---|---|
| Limits are **per asset** | Keyed by `(user, asset_code)`; XLM and USDC limits are independent. |
| Amounts are in the **smallest unit** | `i128` stroops (1 XLM = 10,000,000). The UI converts to and from display units. |
| `0` means **no limit** | `get_spend_limit` returns `0` when unset; setting `0` removes the limit. |
| Window is a **rolling 24 h** | Spends are counted in hourly buckets for 24–25 h after they happen (issue #177). There is no midnight reset, so the limit can't be spent twice around 00:00 UTC. |
| Spends are **always tracked** | `record_spend` records every spend, limit or not (issue #179), so a limit turned on later counts what was already spent. |
| Migration **keeps limits** | `migrate_user_assets` only trims the display list; limits of trimmed assets stay in force (issue #178). |
| Lowering is **retroactive** | `set_spend_limit` fails with `SpendLimitExceeded` if the last 24 h's spend is already above the new limit. |
| A spend is checked **before** fees | `record_spend` is simulated first, so a blocked send costs nothing. |

## Set / edit a limit

```mermaid
stateDiagram-v2
  [*] --> Loading: open asset settings
  Loading --> NoLimit: get_spend_limit = 0
  Loading --> HasLimit: get_spend_limit > 0
  Loading --> LoadError: request failed
  NoLimit --> Editing: "Set daily limit"
  HasLimit --> Editing: "Edit" / "Remove"
  Editing --> Saving: confirm
  Saving --> HasLimit: success, limit > 0
  Saving --> NoLimit: success, limit = 0
  Saving --> Editing: error (show inline message)
```

- **Loading:** skeleton for the limit and "remaining today" rows.
- **No limit (empty):** "No daily limit on {asset}." with a "Set daily limit" action.
- **Has limit:** limit, amount remaining today, and reset time (below).
- **Editing:** numeric input in display units, asset code shown beside it.
  Validate before submitting: must be a number ≥ 0 with no more than the
  asset's decimals (7 for Stellar assets). "Remove limit" submits `0`.
- **Load error:** "Couldn't load your limit." with Retry; do not show `0`,
  which would wrongly read as "no limit".

## Remaining and reset display

- Remaining today = limit − spent today, floored at 0. Read it from
  `GET /api/v1/contract/wallet/{publicKey}/spend-allowance` (all whitelisted
  assets) or `.../spend-allowance/{assetCode}` (one asset), which return
  `limit`, `spent`, `remaining` and `windowResetsAt` straight from the
  contract's `get_spend_allowance` view. It is a simulated read, up to one
  ledger behind; the `record_spend` check is still authoritative.
- `unlimited: true` means no limit is set; `remaining` is then `null`.
  `spent` is still reported, because the contract tracks spends for every
  asset (issue #179).
- The window rolls (issue #177). Each spend sits in an hourly bucket
  (`ledger_timestamp / 3600`) and stops counting 25 buckets later, i.e.
  between 24 h and 25 h after it happened. In any 24 h period the total
  sent never exceeds the limit.
- `nextRefillAt` is when the oldest counted spend rolls off and `remaining`
  next grows (`null` when nothing is counted). `windowResetsAt` is when every
  currently counted spend has rolled off. `windowStartsAt` is the start of the
  oldest bucket still counted. All use **ledger close time**, which can trail
  wall-clock time by a few seconds.
- Reset time: show `nextRefillAt` **converted to the device's time zone**,
  e.g. "More available from 3:00 PM".

## Send blocked by a limit

The send flow calls `POST /api/v1/contract/wallet/spend` before submitting the
payment. Errors arrive in the standard error shape.

| API response | Contract error | UI state and copy |
|---|---|---|
| `422 SOROBAN_SIMULATION_FAILED`, message contains `SpendLimitExceeded (contract error #1007)` | `SpendLimitExceeded` | Block the send. "This would go over your daily {asset} limit. You can send up to {remaining} more now, or wait until {nextRefillAt}." Actions: "Send {remaining}" (if > 0), "Change limit". |
| `422`, `InvalidSpendLimit (#1006)` | amount ≤ 0 | Should not reach the API; client-side "Enter an amount greater than 0". |
| `422`, `SpendOverflow (#10)` | sum overflowed `i128` | "That amount is too large." |
| `502 SOROBAN_TX_FAILED` | submission failed | "The network rejected the transaction. Nothing was sent." with Retry; show the `hash` under "Details". |

When saving a lower limit fails with `SpendLimitExceeded`, the copy is
different: "You've already sent {spent} {asset} today, more than this limit.
Choose at least {spent}, or set it after {reset time}."

## Worked example

A user in Lagos (UTC+1) has a 100 XLM daily limit (`1000000000` stroops).

| Local time | Action | Result | Remaining shown |
|---|---|---|---|
| 09:00 | Send 60 XLM | Allowed | 40 XLM, "Resets at 1:00 AM (00:00 UTC)" |
| 14:00 | Send 50 XLM | `SpendLimitExceeded`; offer "Send 40 XLM" | 40 XLM |
| 15:00 | Lower limit to 50 XLM | `SpendLimitExceeded` (60 already sent) | 40 XLM |
| 01:05 next day | Send 50 XLM | Allowed — new UTC day | 50 XLM |

## Partial failure

If the limit check passes but the payment itself then fails, the spend is
already recorded for today. Show "Payment failed — your daily allowance was
still used" so the remaining amount does not surprise the user.

## API dependencies

- `POST /api/v1/contract/wallet/spend` — the limit check before a send.
- `GET /api/v1/contract/wallet/{publicKey}/spend-allowance[/{assetCode}]` —
  limit, spent, remaining and window bounds (issue #50).

Still missing: an endpoint wrapping `set_spend_limit` (unsigned-XDR builder,
issue #7).
