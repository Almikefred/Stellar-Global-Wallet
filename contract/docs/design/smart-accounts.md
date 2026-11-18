# Per-user smart wallets and session keys (issues #180, #182)

## Why

`globe-wallet` is one shared contract with one `Admin`. Guardians rotate that
admin. End users are plain `G...` addresses with spend-limit *bookkeeping*,
so a user who loses a key cannot recover, and limits are only advisory.
Recovery and limits only protect a user when the user's address is a
contract whose `__check_auth` the wallet controls.

## Contracts

* **`contracts/smart-account`**: Soroban custom account, one per user.
  * Signers: ed25519 keys, M-of-N `threshold`, verified with the host
    `ed25519_verify`. Signatures must be sorted by key with no duplicates.
  * Spend policy *inside* `__check_auth`: every `transfer` / `approve` /
    `burn` context on a token where `from == account` counts against that
    token's daily cap (UTC day). Tightening a cap is immediate. Raising or
    removing one is queued for `LIMIT_INCREASE_DELAY` (24 h), so a stolen key
    cannot lift the cap and drain the wallet in one transaction.
  * Recovery: guardians (any address, including other smart accounts) run
    `initiate_recovery` → `approve_recovery` → wait `delay_seconds` (≥ 24 h) →
    `execute_recovery` (anyone). That replaces **all** signers with the new
    key, resets threshold to 1 and revokes every session key. The account
    can `cancel_recovery` while it still holds a key.
  * Session keys (#182): `SessionKey { public_key, allowed_contracts,
    allowed_fns, token_caps, expires_at }`. In `__check_auth` a session
    signature must be the only signature. Every context must be a contract
    call, never the account itself, inside the allow-lists. Each token
    movement must fit the key's lifetime cap (`SessionSpent`). Tokens not in
    `token_caps` cannot be moved. The account daily cap still applies on
    top. Expiry is at most 30 days. `revoke_session_key` / `session_keys` /
    `session_spent` cover revocation and listing.
  * Upgrade policy per wallet: `upgrade(hash)` needs account auth and, for
    factory-deployed accounts, `factory.is_wasm_approved(hash)`.
* **`contracts/account-factory`**: `create_account(user_id, signer)`
  deploys at `deployed_address(salt = sha256(user_id))` and calls `init` in
  the same transaction, so `init` cannot be front-run. It is admin-gated,
  otherwise anyone could squat a victim's deterministic address.
  `account_address(user_id)` predicts the address. It also holds the
  approved-WASM list.
* **`globe-wallet`** keeps the shared allowlist/config role (allowed tokens,
  token-wrapper, asset metadata). Its admin recovery is unchanged.

## Threat model

| Threat | Mitigation |
|---|---|
| Root key stolen | daily caps in `__check_auth`; raising caps is timelocked; guardians recover |
| Root key lost | guardian M-of-N + timelock replaces signers |
| Malicious guardians | timelock ≥ 24 h, account can cancel; guardian removal drops their approval |
| Session key stolen | scoped contracts/fns, lifetime caps, expiry ≤ 30 d, revocable, cannot touch the account |
| Signature replay / duplicate signer | host-provided payload includes nonce; sorted unique signatures |
| Address squatting | factory creation admin-gated; deterministic salt |
| Malicious upgrade | upgrade needs account auth + factory approval |

## Failure modes

* Unrecognised token interfaces (non-SEP-41 spend functions) are not
  metered by caps. Session keys can still be blocked from them with
  `allowed_fns`.
* Caps are per token contract, in the token's smallest unit.
* If every guardian is lost as well as every key, funds are unrecoverable.

## Migration for existing users

1. Backend computes `account_address(user_id)` and calls `create_account`
   with the user's current ed25519 key as root signer.
2. Per tracked asset: copy the user's `globe-wallet` `SpendLimit(user, code)`
   to `smart-account.set_spend_limit(token, limit)`. A first limit is
   immediate. Then transfer the balances to the new address.
3. Guardians are invited to the account (`add_guardian`) and
   `set_recovery_config` is set. `globe-wallet` per-user entries can then
   be removed with `remove_asset`.

## Backend

Deferred to a follow-up PR. That PR adds a backend helper to predict
`account_address`, validate and encode session-key records, and sign Soroban
auth entries for contract-account credentials, plus the matching
`packages/sdk` validators and OpenAPI routes.

## Deferred (tracked follow-ups)

* Passkey (secp256r1 / WebAuthn) signers. The data model is ready
  (`Signature` can gain a variant), but WebAuthn client-data parsing is
  out of scope here.
* Backend/SDK support and HTTP routes for creating accounts and session
  keys. These need a factory deployment and config.
* Local-quickstart end-to-end run. The unit tests cover the same flow
  (create, set limit, lose key, recover, send within limit).
