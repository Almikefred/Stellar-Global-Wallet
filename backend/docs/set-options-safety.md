# setOptions Builder Safety — Preventing Account Lockout

Tracking issue: #249. Status: **proposed**.

## Current state

There is no `setOptions` builder on `main` (`src/services/setOptions.ts` does
not exist). [`StellarService.getAccountThresholds`](../src/services/stellar.ts)
already returns an account's thresholds and signers, which is the input the
simulation below needs. This doc defines the rules any setOptions builder
must enforce before it returns XDR.

## Why

A `setOptions` operation can change the master key weight, add/remove signers
and set low/medium/high thresholds. If the result leaves less signing weight
than the high threshold, nobody can ever sign another setOptions — the account
and its funds are permanently unreachable. Stellar does not stop this.

## Simulate, then decide

Before building, apply the requested change to the account's **current**
state (fetched from Horizon, not client-supplied) to get the resulting config:

```
signers'    = current signers with adds/updates/removals applied
              (weight 0 = removed; master key weight from masterWeight)
thresholds' = current thresholds with low/med/high overrides applied
total'      = sum of weights in signers'
```

When one request contains several setOptions operations, apply them in order
and check the final state, and also each intermediate state (an intermediate
lockout makes the later ops impossible to authorise).

## Rejected configurations (hard errors)

| Code | Rule |
|---|---|
| `SETOPTIONS_THRESHOLD_UNREACHABLE` | Any of `low'`, `med'`, `high'` > `total'`. |
| `SETOPTIONS_NO_SIGNERS` | `total' == 0` (master weight 0 and no other signers). |
| `SETOPTIONS_HIGH_UNREACHABLE_BY_OTHERS` | Removing or zeroing a signer leaves the remaining signers unable to reach `high'`. |
| `SETOPTIONS_INVALID_WEIGHT` | A weight or threshold outside 0–255. |
| `SETOPTIONS_SELF_AS_SIGNER` | Adding the account's own key as an extra signer (use `masterWeight`). |

All return status `422` with `details` containing the simulated config, so the
client can show the user exactly what would have happened:

```json
{
  "error": "High threshold 3 exceeds total signer weight 2",
  "code": "SETOPTIONS_THRESHOLD_UNREACHABLE",
  "details": {
    "thresholds": { "low": 1, "med": 2, "high": 3 },
    "signers": [{ "key": "GA…", "weight": 1 }, { "key": "GB…", "weight": 1 }],
    "totalWeight": 2
  }
}
```

There is no override flag. If a deliberate lock is ever needed (e.g. freezing
an issuing account) that gets its own endpoint with its own review.

## Warnings (allowed, but flagged)

The builder returns the XDR plus `warnings: [{ code, message }]`. Clients must
show them and get an explicit confirmation before signing.

| Code | When |
|---|---|
| `SETOPTIONS_SINGLE_POINT_OF_FAILURE` | One signer alone holds ≥ `high'` and is the only signer with weight — losing that key loses the account. |
| `SETOPTIONS_NO_MARGIN` | `total' == high'`: every signer is required, so losing any one key locks the account. |
| `SETOPTIONS_MASTER_DISABLED` | `masterWeight` set to 0. |
| `SETOPTIONS_LOW_ABOVE_MED` | Thresholds not in `low ≤ med ≤ high` order (valid on-chain but almost always a mistake). |

## Typed errors

Add a `SetOptionsError extends AppError` in `src/errors/` with a
`code: SetOptionsErrorCode` union of the codes above, and export the union so
frontend packages can switch on it exhaustively. Document the codes in
[`openapi-errors.yaml`](openapi-errors.yaml).

## Test plan

Pure-function tests on the simulator (no Horizon), table-driven:

- Raise `high` above total weight → `SETOPTIONS_THRESHOLD_UNREACHABLE`.
- Set master weight 0 with no other signers → `SETOPTIONS_NO_SIGNERS`.
- 2-of-2 account, remove one signer while `high = 2` → rejected.
- Multi-op request whose intermediate state locks out, final state is fine →
  rejected.
- Single signer weight 10, `high = 10` → allowed with
  `SETOPTIONS_SINGLE_POINT_OF_FAILURE`.
- 3 signers weight 1, `high = 3` → allowed with `SETOPTIONS_NO_MARGIN`.
- A normal change (add a signer, keep thresholds reachable) → no errors, no
  warnings.

Plus one route test confirming the simulation uses Horizon state, not a
client-supplied signer list.
