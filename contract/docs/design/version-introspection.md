# globe-wallet: version and feature introspection (issue #247)

Status: proposed. Source: [`contracts/globe-wallet/src/lib.rs`](../../contracts/globe-wallet/src/lib.rs).

## Problem

A client can't ask a deployed contract what it is. The contract is upgradeable
(`propose_upgrade` / `execute_upgrade`), so the WASM behind a contract ID
changes over time, and features such as `send_batch` (#245) or payment
intents (#246) may or may not be present. Today clients find out by calling a
function and getting a host error.

Version signals that exist today, none of which answers "what can I call?":

* `EVENT_VERSION` (event schema, issue #192)
* `storage_layout()` (storage schema, issue #184)
* the backend's `X-API-Version` (HTTP API, see
  [`backend/docs/versioning.md`](../../../backend/docs/versioning.md))

## Design

### 1. On-chain views

```rust
#[contracttype]
pub struct ContractVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

/// Interface version of this WASM. Constant, does not read storage.
pub fn version(env: Env) -> ContractVersion;

/// Optional capabilities present in this WASM, as stable short names.
pub fn features(env: Env) -> Vec<Symbol>;
```

**Version semantics** follow the interface clients depend on, not the crate:

| Bump | When |
|---|---|
| `major` | A breaking interface change: a removed or renamed function, changed argument or return types, an error code whose meaning changes, an event payload that changes (which also bumps `EVENT_VERSION`). |
| `minor` | Additive changes: new function, new error code, new event, new feature flag. |
| `patch` | Behaviour-preserving fixes. |

The starting value is `1.0.0` for the first WASM that has `version()`. Its
absence means "pre-introspection". Clients treat a contract without
`version()` as `0.x` (see SDK rules).

**Feature names** are short `Symbol`s, append-only, and never reused with a
different meaning:

| Feature | Present when |
|---|---|
| `spend_window` | Rolling 24 h limits (#177) |
| `roles` | `grant_role`/`revoke_role` (#190) |
| `send_pause` | `pause_sends` (#191) |
| `send_batch` | #245 lands |
| `intents` | #246 lands |
| `alw_status` | token-wrapper `allowance_status` is wired up (#244) |

`features()` lists what **this WASM** supports. Runtime state (paused or not,
storage layout) stays with its existing views. Both views are constants, so
their cost is negligible and they need no TTL bump.

Source of truth: one `const CONTRACT_VERSION` and one `const FEATURES:
&[&str]` near the top of `lib.rs`. A unit test asserts that the crate version
in `Cargo.toml` and `CONTRACT_VERSION` agree, so the two can't drift.

### 2. Contract meta in the WASM (SEP-46 style)

The same information is embedded in the WASM's `contractmetav0` custom section,
so tools can read it from the installed code without invoking the contract:

```rust
soroban_sdk::contractmeta!(key = "gw_version", val = "1.0.0");
soroban_sdk::contractmeta!(key = "gw_features", val = "spend_window,roles,send_pause");
soroban_sdk::contractmeta!(key = "source_repo", val = "github.com/Genghis-codes/Stellar-Global-Wallet");
```

* Meta keys are namespaced (`gw_`) to avoid colliding with keys the SDK or
  build tooling adds (for example `rsver`, `rssdkver`).
* A build-time test (or a `contract/scripts/` check run in CI) reads the meta
  from the built WASM, with `stellar contract info meta` or by parsing the
  custom section, and asserts it equals `version()`/`features()` from the
  same build. This test is what keeps the two from disagreeing.
* Meta answers "what is installed at this wasm hash" (useful before
  `execute_upgrade`). The views answer "what is live at this contract ID"
  through simulation. Clients use the views; ops tooling uses either.

### 3. Backend

Extend `GET /api/v1/contract/status`
([`backend/src/routes/contract.ts`](../../../backend/src/routes/contract.ts))
with:

```json
{
  "contract": {
    "version": "1.2.0",
    "features": ["spend_window", "roles", "send_pause", "send_batch"],
    "wasmHash": "…"
  }
}
```

* Read through simulated `version()`/`features()` (read-only, no fee).
  Cache until an `upgraded` event is seen, or for 5 minutes, whichever comes
  first.
* A contract without `version()` (simulation fails with a missing-function
  error) is reported as `"version": "0.0.0"` and `"features": []`, not as a
  500.
* Add the fields to the OpenAPI schema. This is an additive change, so it
  stays in `/api/v1`.

### 4. SDK compatibility check

The SDK declares the range it was built against, next to the generated
bindings:

```ts
export const SUPPORTED_CONTRACT = { major: 1, minMinor: 0 };
```

On client init (lazily, on the first contract call, cached per contract ID):

1. Read the version (via the backend status endpoint, or by simulating
   `version()` directly when the SDK is used without the backend).
2. **Refuse** if `major !== SUPPORTED_CONTRACT.major`, or if `minor <
   minMinor`. Throw `IncompatibleContractError { found, supported }` before
   building any transaction.
3. Pre-introspection contracts (`0.0.0`) are refused by default. An explicit
   `allowUnversionedContract: true` opt-in covers existing deployments
   during the rollout.
4. Feature-gated methods (`sendBatch`, intent methods) check
   `features.includes(name)` and throw `UnsupportedFeatureError` instead of
   letting the call fail on-chain.

A higher `minor` than the SDK knows is accepted: additive changes don't break
an older client.

## Tests

Contract:

1. `version()` equals `CONTRACT_VERSION` and matches `Cargo.toml`.
2. `features()` contains every name in the table for the features this build
   includes, with no duplicates.
3. The WASM meta check (CI script) matches the views.

Backend:

4. `/contract/status` returns version and features. For an unversioned
   contract it returns `0.0.0` and `[]`, and the response is a 200.

SDK (the acceptance test, "SDK refuses incompatible contract versions"):

5. Contract `2.0.0` with SDK `major: 1` → `IncompatibleContractError`, and no
   RPC submission is attempted.
6. Contract `1.0.0` with SDK `minMinor: 1` → refused. Contract `1.5.0` with
   `minMinor: 1` → accepted.
7. Unversioned contract → refused unless `allowUnversionedContract`.
8. `sendBatch` against a contract without `send_batch` →
   `UnsupportedFeatureError`.

## Release process

Add to [`contract/CONTRIBUTING.md`](../../CONTRIBUTING.md): every PR that
changes the public interface bumps `CONTRACT_VERSION` per the table above,
and appends to `FEATURES` when it adds an optional capability. The
error-codes snapshot test already catches renumbered errors. Reviewers check
that the version bump matches the change.

## Docs to update when this lands

* [`contract/README.md`](../../README.md): `version()` / `features()` in the
  function list, and the feature-name table.
* [`backend/docs/versioning.md`](../../../backend/docs/versioning.md): a
  short section on how the contract version relates to the API version
  (independent; the API reports the contract's version).
* [`packages/sdk/README.md`](../../../packages/sdk/README.md): compatibility
  errors and the opt-in flag.
