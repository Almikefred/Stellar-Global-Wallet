import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




/**
 * Delegable privileges. The admin implicitly holds every role; anyone else
 * must be granted a role explicitly via `grant_role`. Each role only
 * unlocks its own functions — an `AllowlistManager` cannot upgrade the
 * contract, an `Upgrader` cannot pause it, and so on. The admin itself is
 * expected to be a Stellar multisig account (see `docs/governance.md`), so
 * no single key controls a critical function.
 * 
 * Discriminants are explicit and stable: they are part of storage keys and
 * event payloads.
 */
export enum Role {
  Upgrader = 1,
  AllowlistManager = 2,
  Pauser = 3,
}

export type DataKey = {tag: "Admin", values: void} | {tag: "PendingAdmin", values: readonly [string]} | {tag: "PendingUpgrade", values: void} | {tag: "UserAssets", values: readonly [string]} | {tag: "SpendLimit", values: readonly [string, string]} | {tag: "DailySpent", values: readonly [string, string]} | {tag: "Guardians", values: void} | {tag: "RecoveryConfig", values: void} | {tag: "RecoveryProposal", values: void} | {tag: "GuardianMembership", values: void} | {tag: "TokenWrapperId", values: void} | {tag: "AllowedToken", values: readonly [string]} | {tag: "AllowedTokens", values: void} | {tag: "AllowedTokenInfo", values: readonly [string]} | {tag: "PendingAllowedToken", values: readonly [string]} | {tag: "RoleMember", values: readonly [Role, string]} | {tag: "Paused", values: void} | {tag: "Pauser", values: void} | {tag: "SendsPaused", values: void} | {tag: "LimitOptIn", values: readonly [string, string]} | {tag: "SpendWindow", values: readonly [string, string]} | {tag: "TokenSpendLimit", values: readonly [string, string]} | {tag: "TokenDailySpent", values: readonly [string, string]} | {tag: "PendingSpendLimit", values: readonly [string, string]} | {tag: "PendingGuardianChange", values: void} | {tag: "GuardianSet", values: void} | {tag: "GuardianFlag", values: readonly [string]} | {tag: "PendingRecovery", values: void} | {tag: "StorageLayout", values: void};


export interface AssetInfo {
  /**
 * e.g. "XLM", "USDC"
 * 
 * **Canonicalization decision (issue #29):** `code` must be non-empty
 * and at most [`GlobeWallet::MAX_ASSET_CODE_LEN`] bytes — enforced by
 * [`GlobeWallet::add_asset`]. Storage preserves the caller's original
 * casing, but duplicate detection in `add_asset` treats codes as equal
 * case-insensitively (ASCII), so `"USDC"` and `"usdc"` are considered
 * the same asset and cannot both be registered for one user.
 */
code: string;
  /**
 * Issuer address; None for XLM (native)
 */
issuer: Option<string>;
}

/**
 * Verified Stellar Asset Contract identity stored with each allowlisted
 * token (issue #189). `issuer_key` is the raw ed25519 issuer public key,
 * `None` for native XLM.
 * Issuer of an allowlisted Stellar asset. A plain `Option<BytesN<32>>`
 * field does not convert to `ScVal` under soroban-sdk 21 testutils, so the
 * "no issuer" case (native XLM) is spelled out instead.
 */
export type IssuerKey = {tag: "Native", values: void} | {tag: "Key", values: readonly [Buffer]};


export interface SpendRecord {
  amount: i128;
  /**
 * Ledger-time timestamp of the current day window
 */
day: u64;
}


/**
 * Rolling spend window for one (user, asset) pair (issue #177).
 * 
 * O(1) storage: a fixed ring of [`SPEND_WINDOW_BUCKETS`] hourly totals.
 * Slot `h % SPEND_WINDOW_BUCKETS` holds the amount spent during hour `h`
 * (`h = ledger_timestamp / 3600`). Buckets older than
 * `head_hour - (SPEND_WINDOW_BUCKETS - 1)` are zeroed as the head moves.
 */
export interface SpendWindow {
  /**
 * Exactly `SPEND_WINDOW_BUCKETS` per-hour totals.
 */
buckets: Array<i128>;
  /**
 * Hour index of the newest bucket this ring has been advanced to.
 */
head_hour: u64;
}

export const WalletError = {
  1001: {message:"AlreadyInitialized"},
  1002: {message:"NotInitialized"},
  1003: {message:"Unauthorized"},
  1004: {message:"AssetAlreadyAdded"},
  1005: {message:"AssetNotFound"},
  1006: {message:"InvalidSpendLimit"},
  /**
   * Payment would exceed the daily spend limit for this asset
   */
  1007: {message:"SpendLimitExceeded"},
  1008: {message:"NoAssetsProvided"},
  1009: {message:"NoPendingAdmin"},
  1010: {message:"SpendOverflow"},
  1011: {message:"AssetLimitExceeded"},
  1012: {message:"MaxAssetsReached"},
  1013: {message:"UpgradeAlreadyPending"},
  1014: {message:"UpgradeNotPending"},
  1015: {message:"UpgradeHashMismatch"},
  1016: {message:"UpgradeNotReady"},
  1017: {message:"UpgradeFailed"},
  /**
   * Guardian address already registered.
   */
  1018: {message:"GuardianAlreadyAdded"},
  /**
   * Address is not a registered guardian.
   */
  1019: {message:"GuardianNotFound"},
  /**
   * Recovery threshold must be `1 < threshold <= guardians.len()`.
   */
  1020: {message:"InvalidRecoveryThreshold"},
  /**
   * `add_guardian`/`set_recovery_config` would leave threshold >
   * guardian count, or guardians.len() below the required minimum.
   */
  1021: {message:"NotEnoughGuardians"},
  /**
   * No recovery threshold/delay configured yet — call `set_recovery_config` first.
   */
  1022: {message:"RecoveryNotConfigured"},
  /**
   * A recovery proposal is already in flight; cancel or execute it first.
   */
  1023: {message:"RecoveryAlreadyPending"},
  /**
   * No recovery proposal is currently pending.
   */
  1024: {message:"NoPendingRecovery"},
  /**
   * Guardian has already approved the pending proposal.
   */
  1025: {message:"AlreadyApproved"},
  /**
   * Guardian has not approved the pending proposal (nothing to revoke).
   */
  1026: {message:"ApprovalNotFound"},
  /**
   * Quorum reached but the timelock delay has not yet elapsed.
   */
  1027: {message:"RecoveryNotReady"},
  /**
   * Approvals dropped below threshold since quorum was reached; timelock reset.
   */
  1028: {message:"RecoveryNotQuorate"},
  /**
   * Asset code and issuer configuration is invalid
   */
  1029: {message:"InvalidAssetInfo"},
  /**
   * Proposed wasm hash is not registered on-chain (never uploaded via upload_contract_wasm)
   */
  1030: {message:"UpgradeWasmNotUploaded"},
  /**
   * `add_guardian` would exceed [`GlobeWallet::MAX_GUARDIANS`].
   */
  1031: {message:"GuardianLimitExceeded"},
  /**
   * `execute_recovery`'s proposal targets the same address that is
   * already the current admin — recovering "to" a no-op target is
   * rejected rather than silently succeeding as a wasted transfer.
   */
  1032: {message:"RecoveryNewAdminUnchanged"},
  /**
   * `AssetInfo.code` is empty or exceeds `GlobeWallet::MAX_ASSET_CODE_LEN`.
   */
  1033: {message:"InvalidAssetCode"},
  /**
   * `send`'s `token_id` is not on the admin-curated allowlist. See
   * docs/design/wiring-reentrancy-threat-model.md §4.
   */
  1034: {message:"TokenNotAllowed"},
  /**
   * `send` was called before an admin configured the token-wrapper
   * contract instance via `set_token_wrapper`.
   */
  1035: {message:"TokenWrapperNotSet"},
  /**
   * The `token-wrapper::transfer_from` call `send` makes failed (e.g.
   * insufficient/expired allowance) or could not be invoked at all.
   */
  1036: {message:"TokenTransferFailed"},
  /**
   * `propose_upgrade`'s `delay_in_ledgers` is below
   * [`GlobeWallet::MIN_UPGRADE_DELAY_LEDGERS`] (see issue #84).
   */
  1037: {message:"UpgradeDelayTooShort"},
  /**
   * `set_recovery_config`'s `delay_in_ledgers` is below
   * [`GlobeWallet::MIN_RECOVERY_DELAY_LEDGERS`] (see issue #84).
   */
  1038: {message:"RecoveryDelayTooShort"},
  /**
   * `send` was called while a `Role::Pauser` holder has paused the
   * contract (issue #190).
   */
  1039: {message:"ContractPaused"},
  /**
   * `propose_allowed_token`'s `token_id` is not the Stellar Asset
   * Contract derived from the supplied asset code + issuer (issue #189).
   */
  1040: {message:"TokenNotStellarAsset"},
  /**
   * No timelocked allowlist proposal exists for this token (issue #189).
   */
  1041: {message:"AllowlistProposalNotFound"},
  /**
   * The allowlist timelock has not elapsed yet (issue #189).
   */
  1042: {message:"AllowlistNotReady"},
  /**
   * A proposal for this token is already pending, or the token is
   * already allowlisted (issue #189).
   */
  1043: {message:"AllowlistAlreadyPending"},
  1044: {message:"SendsPaused"},
  1045: {message:"SpendLimitArchived"},
  1046: {message:"NoPendingSpendLimit"},
  1047: {message:"GuardianChangePending"},
  1048: {message:"NoPendingGuardianChange"},
  1049: {message:"GuardianChangeNotReady"},
  1050: {message:"RecoveryCancelNotAllowed"}
}


/**
 * A queued guardian addition or removal (#175). Applied by
 * `apply_guardian_change` once `ready_at` is reached and no recovery is
 * pending.
 */
export interface GuardianChange {
  /**
 * `true` = add, `false` = remove.
 */
add: boolean;
  guardian: string;
  /**
 * Ledger sequence from which the change may be applied.
 */
ready_at: u32;
}


export interface RecoveryConfig {
  /**
 * Ledger-count delay between reaching quorum and `execute_recovery`
 * becoming callable. Gives the legitimate admin a window to notice
 * and cancel a malicious or mistaken recovery.
 */
delay_in_ledgers: u32;
  /**
 * Number of distinct guardian approvals required to reach quorum.
 */
threshold: u32;
}


/**
 * Read-only view of a user's rolling 24 h spend window for one asset,
 * returned by [`GlobeWallet::get_spend_allowance`] (issues #50, #177).
 * 
 * Times are ledger timestamps (Unix seconds, by ledger close time).
 */
export interface SpendAllowance {
  /**
 * Configured daily cap (0 = unlimited).
 */
limit: i128;
  /**
 * When the oldest counted bucket rolls off and `remaining` next grows.
 * 0 when nothing is counted.
 */
next_refill_at: u64;
  /**
 * `limit - spent`, floored at 0. 0 when `limit == 0` — callers must
 * check `limit` to distinguish "unlimited" from "nothing left".
 */
remaining: i128;
  /**
 * Amount spent in the rolling window. Tracked even when `limit == 0`
 * (issue #179), so turning a limit on later accounts for it.
 */
spent: i128;
  /**
 * When every spend currently counted will have rolled off (`spent`
 * reaches 0 if nothing else is spent). Equals "now" when `spent == 0`.
 */
window_resets_at: u64;
  /**
 * Start of the oldest hourly bucket still counted in `spent`.
 */
window_start: u64;
}


export interface UpgradeProposal {
  proposed_by: string;
  ready_at: u32;
  wasm_hash: Buffer;
}


export interface AllowedTokenInfo {
  asset_code: string;
  issuer_key: IssuerKey;
  token_id: string;
}


export interface RecoveryProposal {
  approvals: Array<string>;
  new_admin: string;
  /**
 * Set once quorum is first reached; cleared again if approvals drop
 * back below threshold. `execute_recovery` requires `ledger seq >= ready_at`.
 */
ready_at: Option<u32>;
}


/**
 * @event role_granted
 */
export interface RoleGrantedEvent {
  account: string;
  granted_by: string;
  role: Role;
}


/**
 * @event role_revoked
 */
export interface RoleRevokedEvent {
  account: string;
  revoked_by: string;
  role: Role;
}


/**
 * @event pause_changed
 */
export interface PauseChangedEvent {
  changed_by: string;
  paused: boolean;
}


/**
 * A spend-limit increase waiting out [`SPEND_LIMIT_INCREASE_DELAY_SECS`]
 * (#176). `limit == 0` means the pending change switches to unlimited.
 */
export interface PendingSpendLimit {
  /**
 * Ledger timestamp (Unix seconds) from which `limit` is in force.
 */
effective_at: u64;
  limit: i128;
}


/**
 * @event send_executed
 */
export interface SendExecutedEvent {
  amount: i128;
  to: string;
  token_id: string;
  user: string;
}


/**
 * @event token_allowed
 */
export interface TokenAllowedEvent {
  asset_code: string;
  executed_by: string;
  issuer_key: IssuerKey;
  token_id: string;
}


/**
 * A timelocked allowlist addition (issue #189).
 */
export interface PendingAllowedToken {
  info: AllowedTokenInfo;
  proposed_by: string;
  ready_at: u32;
}


/**
 * @event token_disallowed
 */
export interface TokenDisallowedEvent {
  removed_by: string;
  token_id: string;
}


/**
 * @event recovery_completed
 * 
 * Payload of the `recovery_completed` event `execute_recovery` publishes
 * (see issue #91). Every other event in this contract is a raw tuple —
 * this one was deliberately a named `#[contracttype]` struct instead (issue #192 has since added typed struct payloads for every new event), and
 * that's a one-off departure worth explaining rather than a stylistic
 * accident: a tuple's fields are positional and undocumented in the
 * on-chain XDR itself, which is a tolerable ergonomics trade-off for a
 * 2-3 field payload where order is obvious from context. This event has
 * five fields feeding a security-alerting integration, where a
 * transposed pair of `Address`es (e.g. an indexer reading `new_admin`
 * where `old_admin` belongs) has real consequences — it would misreport
 * *who just lost control of a wallet* during exactly the incident that
 * most needs to be reported correctly. A named struct makes every field
 * self-describing in the XDR, independent of any off-chain schema the
 * reader has to already know and 
 */
export interface RecoveryCompletedEvent {
  /**
 * Every guardian whose approval is on the executed proposal — not
 * just the `threshold` minimum. A recovery ratified 5-of-5 and one
 * ratified 3-of-5 (with `threshold == 3`) are different-risk events
 * even though both satisfy the same on-chain quorum check; an
 * alerting integration that only knows "quorum was reached" can't
 * tell them apart, this field lets it.
 */
approving_guardians: Array<string>;
  /**
 * Ledger sequence of the `execute_recovery` call itself. Comparing
 * this against `ready_at` tells an observer how promptly the
 * now-executable recovery was actually claimed — a long gap can be
 * as meaningful to a monitoring system as the recovery itself (e.g.
 * "why did nobody execute an approved recovery for three days?").
 */
executed_at: u32;
  /**
 * Admin address the guardians recovered control to.
 */
new_admin: string;
  /**
 * Admin address in control immediately before this recovery.
 */
old_admin: string;
  /**
 * Ledger sequence at which the timelock elapsed and this recovery
 * became executable (`RecoveryProposal.ready_at` at execution time).
 */
ready_at: u32;
  /**
 * `RecoveryConfig.threshold` in effect for this execution — the
 * minimum quorum size, for computing how much above/below the bare
 * minimum `approving_guardians` actually was.
 */
threshold: u32;
}


/**
 * @event token_allowlist_proposed
 */
export interface TokenAllowlistProposedEvent {
  asset_code: string;
  issuer_key: IssuerKey;
  proposed_by: string;
  ready_at: u32;
  token_id: string;
}


/**
 * @event token_allowlist_cancelled
 */
export interface TokenAllowlistCancelledEvent {
  cancelled_by: string;
  token_id: string;
}


export interface Allowance {
  amount: i128;
  expiry_ledger: u32;
}

export const WrapperError = {
  2001: {message:"AllowanceExpired"},
  2002: {message:"InsufficientAllowance"},
  2003: {message:"InvalidAmount"},
  2004: {message:"InvalidExpiry"}
}

export type WrapperDataKey = {tag: "Allowance", values: readonly [string, string]} | {tag: "TokenAllowance", values: readonly [string, string, string]};

export interface Client {
  /**
   * Construct and simulate a send transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Atomically enforce the daily spend limit and move `amount` of
   * `token_id` from `user` to `to`, via `token-wrapper::transfer_from`.
   * 
   * `user` must have already granted this contract (i.e.
   * `env.current_contract_address()`) an allowance scoped to `token_id`
   * via `token-wrapper::approve(user, wallet, token_id, ..)` before
   * calling this — matching `docs/design/architecture.md`'s intended
   * integration flow.
   * 
   * The daily limit charged is the one for `token_id` itself; there is no
   * separate asset-code argument to disagree with it (issue #173).
   * 
   * ## Who signs (auth tree, issue #174)
   * `user` signs one authorization tree rooted at `send`; inside it the
   * token's own `transfer(user, to, amount)` sub-invocation (made by
   * token-wrapper) also requires `user`. This contract authorizes itself
   * as the token-wrapper `spender` implicitly (direct caller). See
   * `docs/design/token-wrapper-auth-model.md`.
   * 
   * # Errors
   * * [`WalletError::ContractPaused`] if a pauser has paused the contract.
   * * [`WalletError::TokenNotAllowed`] if `token_id` is not allowl
   */
  send: ({user, token_id, to, amount}: {user: string, token_id: string, to: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return current admin.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pauser: block `send` until `unpause`.
   */
  pause: ({caller}: {caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pauser transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The address currently allowed to pause sends, if any.
   */
  pauser: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a unpause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pauser: re-enable `send`.
   */
  unpause: ({caller}: {caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a has_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `account` holds `role` (the admin implicitly holds all roles).
   */
  has_role: ({role, account}: {role: Role, account: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a add_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Add an asset to a user's wallet registry.
   * 
   * Only the user themselves (via `require_auth`) can add assets.
   * 
   * # Errors
   * * [`WalletError::InvalidAssetCode`] — `asset.code` is empty or exceeds
   * [`Self::MAX_ASSET_CODE_LEN`].
   * * [`WalletError::AssetAlreadyAdded`] — asset code already registered
   * (case-insensitive — see [`AssetInfo::code`]'s doc comment).
   * * [`WalletError::AssetLimitExceeded`] — user would exceed [`Self::MAX_ASSETS`].
   */
  add_asset: ({user, asset}: {user: string, asset: AssetInfo}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a guardians transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the current guardian set.
   */
  guardians: (options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

  /**
   * Construct and simulate a is_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `send` is currently paused.
   */
  is_paused: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_assets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return all assets registered by a user.
   */
  get_assets: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<AssetInfo>>>

  /**
   * Construct and simulate a grant_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: grant `role` to `account`.
   */
  grant_role: ({admin, role, account}: {admin: string, role: Role, account: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initialize the contract with an admin address.
   * 
   * # Errors
   * * [`WalletError::AlreadyInitialized`]
   */
  initialize: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_pauser transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: set (or clear, with `None`) the address allowed to pause sends.
   */
  set_pauser: ({admin, pauser}: {admin: string, pauser: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pause_sends transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pauser or admin: stop `send` until the admin unpauses. Idempotent —
   * pausing an already-paused contract succeeds without a second event.
   * 
   * # Errors
   * * [`WalletError::Unauthorized`] if `caller` is neither pauser nor admin.
   */
  pause_sends: ({caller}: {caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a revoke_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: revoke `role` from `account`.
   */
  revoke_role: ({admin, role, account}: {admin: string, role: Role, account: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Accept a pending admin proposal.
   */
  accept_admin: ({candidate}: {candidate: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a add_guardian transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register a new guardian. Admin-authorized.
   * 
   * ## Timelock and freeze (issue #175)
   * Before recovery is configured (initial setup) the guardian is added
   * immediately. Once a `RecoveryConfig` exists the addition is only
   * *queued* as a [`GuardianChange`] that `apply_guardian_change` can land
   * after `RecoveryConfig.delay_in_ledgers` — the same delay a recovery
   * has to wait out — so a compromised admin cannot pack the set with
   * sybils faster than the honest guardians can start a recovery. While a
   * recovery proposal is pending the guardian set is frozen and this call
   * fails with [`WalletError::RecoveryAlreadyPending`].
   * 
   * # Errors
   * * [`WalletError::GuardianAlreadyAdded`]
   * * [`WalletError::GuardianLimitExceeded`] — would exceed
   * [`Self::MAX_GUARDIANS`] (see issue #27).
   * * [`WalletError::RecoveryAlreadyPending`] — guardian set is frozen.
   * * [`WalletError::GuardianChangePending`] — another change is queued.
   */
  add_guardian: ({admin, guardian}: {admin: string, guardian: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a record_spend transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record a spend and reject if it would exceed the rolling 24 h limit.
   * 
   * Call this from any payment-execution path to enforce limits. The
   * spend is recorded even when no limit is set (issue #179). The window
   * is the trailing 24 h (hourly buckets plus one guard bucket, see
   * [`SPEND_WINDOW_BUCKETS`]), so there is no midnight reset to exploit
   * (issue #177).
   * 
   * Reentrancy invariant: keep the interval from reading `SpendWindow`
   * through writing its replacement free of external contract calls. See
   * `docs/record-spend-reentrancy.md` for the proof and change guidance.
   * 
   * `amount` must be strictly positive. `require_auth()` on `user`
   * authenticates the *caller*, not the *value* — in the compromised-key
   * threat model this function exists to defend against, the attacker
   * can already produce valid `user` signatures, so `require_auth()`
   * alone provides no protection here. A non-positive `amount` would let
   * that same attacker call `record_spend` with a negative value to
   * decrease (or zero out) `spent_today` below what was actually spent,
   * t
   */
  record_spend: ({user, token_id, amount}: {user: string, token_id: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a remove_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Remove an asset from a user's wallet registry.
   * 
   * # Errors
   * * [`WalletError::AssetNotFound`] — asset code not registered.
   */
  remove_asset: ({user, asset_code}: {user: string, asset_code: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pending_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the pending admin candidate, if any.
   */
  pending_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a propose_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Propose a new admin candidate.
   * 
   * The current admin remains in control until the candidate accepts.
   */
  propose_admin: ({current, candidate}: {current: string, candidate: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a unpause_sends transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin only: resume `send`. Idempotent like [`Self::pause_sends`].
   * 
   * # Errors
   * * [`WalletError::Unauthorized`] for anyone but the admin — including the pauser.
   */
  unpause_sends: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a allowed_tokens transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the list of all allowed token contract addresses (alias).
   */
  allowed_tokens: (options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

  /**
   * Construct and simulate a is_send_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `send` is currently paused. Read by the backend status flag.
   */
  is_send_paused: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a storage_layout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Storage layout version in effect (issue #184). `1` = legacy instance
   * layout, `2` = guardians/proposal in persistent storage.
   */
  storage_layout: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a transfer_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Legacy single-step admin transfer.
   * 
   * Deprecated in favor of `propose_admin` + `accept_admin`.
   * 
   * # Errors
   * * [`WalletError::NotInitialized`] / [`WalletError::Unauthorized`]
   */
  transfer_admin: ({current, new_admin}: {current: string, new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_recovery transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The current admin cancels a pending recovery.
   * 
   * ## Restricted cancel window (issue #175)
   * Recovery exists for the case where the admin key is lost *or
   * compromised*. An unrestricted admin cancel let a hostile admin stall
   * every recovery forever, so cancellation is now limited:
   * * Before quorum is reached the admin may always cancel.
   * * After quorum the admin may cancel only during the first half of the
   * timelock (`ready_at - delay_in_ledgers / 2`), giving a legitimate
   * admin time to object to a colluding majority without letting a
   * compromised one front-run `execute_recovery` at the last ledger.
   * * Once approvals reach a guardian supermajority (at least two thirds
   * of the guardian set) the admin can no longer cancel at all — the
   * supermajority overrides the admin key.
   * 
   * # Errors
   * * [`WalletError::NoPendingRecovery`]
   * * [`WalletError::RecoveryCancelNotAllowed`] — window closed or
   * supermajority reached.
   */
  cancel_recovery: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Execute a previously proposed upgrade after the timelock elapses.
   * 
   * This function validates that:
   * 1. A proposal exists and is stored in instance storage
   * 2. The provided `wasm_hash` matches the proposed hash (via equality check)
   * 3. The current ledger sequence has reached or exceeded `ready_at` (timelock elapsed)
   * 4. The `wasm_hash` was previously registered on-chain via [`Env::deployer().upload_contract_wasm()`]
   * 
   * # Errors
   * * [`WalletError::UpgradeNotPending`] — no pending upgrade proposal
   * * [`WalletError::UpgradeHashMismatch`] — provided hash doesn't match stored proposal
   * * [`WalletError::UpgradeNotReady`] — timelock has not yet elapsed
   * * [`WalletError::UpgradeWasmNotUploaded`] — wasm hash was never registered on-chain
   * 
   * # Operational Notes
   * Correct upgrade sequence is:
   * 1. Upload new contract WASM via a separate transaction → obtain wasm_hash
   * 2. Call `propose_upgrade` with that hash and desired delay
   * 3. Wait for the delay (in ledgers) to elapse
   * 4. Call `execute_upgrade` with the same hash
   * 
   * If a WASM blob 
   */
  execute_upgrade: ({executor, wasm_hash}: {executor: string, wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a extend_user_ttl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Keep a user's entries alive (issue #185). Permissionless so a keeper
   * can pay for it. Returns how many entries were extended.
   */
  extend_user_ttl: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a get_spend_limit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Effective daily cap for (user, token); 0 = unlimited. Panics with
   * `SpendLimitArchived` if the limit was archived (issue #185).
   */
  get_spend_limit: ({user, token_id}: {user: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_spent_today transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Amount spent in the trailing 24 h window.
   */
  get_spent_today: ({user, token_id}: {user: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a pending_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the pending upgrade proposal, if any.
   */
  pending_upgrade: (options?: MethodOptions) => Promise<AssembledTransaction<Option<UpgradeProposal>>>

  /**
   * Construct and simulate a propose_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Queue an upgrade for later execution.
   * 
   * The proposal is stored in contract instance storage and emitted as an
   * event so the upgrade is visible on-chain before any code swap occurs.
   * 
   * The provided `wasm_hash` is stored as-is *without validation* — it is
   * the caller's responsibility to ensure it matches a blob previously uploaded
   * on-chain via [`Env::deployer().upload_contract_wasm()`]. No pre-check is
   * performed here; validation occurs when `execute_upgrade` is called.
   * 
   * # Errors
   * * [`WalletError::UpgradeAlreadyPending`] — an upgrade is already queued
   * * [`WalletError::Unauthorized`] — caller is neither the admin nor a
   * [`Role::Upgrader`] holder (issue #190)
   * * [`WalletError::UpgradeDelayTooShort`] — `delay_in_ledgers` is below
   * [`Self::MIN_UPGRADE_DELAY_LEDGERS`] (see issue #84)
   * 
   * See [`Self::execute_upgrade`] for operational notes and the correct
   * sequence of steps (upload → propose → wait → execute).
   */
  propose_upgrade: ({proposer, wasm_hash, delay_in_ledgers}: {proposer: string, wasm_hash: Buffer, delay_in_ledgers: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a recovery_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the current recovery configuration, if any.
   */
  recovery_config: (options?: MethodOptions) => Promise<AssembledTransaction<Option<RecoveryConfig>>>

  /**
   * Construct and simulate a remove_guardian transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Remove a guardian. Admin-authorized.
   * 
   * Same freeze/timelock rules as [`Self::add_guardian`] (issue #175):
   * immediate before recovery is configured, queued for
   * `RecoveryConfig.delay_in_ledgers` afterwards, and rejected while a
   * recovery proposal is pending. Because the set is frozen during a
   * recovery, a removal can no longer strip approvals from an in-flight
   * proposal — the approval-stripping path from issue #26 is unreachable
   * and was removed; `require_guardian` still stops a removed guardian
   * from acting on any *later* proposal.
   * 
   * # Errors
   * * [`WalletError::GuardianNotFound`]
   * * [`WalletError::NotEnoughGuardians`] — would drop the guardian count
   * below the configured recovery threshold.
   * * [`WalletError::RecoveryAlreadyPending`] — guardian set is frozen.
   * * [`WalletError::GuardianChangePending`] — another change is queued.
   */
  remove_guardian: ({admin, guardian}: {admin: string, guardian: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_spend_limit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set a rolling 24 h spend limit (in stroops) for a specific asset.
   * 
   * `limit = 0` removes the limit (unlimited).
   * 
   * ## Decreases are immediate, increases are delayed (issue #176)
   * Spend limits exist to cap the loss from a compromised user key, and
   * that same key is all `set_spend_limit` requires. So:
   * * a **decrease** (any non-zero limit `<=` the current effective limit,
   * or any non-zero limit when currently unlimited) takes effect at once
   * and discards any queued increase;
   * * an **increase** (or a switch to unlimited) is stored as a
   * [`PendingSpendLimit`] that only takes effect
   * [`SPEND_LIMIT_INCREASE_DELAY_SECS`] later, emitting
   * `spend_limit_increase_pending` so the backend can alert the owner,
   * who can call `cancel_pending_spend_limit` (as can any guardian).
   * Spends above the old limit keep failing until the delay elapses.
   * 
   * **Retroactive enforcement:** if the user has already spent more than
   * a proposed lower limit in the current day window, the call is rejected
   * with `SpendLimitExceeded`.
   * 
   * # Errors
   * * [`WalletError::Invali
   */
  set_spend_limit: ({user, token_id, limit}: {user: string, token_id: string, limit: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a approve_recovery transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A guardian approves the pending recovery proposal.
   * 
   * Once approvals reach the configured threshold, the timelock is
   * armed: `ready_at = current_ledger_sequence + delay_in_ledgers`.
   */
  approve_recovery: ({guardian}: {guardian: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_recovery transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Execute a recovery once quorum has been reached and the timelock has
   * elapsed. Callable by anyone (typically a guardian or the new admin
   * candidate) — authorization comes entirely from the guardian
   * signatures already recorded on the proposal, not from the caller.
   * 
   * Deliberately does **not** call `require_admin`/`current.require_auth()`:
   * that is precisely the capability that is unavailable when a device is
   * lost. Re-checks quorum at execution time (not just at
   * `approve_recovery` time) in case a guardian revoked between quorum
   * and timelock expiry in a way this contract didn't observe (defense in
   * depth; `revoke_recovery_approval` already clears `ready_at`, but this
   * guards against any future code path that forgets to).
   * 
   * Any in-flight *normal* `propose_admin`/`accept_admin` transfer is
   * cancelled as part of executing a recovery, so the two flows can't race.
   * 
   * # Events (see issue #91)
   * Publishes **two** events, deliberately, not one:
   * 1. `admin_transferred` — identical topic and payload shape to what
   * `accept_admin` pub
   */
  execute_recovery: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a is_token_allowed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns whether `token_id` is currently allowlisted for `send`.
   */
  is_token_allowed: ({token_id}: {token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_token_wrapper transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the currently configured token-wrapper contract instance, if any.
   */
  get_token_wrapper: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a initiate_recovery transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A guardian initiates a recovery to `new_admin`. Counts as that
   * guardian's own approval.
   * 
   * # Errors
   * * [`WalletError::RecoveryNotConfigured`]
   * * [`WalletError::Unauthorized`] — caller is not a registered guardian.
   * * [`WalletError::RecoveryAlreadyPending`]
   */
  initiate_recovery: ({guardian, new_admin}: {guardian: string, new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a is_limit_archived transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `true` when a limit was set but its entry has been archived.
   */
  is_limit_archived: ({user, token_id}: {user: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a recovery_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the pending recovery proposal, if any.
   */
  recovery_proposal: (options?: MethodOptions) => Promise<AssembledTransaction<Option<RecoveryProposal>>>

  /**
   * Construct and simulate a set_token_wrapper transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: set the token-wrapper contract instance `send` calls into.
   */
  set_token_wrapper: ({admin, token_wrapper_id}: {admin: string, token_wrapper_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a allowed_token_info transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the verified asset metadata stored with an allowlisted token.
   */
  allowed_token_info: ({token_id}: {token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<AllowedTokenInfo>>>

  /**
   * Construct and simulate a get_allowed_tokens transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the list of all allowed token contract addresses.
   */
  get_allowed_tokens: (options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

  /**
   * Construct and simulate a get_spend_allowance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Limit, spend and refill times for the rolling window (issue #177).
   */
  get_spend_allowance: ({user, token_id}: {user: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<SpendAllowance>>

  /**
   * Construct and simulate a migrate_spend_limit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: move a legacy `(user, asset_code)` limit and spend record onto
   * the token-keyed storage (issue #173). The stricter limit wins.
   * Returns `false` when there was nothing to migrate.
   */
  migrate_spend_limit: ({admin, user, asset_code, token_id}: {admin: string, user: string, asset_code: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a migrate_user_assets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin and user: trim a user's asset list to [`GlobeWallet::MAX_ASSETS`] if it exceeds the bound.
   * Returns the number of assets trimmed (0 if already within limit).
   * 
   * Only the display list is trimmed. Spend limits and spend windows of
   * trimmed assets are kept and keep being enforced (issue #178); one
   * `("migration", "asset_untracked")` event with `(user, code, limit)`
   * is emitted per trimmed asset.
   * 
   * # Authorization Decision
   * Dual authorization is required: `admin.require_auth()` ensures only an
   * administrator can initiate a migration, while `user.require_auth()`
   * preserves the self-sovereign property of the wallet by ensuring the
   * user consents to the exact asset list modification taking place.
   */
  migrate_user_assets: ({admin, user}: {admin: string, user: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a pending_spend_limit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The pending limit increase for (user, token), if any.
   */
  pending_spend_limit: ({user, token_id}: {user: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingSpendLimit>>>

  /**
   * Construct and simulate a set_recovery_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configure (or reconfigure) the M-of-N recovery threshold and the
   * post-quorum timelock delay. Admin-authorized.
   * 
   * ## Design decision: rejected while a recovery is pending (issue #28)
   * A `RecoveryProposal`'s `ready_at` is computed once, at the moment
   * quorum is reached in `approve_recovery`, and frozen into storage —
   * it does not retroactively track later `delay_in_ledgers` changes.
   * Meanwhile `execute_recovery`'s quorum check reads the *live*
   * `RecoveryConfig.threshold`, not the config in effect when quorum was
   * reached. That half-live, half-frozen coupling is confusing enough
   * (and undertested enough — see #28) that the safer design is to
   * disallow the ambiguity outright: while a `RecoveryProposal` exists,
   * `set_recovery_config` is rejected with [`WalletError::RecoveryAlreadyPending`].
   * An admin who wants to change the threshold/delay while a recovery is
   * in flight must first call `cancel_recovery` (if reachable) — the
   * already-existing, unambiguous way to stop a pending proposal — rather
   * than mutate config undern
   */
  set_recovery_config: ({admin, threshold, delay_in_ledgers}: {admin: string, threshold: u32, delay_in_ledgers: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_allowed_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Allowlist manager: drop a pending proposal before it is executed.
   */
  cancel_allowed_token: ({caller, token_id}: {caller: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a remove_allowed_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Allowlist manager: remove `token_id` from the send-allowlist.
   * 
   * Removal is immediate (no timelock) — shrinking the allowlist can only
   * reduce what `send` is able to move.
   */
  remove_allowed_token: ({caller, token_id}: {caller: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a apply_guardian_change transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Land the queued guardian-set change once its timelock has elapsed
   * (issue #175). Permissionless — the admin authorized the change when
   * queueing it; the delay is the guardians' window to react. Validation
   * is re-run at apply time because the set may have changed meanwhile.
   * 
   * # Errors
   * * [`WalletError::NoPendingGuardianChange`]
   * * [`WalletError::GuardianChangeNotReady`]
   * * [`WalletError::RecoveryAlreadyPending`] — the set is frozen while a
   * recovery is in flight; a successful recovery discards the change.
   */
  apply_guardian_change: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_admin_transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancel the current pending admin proposal.
   */
  cancel_admin_transfer: ({current}: {current: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_allowed_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Allowlist manager: finalize a proposal once its timelock elapsed.
   * 
   * # Errors
   * * [`WalletError::Unauthorized`] — caller lacks [`Role::AllowlistManager`]
   * * [`WalletError::AllowlistProposalNotFound`]
   * * [`WalletError::AllowlistNotReady`] — timelock still running
   */
  execute_allowed_token: ({caller, token_id}: {caller: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pending_allowed_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the pending (timelocked) allowlist proposal for `token_id`.
   */
  pending_allowed_token: ({token_id}: {token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingAllowedToken>>>

  /**
   * Construct and simulate a propose_allowed_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Allowlist manager: propose `token_id` for the `send` allowlist.
   * 
   * The contract only accepts genuine Stellar Asset Contracts (issue
   * #189): it rebuilds the classic asset's XDR from `asset_code` +
   * `issuer_key` (raw ed25519 issuer key; `None` = native XLM), derives the
   * SAC address the network would assign to that asset, and rejects the
   * proposal unless it equals `token_id`. A custom contract that merely
   * *claims* to be "USDC" can never match, because a SAC's address is a
   * pure function of the asset it wraps. The addition only takes effect
   * after [`Self::ALLOWLIST_DELAY_LEDGERS`] via `execute_allowed_token`.
   * 
   * # Errors
   * * [`WalletError::Unauthorized`] — caller lacks [`Role::AllowlistManager`]
   * * [`WalletError::InvalidAssetCode`] / [`WalletError::InvalidAssetInfo`]
   * * [`WalletError::TokenNotStellarAsset`] — `token_id` is not that asset's SAC
   * * [`WalletError::AllowlistAlreadyPending`] — already proposed or allowed
   */
  propose_allowed_token: ({caller, token_id, asset_code, issuer_key}: {caller: string, token_id: string, asset_code: string, issuer_key: Option<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_guardian_change transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: discard the queued guardian-set change (issue #175).
   * 
   * # Errors
   * * [`WalletError::NoPendingGuardianChange`]
   */
  cancel_guardian_change: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a migrate_storage_layout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-triggered migration from the v1 instance layout to v2
   * (issue #184). Moves `Guardians`/`GuardianMembership`/`RecoveryProposal`
   * out of instance storage into persistent keys. Returns `true` if it
   * migrated, `false` if the contract was already on v2. Every guardian or
   * recovery write also migrates lazily, so calling this is optional; it
   * exists so operators can shrink the instance footprint immediately
   * after upgrading instead of waiting for the next guardian write.
   */
  migrate_storage_layout: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a pending_guardian_change transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the queued guardian-set change, if any (issue #175).
   */
  pending_guardian_change: (options?: MethodOptions) => Promise<AssembledTransaction<Option<GuardianChange>>>

  /**
   * Construct and simulate a revoke_recovery_approval transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A guardian revokes their own approval of the pending recovery.
   * 
   * If approvals drop below threshold, the timelock is disarmed
   * (`ready_at` cleared) — quorum must be reached again from scratch,
   * restarting the delay window.
   * 
   * # Errors
   * * [`WalletError::Unauthorized`] — caller is not a currently
   * registered guardian. Added for consistency with
   * `initiate_recovery`/`approve_recovery`, which both already gate on
   * `require_guardian`; this function was the one exception to that
   * pattern (see issue #26) — harmless on its own since revoking only
   * ever *removes* an approval, but leaving it unchecked meant guardian
   * membership wasn't enforced consistently across the whole approval
   * lifecycle.
   */
  revoke_recovery_approval: ({guardian}: {guardian: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_pending_spend_limit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancel a pending limit increase before it takes effect. The owner or
   * any guardian may cancel.
   * 
   * # Errors
   * * [`WalletError::NoPendingSpendLimit`]
   */
  cancel_pending_spend_limit: ({caller, user, token_id}: {caller: string, user: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a approve transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Grant a spender allowance over the caller's tokens.
   * 
   * **Overwrite semantics:** calling `approve` for an existing
   * `(owner, spender)` pair **replaces** the previous allowance
   * wholesale — it does **not** add to the remaining balance.
   * If a spender has already used part of their allowance and
   * the owner calls `approve` again, the new `amount` becomes the
   * *total* allowance, not an increment on top of what's left.
   * 
   * The allowance applies to `token_id` only (issue #174).
   * 
   * `expiry_ledger` must be in the future.
   */
  approve: ({owner, spender, token_id, amount, expiry_ledger}: {owner: string, spender: string, token_id: string, amount: i128, expiry_ledger: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a allowance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return current allowance for (owner, spender, token_id).
   */
  allowance: ({owner, spender, token_id}: {owner: string, spender: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Allowance>>

  /**
   * Construct and simulate a transfer_from transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer tokens from `from` to `to` using a previously granted allowance.
   * 
   * Decrements the `(from, spender, token_id)` allowance; fails if expired
   * or insufficient. An allowance granted for a different token never
   * applies (`InsufficientAllowance`, issue #174).
   * An allowance is usable through and including its `expiry_ledger`.
   */
  transfer_from: ({spender, token_id, from, to, amount}: {spender: string, token_id: string, from: string, to: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a extend_allowance_ttl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless TTL keeper for one allowance (issue #185).
   * 
   * Re-extends the `(owner, spender, token_id)` entry so storage never archives it
   * before its own `expiry_ledger`. Values are untouched, so no auth is
   * needed — anyone (the backend keeper job) may pay for it. Returns the
   * number of ledgers the entry was extended to live for (0 when the pair
   * has no allowance or it has already expired, in which case there is
   * nothing worth keeping alive).
   */
  extend_allowance_ttl: ({owner, spender, token_id}: {owner: string, spender: string, token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAABABBdG9taWNhbGx5IGVuZm9yY2UgdGhlIGRhaWx5IHNwZW5kIGxpbWl0IGFuZCBtb3ZlIGBhbW91bnRgIG9mCmB0b2tlbl9pZGAgZnJvbSBgdXNlcmAgdG8gYHRvYCwgdmlhIGB0b2tlbi13cmFwcGVyOjp0cmFuc2Zlcl9mcm9tYC4KCmB1c2VyYCBtdXN0IGhhdmUgYWxyZWFkeSBncmFudGVkIHRoaXMgY29udHJhY3QgKGkuZS4KYGVudi5jdXJyZW50X2NvbnRyYWN0X2FkZHJlc3MoKWApIGFuIGFsbG93YW5jZSBzY29wZWQgdG8gYHRva2VuX2lkYAp2aWEgYHRva2VuLXdyYXBwZXI6OmFwcHJvdmUodXNlciwgd2FsbGV0LCB0b2tlbl9pZCwgLi4pYCBiZWZvcmUKY2FsbGluZyB0aGlzIOKAlCBtYXRjaGluZyBgZG9jcy9kZXNpZ24vYXJjaGl0ZWN0dXJlLm1kYCdzIGludGVuZGVkCmludGVncmF0aW9uIGZsb3cuCgpUaGUgZGFpbHkgbGltaXQgY2hhcmdlZCBpcyB0aGUgb25lIGZvciBgdG9rZW5faWRgIGl0c2VsZjsgdGhlcmUgaXMgbm8Kc2VwYXJhdGUgYXNzZXQtY29kZSBhcmd1bWVudCB0byBkaXNhZ3JlZSB3aXRoIGl0IChpc3N1ZSAjMTczKS4KCiMjIFdobyBzaWducyAoYXV0aCB0cmVlLCBpc3N1ZSAjMTc0KQpgdXNlcmAgc2lnbnMgb25lIGF1dGhvcml6YXRpb24gdHJlZSByb290ZWQgYXQgYHNlbmRgOyBpbnNpZGUgaXQgdGhlCnRva2VuJ3Mgb3duIGB0cmFuc2Zlcih1c2VyLCB0bywgYW1vdW50KWAgc3ViLWludm9jYXRpb24gKG1hZGUgYnkKdG9rZW4td3JhcHBlcikgYWxzbyByZXF1aXJlcyBgdXNlcmAuIFRoaXMgY29udHJhY3QgYXV0aG9yaXplcyBpdHNlbGYKYXMgdGhlIHRva2VuLXdyYXBwZXIgYHNwZW5kZXJgIGltcGxpY2l0bHkgKGRpcmVjdCBjYWxsZXIpLiBTZWUKYGRvY3MvZGVzaWduL3Rva2VuLXdyYXBwZXItYXV0aC1tb2RlbC5tZGAuCgojIEVycm9ycwoqIFtgV2FsbGV0RXJyb3I6OkNvbnRyYWN0UGF1c2VkYF0gaWYgYSBwYXVzZXIgaGFzIHBhdXNlZCB0aGUgY29udHJhY3QuCiogW2BXYWxsZXRFcnJvcjo6VG9rZW5Ob3RBbGxvd2VkYF0gaWYgYHRva2VuX2lkYCBpcyBub3QgYWxsb3dsAAAABHNlbmQAAAAEAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAIdG9rZW5faWQAAAATAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAAAAABVSZXR1cm4gY3VycmVudCBhZG1pbi4AAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAACVQYXVzZXI6IGJsb2NrIGBzZW5kYCB1bnRpbCBgdW5wYXVzZWAuAAAAAAAABXBhdXNlAAAAAAAAAQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAAAAADVUaGUgYWRkcmVzcyBjdXJyZW50bHkgYWxsb3dlZCB0byBwYXVzZSBzZW5kcywgaWYgYW55LgAAAAAAAAZwYXVzZXIAAAAAAAAAAAABAAAD6AAAABM=",
        "AAAAAwAAAelEZWxlZ2FibGUgcHJpdmlsZWdlcy4gVGhlIGFkbWluIGltcGxpY2l0bHkgaG9sZHMgZXZlcnkgcm9sZTsgYW55b25lIGVsc2UKbXVzdCBiZSBncmFudGVkIGEgcm9sZSBleHBsaWNpdGx5IHZpYSBgZ3JhbnRfcm9sZWAuIEVhY2ggcm9sZSBvbmx5CnVubG9ja3MgaXRzIG93biBmdW5jdGlvbnMg4oCUIGFuIGBBbGxvd2xpc3RNYW5hZ2VyYCBjYW5ub3QgdXBncmFkZSB0aGUKY29udHJhY3QsIGFuIGBVcGdyYWRlcmAgY2Fubm90IHBhdXNlIGl0LCBhbmQgc28gb24uIFRoZSBhZG1pbiBpdHNlbGYgaXMKZXhwZWN0ZWQgdG8gYmUgYSBTdGVsbGFyIG11bHRpc2lnIGFjY291bnQgKHNlZSBgZG9jcy9nb3Zlcm5hbmNlLm1kYCksIHNvCm5vIHNpbmdsZSBrZXkgY29udHJvbHMgYSBjcml0aWNhbCBmdW5jdGlvbi4KCkRpc2NyaW1pbmFudHMgYXJlIGV4cGxpY2l0IGFuZCBzdGFibGU6IHRoZXkgYXJlIHBhcnQgb2Ygc3RvcmFnZSBrZXlzIGFuZApldmVudCBwYXlsb2Fkcy4AAAAAAAAAAAAABFJvbGUAAAADAAAAJmBwcm9wb3NlX3VwZ3JhZGVgIC8gYGV4ZWN1dGVfdXBncmFkZWAuAAAAAAAIVXBncmFkZXIAAAABAAAAZGBwcm9wb3NlX2FsbG93ZWRfdG9rZW5gIC8gYGV4ZWN1dGVfYWxsb3dlZF90b2tlbmAgLwpgY2FuY2VsX2FsbG93ZWRfdG9rZW5gIC8gYHJlbW92ZV9hbGxvd2VkX3Rva2VuYC4AAAAQQWxsb3dsaXN0TWFuYWdlcgAAAAIAAAAUYHBhdXNlYCAvIGB1bnBhdXNlYC4AAAAGUGF1c2VyAAAAAAAD",
        "AAAAAAAAABlQYXVzZXI6IHJlLWVuYWJsZSBgc2VuZGAuAAAAAAAAB3VucGF1c2UAAAAAAQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAAAAAEZXaGV0aGVyIGBhY2NvdW50YCBob2xkcyBgcm9sZWAgKHRoZSBhZG1pbiBpbXBsaWNpdGx5IGhvbGRzIGFsbCByb2xlcykuAAAAAAAIaGFzX3JvbGUAAAACAAAAAAAAAARyb2xlAAAH0AAAAARSb2xlAAAAAAAAAAdhY2NvdW50AAAAABMAAAABAAAAAQ==",
        "AAAAAAAAAbBBZGQgYW4gYXNzZXQgdG8gYSB1c2VyJ3Mgd2FsbGV0IHJlZ2lzdHJ5LgoKT25seSB0aGUgdXNlciB0aGVtc2VsdmVzICh2aWEgYHJlcXVpcmVfYXV0aGApIGNhbiBhZGQgYXNzZXRzLgoKIyBFcnJvcnMKKiBbYFdhbGxldEVycm9yOjpJbnZhbGlkQXNzZXRDb2RlYF0g4oCUIGBhc3NldC5jb2RlYCBpcyBlbXB0eSBvciBleGNlZWRzCltgU2VsZjo6TUFYX0FTU0VUX0NPREVfTEVOYF0uCiogW2BXYWxsZXRFcnJvcjo6QXNzZXRBbHJlYWR5QWRkZWRgXSDigJQgYXNzZXQgY29kZSBhbHJlYWR5IHJlZ2lzdGVyZWQKKGNhc2UtaW5zZW5zaXRpdmUg4oCUIHNlZSBbYEFzc2V0SW5mbzo6Y29kZWBdJ3MgZG9jIGNvbW1lbnQpLgoqIFtgV2FsbGV0RXJyb3I6OkFzc2V0TGltaXRFeGNlZWRlZGBdIOKAlCB1c2VyIHdvdWxkIGV4Y2VlZCBbYFNlbGY6Ok1BWF9BU1NFVFNgXS4AAAAJYWRkX2Fzc2V0AAAAAAAAAgAAAAAAAAAEdXNlcgAAABMAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAlBc3NldEluZm8AAAAAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAAAAACBSZXR1cm4gdGhlIGN1cnJlbnQgZ3VhcmRpYW4gc2V0LgAAAAlndWFyZGlhbnMAAAAAAAAAAAAAAQAAA+oAAAAT",
        "AAAAAAAAACNXaGV0aGVyIGBzZW5kYCBpcyBjdXJyZW50bHkgcGF1c2VkLgAAAAAJaXNfcGF1c2VkAAAAAAAAAAAAAAEAAAAB",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAHQAAAAAAAAAAAAAABUFkbWluAAAAAAAAAQAAACxQZW5kaW5nIGFkbWluIGNhbmRpZGF0ZSBhd2FpdGluZyBhY2NlcHRhbmNlLgAAAAxQZW5kaW5nQWRtaW4AAAABAAAAEwAAAAAAAAAAAAAADlBlbmRpbmdVcGdyYWRlAAAAAAABAAAAJFdoaXRlbGlzdGVkIGFzc2V0cyBmb3IgYSB1c2VyIHdhbGxldAAAAApVc2VyQXNzZXRzAAAAAAABAAAAEwAAAAEAAAA0U3BlbmQgbGltaXQ6ICh1c2VyLCBhc3NldF9jb2RlKSDihpIgbGltaXQgaW4gc3Ryb29wcwAAAApTcGVuZExpbWl0AAAAAAACAAAAEwAAABAAAAABAAAAO0RhaWx5IHNwZW50OiAodXNlciwgYXNzZXRfY29kZSkg4oaSIChhbW91bnQsIGRheV90aW1lc3RhbXApAAAAAApEYWlseVNwZW50AAAAAAACAAAAEwAAABAAAAAAAAAAR09yZGVyZWQgc2V0IG9mIGd1YXJkaWFuIGFkZHJlc3NlcyBhdXRob3JpemVkIHRvIGNvLXNpZ24gYWRtaW4gcmVjb3ZlcnkuAAAAAAlHdWFyZGlhbnMAAAAAAAAAAAAAf00tb2YtTiBhcHByb3ZhbHMgcmVxdWlyZWQsIGFuZCB0aGUgbGVkZ2VyLWNvdW50IHRpbWVsb2NrIGRlbGF5CmJldHdlZW4gcXVvcnVtIGJlaW5nIHJlYWNoZWQgYW5kIGEgcmVjb3ZlcnkgYmVjb21pbmcgZXhlY3V0YWJsZS4AAAAADlJlY292ZXJ5Q29uZmlnAAAAAAAAAAAAL1RoZSBzaW5nbGUgaW4tZmxpZ2h0IHJlY292ZXJ5IHByb3Bvc2FsLCBpZiBhbnkuAAAAABBSZWNvdmVyeVByb3Bvc2FsAAAAAAAAAMBNZW1iZXJzaGlwIGluZGV4IGZvciBndWFyZGlhbnMsIHVzZWQgdG8gYXZvaWQgc2NhbnMgb24gcmVjb3ZlcnkgY2FsbHMuCgpUaGlzIGlzIGludGVudGlvbmFsbHkgYXBwZW5kZWQgc28gdGhlIHNlcmlhbGl6ZWQgdmFsdWVzIG9mIGV4aXN0aW5nCnN0b3JhZ2Uga2V5cyByZW1haW4gc3RhYmxlIGFjcm9zcyBjb250cmFjdCB1cGdyYWRlcy4AAAASR3VhcmRpYW5NZW1iZXJzaGlwAAAAAAAAAAAAjFRoZSB0b2tlbi13cmFwcGVyIGNvbnRyYWN0IGluc3RhbmNlIGBzZW5kYCBjYWxscyBpbnRvLiBBZG1pbi1zZXQgdmlhCmBzZXRfdG9rZW5fd3JhcHBlcmAuIFNlZSBkb2NzL2Rlc2lnbi93aXJpbmctcmVlbnRyYW5jeS10aHJlYXQtbW9kZWwubWQuAAAADlRva2VuV3JhcHBlcklkAAAAAAABAAAA40FkbWluLWN1cmF0ZWQgc2V0IG9mIHRva2VuIGNvbnRyYWN0IGFkZHJlc3NlcyBgc2VuZGAgaXMgcGVybWl0dGVkIHRvCm1vdmUuIE1lbWJlcnNoaXAgb25seSDigJQgcHJlc2VuY2Ugb2YgdGhlIGtleSBtZWFucyAiYWxsb3dlZCI7IHNlZQpgcHJvcG9zZV9hbGxvd2VkX3Rva2VuYC9gZXhlY3V0ZV9hbGxvd2VkX3Rva2VuYC9gcmVtb3ZlX2FsbG93ZWRfdG9rZW5gLwpgaXNfdG9rZW5fYWxsb3dlZGAuAAAAAAxBbGxvd2VkVG9rZW4AAAABAAAAEwAAAAAAAAA7QWRtaW4tY3VyYXRlZCBsaXN0IG9mIGFsbCBhbGxvd2VkIHRva2VuIGNvbnRyYWN0IGFkZHJlc3Nlcy4AAAAADUFsbG93ZWRUb2tlbnMAAAAAAAABAAAAaFZlcmlmaWVkIFN0ZWxsYXIgQXNzZXQgQ29udHJhY3QgbWV0YWRhdGEgKGNvZGUsIGlzc3Vlcikgc3RvcmVkIHdpdGgKZWFjaCBhbGxvd2xpc3RlZCB0b2tlbiAoaXNzdWUgIzE4OSkuAAAAEEFsbG93ZWRUb2tlbkluZm8AAAABAAAAEwAAAAEAAABMVGltZWxvY2tlZCBhbGxvd2xpc3QgYWRkaXRpb24gYXdhaXRpbmcgYGV4ZWN1dGVfYWxsb3dlZF90b2tlbmAKKGlzc3VlICMxODkpLgAAABNQZW5kaW5nQWxsb3dlZFRva2VuAAAAAAEAAAATAAAAAQAAAERSb2xlIG1lbWJlcnNoaXA6IHByZXNlbmNlIG1lYW5zIGBBZGRyZXNzYCBob2xkcyBgUm9sZWAgKGlzc3VlICMxOTApLgAAAApSb2xlTWVtYmVyAAAAAAACAAAH0AAAAARSb2xlAAAAEwAAAAAAAAA9RW1lcmdlbmN5IHBhdXNlIGZsYWcgZm9yIGBzZW5kYCAoaXNzdWUgIzE5MCwgYFJvbGU6OlBhdXNlcmApLgAAAAAAAAZQYXVzZWQAAAAAAAAAAAAAAAAABlBhdXNlcgAAAAAAAAAAAAAAAAALU2VuZHNQYXVzZWQAAAAAAQAAAIcodXNlciwgdG9rZW4pIOKGkiBtYXJrZXIgdGhhdCBhIG5vbi16ZXJvIGxpbWl0IHdhcyBzZXQgKGlzc3VlICMxODUpLApzbyBhbiBhcmNoaXZlZCBsaW1pdCBmYWlscyBzYWZlIGluc3RlYWQgb2YgcmVhZGluZyBhcyAidW5saW1pdGVkIi4AAAAACkxpbWl0T3B0SW4AAAAAAAIAAAATAAAAEwAAAAEAAAA4KHVzZXIsIHRva2VuKSDihpIgcm9sbGluZyAyNGggc3BlbmQgd2luZG93IChpc3N1ZSAjMTc3KS4AAAALU3BlbmRXaW5kb3cAAAAAAgAAABMAAAATAAAAAQAAACkodXNlciwgdG9rZW4pIOKGkiBkYWlseSBjYXAgKGlzc3VlICMxNzMpLgAAAAAAAA9Ub2tlblNwZW5kTGltaXQAAAAAAgAAABMAAAATAAAAAQAAAD0odXNlciwgdG9rZW4pIOKGkiBsZWdhY3kgZml4ZWQtZGF5IHNwZW5kIHJlY29yZCAoaXNzdWUgIzE3MykuAAAAAAAAD1Rva2VuRGFpbHlTcGVudAAAAAACAAAAEwAAABMAAAABAAAARCh1c2VyLCB0b2tlbikg4oaSIGxpbWl0IGluY3JlYXNlIHdhaXRpbmcgb3V0IGl0cyBkZWxheSAoaXNzdWUgIzE3MykuAAAAEVBlbmRpbmdTcGVuZExpbWl0AAAAAAAAAgAAABMAAAATAAAAAAAAAAAAAAAVUGVuZGluZ0d1YXJkaWFuQ2hhbmdlAAAAAAAAAAAAAAAAAAALR3VhcmRpYW5TZXQAAAAAAQAAAAAAAAAMR3VhcmRpYW5GbGFnAAAAAQAAABMAAAAAAAAAAAAAAA9QZW5kaW5nUmVjb3ZlcnkAAAAAAAAAAAAAAAANU3RvcmFnZUxheW91dAAAAA==",
        "AAAAAAAAACdSZXR1cm4gYWxsIGFzc2V0cyByZWdpc3RlcmVkIGJ5IGEgdXNlci4AAAAACmdldF9hc3NldHMAAAAAAAEAAAAAAAAABHVzZXIAAAATAAAAAQAAA+oAAAfQAAAACUFzc2V0SW5mbwAAAA==",
        "AAAAAAAAACFBZG1pbjogZ3JhbnQgYHJvbGVgIHRvIGBhY2NvdW50YC4AAAAAAAAKZ3JhbnRfcm9sZQAAAAAAAwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAARyb2xlAAAH0AAAAARSb2xlAAAAAAAAAAdhY2NvdW50AAAAABMAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAAAAAF5Jbml0aWFsaXplIHRoZSBjb250cmFjdCB3aXRoIGFuIGFkbWluIGFkZHJlc3MuCgojIEVycm9ycwoqIFtgV2FsbGV0RXJyb3I6OkFscmVhZHlJbml0aWFsaXplZGBdAAAAAAAKaW5pdGlhbGl6ZQAAAAAAAQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAAAAAEZBZG1pbjogc2V0IChvciBjbGVhciwgd2l0aCBgTm9uZWApIHRoZSBhZGRyZXNzIGFsbG93ZWQgdG8gcGF1c2Ugc2VuZHMuAAAAAAAKc2V0X3BhdXNlcgAAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAZwYXVzZXIAAAAAA+gAAAATAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAAAAANxQYXVzZXIgb3IgYWRtaW46IHN0b3AgYHNlbmRgIHVudGlsIHRoZSBhZG1pbiB1bnBhdXNlcy4gSWRlbXBvdGVudCDigJQKcGF1c2luZyBhbiBhbHJlYWR5LXBhdXNlZCBjb250cmFjdCBzdWNjZWVkcyB3aXRob3V0IGEgc2Vjb25kIGV2ZW50LgoKIyBFcnJvcnMKKiBbYFdhbGxldEVycm9yOjpVbmF1dGhvcml6ZWRgXSBpZiBgY2FsbGVyYCBpcyBuZWl0aGVyIHBhdXNlciBub3IgYWRtaW4uAAAAC3BhdXNlX3NlbmRzAAAAAAEAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAfQAAAAC1dhbGxldEVycm9yAA==",
        "AAAAAAAAACRBZG1pbjogcmV2b2tlIGByb2xlYCBmcm9tIGBhY2NvdW50YC4AAAALcmV2b2tlX3JvbGUAAAAAAwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAARyb2xlAAAH0AAAAARSb2xlAAAAAAAAAAdhY2NvdW50AAAAABMAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAQAAAAAAAAAAAAAACUFzc2V0SW5mbwAAAAAAAAIAAAGlZS5nLiAiWExNIiwgIlVTREMiCgoqKkNhbm9uaWNhbGl6YXRpb24gZGVjaXNpb24gKGlzc3VlICMyOSk6KiogYGNvZGVgIG11c3QgYmUgbm9uLWVtcHR5CmFuZCBhdCBtb3N0IFtgR2xvYmVXYWxsZXQ6Ok1BWF9BU1NFVF9DT0RFX0xFTmBdIGJ5dGVzIOKAlCBlbmZvcmNlZCBieQpbYEdsb2JlV2FsbGV0OjphZGRfYXNzZXRgXS4gU3RvcmFnZSBwcmVzZXJ2ZXMgdGhlIGNhbGxlcidzIG9yaWdpbmFsCmNhc2luZywgYnV0IGR1cGxpY2F0ZSBkZXRlY3Rpb24gaW4gYGFkZF9hc3NldGAgdHJlYXRzIGNvZGVzIGFzIGVxdWFsCmNhc2UtaW5zZW5zaXRpdmVseSAoQVNDSUkpLCBzbyBgIlVTREMiYCBhbmQgYCJ1c2RjImAgYXJlIGNvbnNpZGVyZWQKdGhlIHNhbWUgYXNzZXQgYW5kIGNhbm5vdCBib3RoIGJlIHJlZ2lzdGVyZWQgZm9yIG9uZSB1c2VyLgAAAAAAAARjb2RlAAAAEAAAACVJc3N1ZXIgYWRkcmVzczsgTm9uZSBmb3IgWExNIChuYXRpdmUpAAAAAAAABmlzc3VlcgAAAAAD6AAAABM=",
        "AAAAAgAAAWdWZXJpZmllZCBTdGVsbGFyIEFzc2V0IENvbnRyYWN0IGlkZW50aXR5IHN0b3JlZCB3aXRoIGVhY2ggYWxsb3dsaXN0ZWQKdG9rZW4gKGlzc3VlICMxODkpLiBgaXNzdWVyX2tleWAgaXMgdGhlIHJhdyBlZDI1NTE5IGlzc3VlciBwdWJsaWMga2V5LApgTm9uZWAgZm9yIG5hdGl2ZSBYTE0uCklzc3VlciBvZiBhbiBhbGxvd2xpc3RlZCBTdGVsbGFyIGFzc2V0LiBBIHBsYWluIGBPcHRpb248Qnl0ZXNOPDMyPj5gCmZpZWxkIGRvZXMgbm90IGNvbnZlcnQgdG8gYFNjVmFsYCB1bmRlciBzb3JvYmFuLXNkayAyMSB0ZXN0dXRpbHMsIHNvIHRoZQoibm8gaXNzdWVyIiBjYXNlIChuYXRpdmUgWExNKSBpcyBzcGVsbGVkIG91dCBpbnN0ZWFkLgAAAAAAAAAACUlzc3VlcktleQAAAAAAAAIAAAAAAAAAAAAAAAZOYXRpdmUAAAAAAAEAAAAAAAAAA0tleQAAAAABAAAD7gAAACA=",
        "AAAAAAAAACBBY2NlcHQgYSBwZW5kaW5nIGFkbWluIHByb3Bvc2FsLgAAAAxhY2NlcHRfYWRtaW4AAAABAAAAAAAAAAljYW5kaWRhdGUAAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAAAAA4dSZWdpc3RlciBhIG5ldyBndWFyZGlhbi4gQWRtaW4tYXV0aG9yaXplZC4KCiMjIFRpbWVsb2NrIGFuZCBmcmVlemUgKGlzc3VlICMxNzUpCkJlZm9yZSByZWNvdmVyeSBpcyBjb25maWd1cmVkIChpbml0aWFsIHNldHVwKSB0aGUgZ3VhcmRpYW4gaXMgYWRkZWQKaW1tZWRpYXRlbHkuIE9uY2UgYSBgUmVjb3ZlcnlDb25maWdgIGV4aXN0cyB0aGUgYWRkaXRpb24gaXMgb25seQoqcXVldWVkKiBhcyBhIFtgR3VhcmRpYW5DaGFuZ2VgXSB0aGF0IGBhcHBseV9ndWFyZGlhbl9jaGFuZ2VgIGNhbiBsYW5kCmFmdGVyIGBSZWNvdmVyeUNvbmZpZy5kZWxheV9pbl9sZWRnZXJzYCDigJQgdGhlIHNhbWUgZGVsYXkgYSByZWNvdmVyeQpoYXMgdG8gd2FpdCBvdXQg4oCUIHNvIGEgY29tcHJvbWlzZWQgYWRtaW4gY2Fubm90IHBhY2sgdGhlIHNldCB3aXRoCnN5YmlscyBmYXN0ZXIgdGhhbiB0aGUgaG9uZXN0IGd1YXJkaWFucyBjYW4gc3RhcnQgYSByZWNvdmVyeS4gV2hpbGUgYQpyZWNvdmVyeSBwcm9wb3NhbCBpcyBwZW5kaW5nIHRoZSBndWFyZGlhbiBzZXQgaXMgZnJvemVuIGFuZCB0aGlzIGNhbGwKZmFpbHMgd2l0aCBbYFdhbGxldEVycm9yOjpSZWNvdmVyeUFscmVhZHlQZW5kaW5nYF0uCgojIEVycm9ycwoqIFtgV2FsbGV0RXJyb3I6Okd1YXJkaWFuQWxyZWFkeUFkZGVkYF0KKiBbYFdhbGxldEVycm9yOjpHdWFyZGlhbkxpbWl0RXhjZWVkZWRgXSDigJQgd291bGQgZXhjZWVkCltgU2VsZjo6TUFYX0dVQVJESUFOU2BdIChzZWUgaXNzdWUgIzI3KS4KKiBbYFdhbGxldEVycm9yOjpSZWNvdmVyeUFscmVhZHlQZW5kaW5nYF0g4oCUIGd1YXJkaWFuIHNldCBpcyBmcm96ZW4uCiogW2BXYWxsZXRFcnJvcjo6R3VhcmRpYW5DaGFuZ2VQZW5kaW5nYF0g4oCUIGFub3RoZXIgY2hhbmdlIGlzIHF1ZXVlZC4AAAAADGFkZF9ndWFyZGlhbgAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIZ3VhcmRpYW4AAAATAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAAAABABSZWNvcmQgYSBzcGVuZCBhbmQgcmVqZWN0IGlmIGl0IHdvdWxkIGV4Y2VlZCB0aGUgcm9sbGluZyAyNCBoIGxpbWl0LgoKQ2FsbCB0aGlzIGZyb20gYW55IHBheW1lbnQtZXhlY3V0aW9uIHBhdGggdG8gZW5mb3JjZSBsaW1pdHMuIFRoZQpzcGVuZCBpcyByZWNvcmRlZCBldmVuIHdoZW4gbm8gbGltaXQgaXMgc2V0IChpc3N1ZSAjMTc5KS4gVGhlIHdpbmRvdwppcyB0aGUgdHJhaWxpbmcgMjQgaCAoaG91cmx5IGJ1Y2tldHMgcGx1cyBvbmUgZ3VhcmQgYnVja2V0LCBzZWUKW2BTUEVORF9XSU5ET1dfQlVDS0VUU2BdKSwgc28gdGhlcmUgaXMgbm8gbWlkbmlnaHQgcmVzZXQgdG8gZXhwbG9pdAooaXNzdWUgIzE3NykuCgpSZWVudHJhbmN5IGludmFyaWFudDoga2VlcCB0aGUgaW50ZXJ2YWwgZnJvbSByZWFkaW5nIGBTcGVuZFdpbmRvd2AKdGhyb3VnaCB3cml0aW5nIGl0cyByZXBsYWNlbWVudCBmcmVlIG9mIGV4dGVybmFsIGNvbnRyYWN0IGNhbGxzLiBTZWUKYGRvY3MvcmVjb3JkLXNwZW5kLXJlZW50cmFuY3kubWRgIGZvciB0aGUgcHJvb2YgYW5kIGNoYW5nZSBndWlkYW5jZS4KCmBhbW91bnRgIG11c3QgYmUgc3RyaWN0bHkgcG9zaXRpdmUuIGByZXF1aXJlX2F1dGgoKWAgb24gYHVzZXJgCmF1dGhlbnRpY2F0ZXMgdGhlICpjYWxsZXIqLCBub3QgdGhlICp2YWx1ZSog4oCUIGluIHRoZSBjb21wcm9taXNlZC1rZXkKdGhyZWF0IG1vZGVsIHRoaXMgZnVuY3Rpb24gZXhpc3RzIHRvIGRlZmVuZCBhZ2FpbnN0LCB0aGUgYXR0YWNrZXIKY2FuIGFscmVhZHkgcHJvZHVjZSB2YWxpZCBgdXNlcmAgc2lnbmF0dXJlcywgc28gYHJlcXVpcmVfYXV0aCgpYAphbG9uZSBwcm92aWRlcyBubyBwcm90ZWN0aW9uIGhlcmUuIEEgbm9uLXBvc2l0aXZlIGBhbW91bnRgIHdvdWxkIGxldAp0aGF0IHNhbWUgYXR0YWNrZXIgY2FsbCBgcmVjb3JkX3NwZW5kYCB3aXRoIGEgbmVnYXRpdmUgdmFsdWUgdG8KZGVjcmVhc2UgKG9yIHplcm8gb3V0KSBgc3BlbnRfdG9kYXlgIGJlbG93IHdoYXQgd2FzIGFjdHVhbGx5IHNwZW50LAp0AAAADHJlY29yZF9zcGVuZAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAAAAAAh0b2tlbl9pZAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAfQAAAAC1dhbGxldEVycm9yAA==",
        "AAAAAAAAAHhSZW1vdmUgYW4gYXNzZXQgZnJvbSBhIHVzZXIncyB3YWxsZXQgcmVnaXN0cnkuCgojIEVycm9ycwoqIFtgV2FsbGV0RXJyb3I6OkFzc2V0Tm90Rm91bmRgXSDigJQgYXNzZXQgY29kZSBub3QgcmVnaXN0ZXJlZC4AAAAMcmVtb3ZlX2Fzc2V0AAAAAgAAAAAAAAAEdXNlcgAAABMAAAAAAAAACmFzc2V0X2NvZGUAAAAAABAAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAAAAACtSZXR1cm4gdGhlIHBlbmRpbmcgYWRtaW4gY2FuZGlkYXRlLCBpZiBhbnkuAAAAAA1wZW5kaW5nX2FkbWluAAAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAGFQcm9wb3NlIGEgbmV3IGFkbWluIGNhbmRpZGF0ZS4KClRoZSBjdXJyZW50IGFkbWluIHJlbWFpbnMgaW4gY29udHJvbCB1bnRpbCB0aGUgY2FuZGlkYXRlIGFjY2VwdHMuAAAAAAAADXByb3Bvc2VfYWRtaW4AAAAAAAACAAAAAAAAAAdjdXJyZW50AAAAABMAAAAAAAAACWNhbmRpZGF0ZQAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAAAAAJ5BZG1pbiBvbmx5OiByZXN1bWUgYHNlbmRgLiBJZGVtcG90ZW50IGxpa2UgW2BTZWxmOjpwYXVzZV9zZW5kc2BdLgoKIyBFcnJvcnMKKiBbYFdhbGxldEVycm9yOjpVbmF1dGhvcml6ZWRgXSBmb3IgYW55b25lIGJ1dCB0aGUgYWRtaW4g4oCUIGluY2x1ZGluZyB0aGUgcGF1c2VyLgAAAAAADXVucGF1c2Vfc2VuZHMAAAAAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAQAAAAAAAAAAAAAAC1NwZW5kUmVjb3JkAAAAAAIAAAAAAAAABmFtb3VudAAAAAAACwAAAC9MZWRnZXItdGltZSB0aW1lc3RhbXAgb2YgdGhlIGN1cnJlbnQgZGF5IHdpbmRvdwAAAAADZGF5AAAAAAY=",
        "AAAAAQAAAUZSb2xsaW5nIHNwZW5kIHdpbmRvdyBmb3Igb25lICh1c2VyLCBhc3NldCkgcGFpciAoaXNzdWUgIzE3NykuCgpPKDEpIHN0b3JhZ2U6IGEgZml4ZWQgcmluZyBvZiBbYFNQRU5EX1dJTkRPV19CVUNLRVRTYF0gaG91cmx5IHRvdGFscy4KU2xvdCBgaCAlIFNQRU5EX1dJTkRPV19CVUNLRVRTYCBob2xkcyB0aGUgYW1vdW50IHNwZW50IGR1cmluZyBob3VyIGBoYAooYGggPSBsZWRnZXJfdGltZXN0YW1wIC8gMzYwMGApLiBCdWNrZXRzIG9sZGVyIHRoYW4KYGhlYWRfaG91ciAtIChTUEVORF9XSU5ET1dfQlVDS0VUUyAtIDEpYCBhcmUgemVyb2VkIGFzIHRoZSBoZWFkIG1vdmVzLgAAAAAAAAAAAAtTcGVuZFdpbmRvdwAAAAACAAAAL0V4YWN0bHkgYFNQRU5EX1dJTkRPV19CVUNLRVRTYCBwZXItaG91ciB0b3RhbHMuAAAAAAdidWNrZXRzAAAAA+oAAAALAAAAP0hvdXIgaW5kZXggb2YgdGhlIG5ld2VzdCBidWNrZXQgdGhpcyByaW5nIGhhcyBiZWVuIGFkdmFuY2VkIHRvLgAAAAAJaGVhZF9ob3VyAAAAAAAABg==",
        "AAAABAAAAAAAAAAAAAAAC1dhbGxldEVycm9yAAAAADIAAAAAAAAAEkFscmVhZHlJbml0aWFsaXplZAAAAAAD6QAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAA+oAAAAAAAAADFVuYXV0aG9yaXplZAAAA+sAAAAAAAAAEUFzc2V0QWxyZWFkeUFkZGVkAAAAAAAD7AAAAAAAAAANQXNzZXROb3RGb3VuZAAAAAAAA+0AAAAAAAAAEUludmFsaWRTcGVuZExpbWl0AAAAAAAD7gAAADlQYXltZW50IHdvdWxkIGV4Y2VlZCB0aGUgZGFpbHkgc3BlbmQgbGltaXQgZm9yIHRoaXMgYXNzZXQAAAAAAAASU3BlbmRMaW1pdEV4Y2VlZGVkAAAAAAPvAAAAAAAAABBOb0Fzc2V0c1Byb3ZpZGVkAAAD8AAAAAAAAAAOTm9QZW5kaW5nQWRtaW4AAAAAA/EAAAAAAAAADVNwZW5kT3ZlcmZsb3cAAAAAAAPyAAAAAAAAABJBc3NldExpbWl0RXhjZWVkZWQAAAAAA/MAAAAAAAAAEE1heEFzc2V0c1JlYWNoZWQAAAP0AAAAAAAAABVVcGdyYWRlQWxyZWFkeVBlbmRpbmcAAAAAAAP1AAAAAAAAABFVcGdyYWRlTm90UGVuZGluZwAAAAAAA/YAAAAAAAAAE1VwZ3JhZGVIYXNoTWlzbWF0Y2gAAAAD9wAAAAAAAAAPVXBncmFkZU5vdFJlYWR5AAAAA/gAAAAAAAAADVVwZ3JhZGVGYWlsZWQAAAAAAAP5AAAAJEd1YXJkaWFuIGFkZHJlc3MgYWxyZWFkeSByZWdpc3RlcmVkLgAAABRHdWFyZGlhbkFscmVhZHlBZGRlZAAAA/oAAAAlQWRkcmVzcyBpcyBub3QgYSByZWdpc3RlcmVkIGd1YXJkaWFuLgAAAAAAABBHdWFyZGlhbk5vdEZvdW5kAAAD+wAAAD5SZWNvdmVyeSB0aHJlc2hvbGQgbXVzdCBiZSBgMSA8IHRocmVzaG9sZCA8PSBndWFyZGlhbnMubGVuKClgLgAAAAAAGEludmFsaWRSZWNvdmVyeVRocmVzaG9sZAAAA/wAAAB7YGFkZF9ndWFyZGlhbmAvYHNldF9yZWNvdmVyeV9jb25maWdgIHdvdWxkIGxlYXZlIHRocmVzaG9sZCA+Cmd1YXJkaWFuIGNvdW50LCBvciBndWFyZGlhbnMubGVuKCkgYmVsb3cgdGhlIHJlcXVpcmVkIG1pbmltdW0uAAAAABJOb3RFbm91Z2hHdWFyZGlhbnMAAAAAA/0AAABQTm8gcmVjb3ZlcnkgdGhyZXNob2xkL2RlbGF5IGNvbmZpZ3VyZWQgeWV0IOKAlCBjYWxsIGBzZXRfcmVjb3ZlcnlfY29uZmlnYCBmaXJzdC4AAAAVUmVjb3ZlcnlOb3RDb25maWd1cmVkAAAAAAAD/gAAAEVBIHJlY292ZXJ5IHByb3Bvc2FsIGlzIGFscmVhZHkgaW4gZmxpZ2h0OyBjYW5jZWwgb3IgZXhlY3V0ZSBpdCBmaXJzdC4AAAAAAAAWUmVjb3ZlcnlBbHJlYWR5UGVuZGluZwAAAAAD/wAAACpObyByZWNvdmVyeSBwcm9wb3NhbCBpcyBjdXJyZW50bHkgcGVuZGluZy4AAAAAABFOb1BlbmRpbmdSZWNvdmVyeQAAAAAABAAAAAAzR3VhcmRpYW4gaGFzIGFscmVhZHkgYXBwcm92ZWQgdGhlIHBlbmRpbmcgcHJvcG9zYWwuAAAAAA9BbHJlYWR5QXBwcm92ZWQAAAAEAQAAAENHdWFyZGlhbiBoYXMgbm90IGFwcHJvdmVkIHRoZSBwZW5kaW5nIHByb3Bvc2FsIChub3RoaW5nIHRvIHJldm9rZSkuAAAAABBBcHByb3ZhbE5vdEZvdW5kAAAEAgAAADpRdW9ydW0gcmVhY2hlZCBidXQgdGhlIHRpbWVsb2NrIGRlbGF5IGhhcyBub3QgeWV0IGVsYXBzZWQuAAAAAAAQUmVjb3ZlcnlOb3RSZWFkeQAABAMAAABLQXBwcm92YWxzIGRyb3BwZWQgYmVsb3cgdGhyZXNob2xkIHNpbmNlIHF1b3J1bSB3YXMgcmVhY2hlZDsgdGltZWxvY2sgcmVzZXQuAAAAABJSZWNvdmVyeU5vdFF1b3JhdGUAAAAABAQAAAAuQXNzZXQgY29kZSBhbmQgaXNzdWVyIGNvbmZpZ3VyYXRpb24gaXMgaW52YWxpZAAAAAAAEEludmFsaWRBc3NldEluZm8AAAQFAAAAV1Byb3Bvc2VkIHdhc20gaGFzaCBpcyBub3QgcmVnaXN0ZXJlZCBvbi1jaGFpbiAobmV2ZXIgdXBsb2FkZWQgdmlhIHVwbG9hZF9jb250cmFjdF93YXNtKQAAAAAWVXBncmFkZVdhc21Ob3RVcGxvYWRlZAAAAAAEBgAAADtgYWRkX2d1YXJkaWFuYCB3b3VsZCBleGNlZWQgW2BHbG9iZVdhbGxldDo6TUFYX0dVQVJESUFOU2BdLgAAAAAVR3VhcmRpYW5MaW1pdEV4Y2VlZGVkAAAAAAAEBwAAAL1gZXhlY3V0ZV9yZWNvdmVyeWAncyBwcm9wb3NhbCB0YXJnZXRzIHRoZSBzYW1lIGFkZHJlc3MgdGhhdCBpcwphbHJlYWR5IHRoZSBjdXJyZW50IGFkbWluIOKAlCByZWNvdmVyaW5nICJ0byIgYSBuby1vcCB0YXJnZXQgaXMKcmVqZWN0ZWQgcmF0aGVyIHRoYW4gc2lsZW50bHkgc3VjY2VlZGluZyBhcyBhIHdhc3RlZCB0cmFuc2Zlci4AAAAAAAAZUmVjb3ZlcnlOZXdBZG1pblVuY2hhbmdlZAAAAAAABAgAAABHYEFzc2V0SW5mby5jb2RlYCBpcyBlbXB0eSBvciBleGNlZWRzIGBHbG9iZVdhbGxldDo6TUFYX0FTU0VUX0NPREVfTEVOYC4AAAAAEEludmFsaWRBc3NldENvZGUAAAQJAAAAcWBzZW5kYCdzIGB0b2tlbl9pZGAgaXMgbm90IG9uIHRoZSBhZG1pbi1jdXJhdGVkIGFsbG93bGlzdC4gU2VlCmRvY3MvZGVzaWduL3dpcmluZy1yZWVudHJhbmN5LXRocmVhdC1tb2RlbC5tZCDCpzQuAAAAAAAAD1Rva2VuTm90QWxsb3dlZAAAAAQKAAAAaWBzZW5kYCB3YXMgY2FsbGVkIGJlZm9yZSBhbiBhZG1pbiBjb25maWd1cmVkIHRoZSB0b2tlbi13cmFwcGVyCmNvbnRyYWN0IGluc3RhbmNlIHZpYSBgc2V0X3Rva2VuX3dyYXBwZXJgLgAAAAAAABJUb2tlbldyYXBwZXJOb3RTZXQAAAAABAsAAACBVGhlIGB0b2tlbi13cmFwcGVyOjp0cmFuc2Zlcl9mcm9tYCBjYWxsIGBzZW5kYCBtYWtlcyBmYWlsZWQgKGUuZy4KaW5zdWZmaWNpZW50L2V4cGlyZWQgYWxsb3dhbmNlKSBvciBjb3VsZCBub3QgYmUgaW52b2tlZCBhdCBhbGwuAAAAAAAAE1Rva2VuVHJhbnNmZXJGYWlsZWQAAAAEDAAAAGtgcHJvcG9zZV91cGdyYWRlYCdzIGBkZWxheV9pbl9sZWRnZXJzYCBpcyBiZWxvdwpbYEdsb2JlV2FsbGV0OjpNSU5fVVBHUkFERV9ERUxBWV9MRURHRVJTYF0gKHNlZSBpc3N1ZSAjODQpLgAAAAAUVXBncmFkZURlbGF5VG9vU2hvcnQAAAQNAAAAcGBzZXRfcmVjb3ZlcnlfY29uZmlnYCdzIGBkZWxheV9pbl9sZWRnZXJzYCBpcyBiZWxvdwpbYEdsb2JlV2FsbGV0OjpNSU5fUkVDT1ZFUllfREVMQVlfTEVER0VSU2BdIChzZWUgaXNzdWUgIzg0KS4AAAAVUmVjb3ZlcnlEZWxheVRvb1Nob3J0AAAAAAAEDgAAAFVgc2VuZGAgd2FzIGNhbGxlZCB3aGlsZSBhIGBSb2xlOjpQYXVzZXJgIGhvbGRlciBoYXMgcGF1c2VkIHRoZQpjb250cmFjdCAoaXNzdWUgIzE5MCkuAAAAAAAADkNvbnRyYWN0UGF1c2VkAAAAAAQPAAAAgmBwcm9wb3NlX2FsbG93ZWRfdG9rZW5gJ3MgYHRva2VuX2lkYCBpcyBub3QgdGhlIFN0ZWxsYXIgQXNzZXQKQ29udHJhY3QgZGVyaXZlZCBmcm9tIHRoZSBzdXBwbGllZCBhc3NldCBjb2RlICsgaXNzdWVyIChpc3N1ZSAjMTg5KS4AAAAAABRUb2tlbk5vdFN0ZWxsYXJBc3NldAAABBAAAABETm8gdGltZWxvY2tlZCBhbGxvd2xpc3QgcHJvcG9zYWwgZXhpc3RzIGZvciB0aGlzIHRva2VuIChpc3N1ZSAjMTg5KS4AAAAZQWxsb3dsaXN0UHJvcG9zYWxOb3RGb3VuZAAAAAAABBEAAAA4VGhlIGFsbG93bGlzdCB0aW1lbG9jayBoYXMgbm90IGVsYXBzZWQgeWV0IChpc3N1ZSAjMTg5KS4AAAARQWxsb3dsaXN0Tm90UmVhZHkAAAAAAAQSAAAAX0EgcHJvcG9zYWwgZm9yIHRoaXMgdG9rZW4gaXMgYWxyZWFkeSBwZW5kaW5nLCBvciB0aGUgdG9rZW4gaXMKYWxyZWFkeSBhbGxvd2xpc3RlZCAoaXNzdWUgIzE4OSkuAAAAABdBbGxvd2xpc3RBbHJlYWR5UGVuZGluZwAAAAQTAAAAAAAAAAtTZW5kc1BhdXNlZAAAAAQUAAAAAAAAABJTcGVuZExpbWl0QXJjaGl2ZWQAAAAABBUAAAAAAAAAE05vUGVuZGluZ1NwZW5kTGltaXQAAAAEFgAAAAAAAAAVR3VhcmRpYW5DaGFuZ2VQZW5kaW5nAAAAAAAEFwAAAAAAAAAXTm9QZW5kaW5nR3VhcmRpYW5DaGFuZ2UAAAAEGAAAAAAAAAAWR3VhcmRpYW5DaGFuZ2VOb3RSZWFkeQAAAAAEGQAAAAAAAAAYUmVjb3ZlcnlDYW5jZWxOb3RBbGxvd2VkAAAEGg==",
        "AAAAAAAAAEBSZXR1cm4gdGhlIGxpc3Qgb2YgYWxsIGFsbG93ZWQgdG9rZW4gY29udHJhY3QgYWRkcmVzc2VzIChhbGlhcykuAAAADmFsbG93ZWRfdG9rZW5zAAAAAAAAAAAAAQAAA+oAAAAT",
        "AAAAAAAAAERXaGV0aGVyIGBzZW5kYCBpcyBjdXJyZW50bHkgcGF1c2VkLiBSZWFkIGJ5IHRoZSBiYWNrZW5kIHN0YXR1cyBmbGFnLgAAAA5pc19zZW5kX3BhdXNlZAAAAAAAAAAAAAEAAAAB",
        "AAAAAAAAAHxTdG9yYWdlIGxheW91dCB2ZXJzaW9uIGluIGVmZmVjdCAoaXNzdWUgIzE4NCkuIGAxYCA9IGxlZ2FjeSBpbnN0YW5jZQpsYXlvdXQsIGAyYCA9IGd1YXJkaWFucy9wcm9wb3NhbCBpbiBwZXJzaXN0ZW50IHN0b3JhZ2UuAAAADnN0b3JhZ2VfbGF5b3V0AAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAKhMZWdhY3kgc2luZ2xlLXN0ZXAgYWRtaW4gdHJhbnNmZXIuCgpEZXByZWNhdGVkIGluIGZhdm9yIG9mIGBwcm9wb3NlX2FkbWluYCArIGBhY2NlcHRfYWRtaW5gLgoKIyBFcnJvcnMKKiBbYFdhbGxldEVycm9yOjpOb3RJbml0aWFsaXplZGBdIC8gW2BXYWxsZXRFcnJvcjo6VW5hdXRob3JpemVkYF0AAAAOdHJhbnNmZXJfYWRtaW4AAAAAAAIAAAAAAAAAB2N1cnJlbnQAAAAAEwAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAfQAAAAC1dhbGxldEVycm9yAA==",
        "AAAAAAAAA4dUaGUgY3VycmVudCBhZG1pbiBjYW5jZWxzIGEgcGVuZGluZyByZWNvdmVyeS4KCiMjIFJlc3RyaWN0ZWQgY2FuY2VsIHdpbmRvdyAoaXNzdWUgIzE3NSkKUmVjb3ZlcnkgZXhpc3RzIGZvciB0aGUgY2FzZSB3aGVyZSB0aGUgYWRtaW4ga2V5IGlzIGxvc3QgKm9yCmNvbXByb21pc2VkKi4gQW4gdW5yZXN0cmljdGVkIGFkbWluIGNhbmNlbCBsZXQgYSBob3N0aWxlIGFkbWluIHN0YWxsCmV2ZXJ5IHJlY292ZXJ5IGZvcmV2ZXIsIHNvIGNhbmNlbGxhdGlvbiBpcyBub3cgbGltaXRlZDoKKiBCZWZvcmUgcXVvcnVtIGlzIHJlYWNoZWQgdGhlIGFkbWluIG1heSBhbHdheXMgY2FuY2VsLgoqIEFmdGVyIHF1b3J1bSB0aGUgYWRtaW4gbWF5IGNhbmNlbCBvbmx5IGR1cmluZyB0aGUgZmlyc3QgaGFsZiBvZiB0aGUKdGltZWxvY2sgKGByZWFkeV9hdCAtIGRlbGF5X2luX2xlZGdlcnMgLyAyYCksIGdpdmluZyBhIGxlZ2l0aW1hdGUKYWRtaW4gdGltZSB0byBvYmplY3QgdG8gYSBjb2xsdWRpbmcgbWFqb3JpdHkgd2l0aG91dCBsZXR0aW5nIGEKY29tcHJvbWlzZWQgb25lIGZyb250LXJ1biBgZXhlY3V0ZV9yZWNvdmVyeWAgYXQgdGhlIGxhc3QgbGVkZ2VyLgoqIE9uY2UgYXBwcm92YWxzIHJlYWNoIGEgZ3VhcmRpYW4gc3VwZXJtYWpvcml0eSAoYXQgbGVhc3QgdHdvIHRoaXJkcwpvZiB0aGUgZ3VhcmRpYW4gc2V0KSB0aGUgYWRtaW4gY2FuIG5vIGxvbmdlciBjYW5jZWwgYXQgYWxsIOKAlCB0aGUKc3VwZXJtYWpvcml0eSBvdmVycmlkZXMgdGhlIGFkbWluIGtleS4KCiMgRXJyb3JzCiogW2BXYWxsZXRFcnJvcjo6Tm9QZW5kaW5nUmVjb3ZlcnlgXQoqIFtgV2FsbGV0RXJyb3I6OlJlY292ZXJ5Q2FuY2VsTm90QWxsb3dlZGBdIOKAlCB3aW5kb3cgY2xvc2VkIG9yCnN1cGVybWFqb3JpdHkgcmVhY2hlZC4AAAAAD2NhbmNlbF9yZWNvdmVyeQAAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAAAABABFeGVjdXRlIGEgcHJldmlvdXNseSBwcm9wb3NlZCB1cGdyYWRlIGFmdGVyIHRoZSB0aW1lbG9jayBlbGFwc2VzLgoKVGhpcyBmdW5jdGlvbiB2YWxpZGF0ZXMgdGhhdDoKMS4gQSBwcm9wb3NhbCBleGlzdHMgYW5kIGlzIHN0b3JlZCBpbiBpbnN0YW5jZSBzdG9yYWdlCjIuIFRoZSBwcm92aWRlZCBgd2FzbV9oYXNoYCBtYXRjaGVzIHRoZSBwcm9wb3NlZCBoYXNoICh2aWEgZXF1YWxpdHkgY2hlY2spCjMuIFRoZSBjdXJyZW50IGxlZGdlciBzZXF1ZW5jZSBoYXMgcmVhY2hlZCBvciBleGNlZWRlZCBgcmVhZHlfYXRgICh0aW1lbG9jayBlbGFwc2VkKQo0LiBUaGUgYHdhc21faGFzaGAgd2FzIHByZXZpb3VzbHkgcmVnaXN0ZXJlZCBvbi1jaGFpbiB2aWEgW2BFbnY6OmRlcGxveWVyKCkudXBsb2FkX2NvbnRyYWN0X3dhc20oKWBdCgojIEVycm9ycwoqIFtgV2FsbGV0RXJyb3I6OlVwZ3JhZGVOb3RQZW5kaW5nYF0g4oCUIG5vIHBlbmRpbmcgdXBncmFkZSBwcm9wb3NhbAoqIFtgV2FsbGV0RXJyb3I6OlVwZ3JhZGVIYXNoTWlzbWF0Y2hgXSDigJQgcHJvdmlkZWQgaGFzaCBkb2Vzbid0IG1hdGNoIHN0b3JlZCBwcm9wb3NhbAoqIFtgV2FsbGV0RXJyb3I6OlVwZ3JhZGVOb3RSZWFkeWBdIOKAlCB0aW1lbG9jayBoYXMgbm90IHlldCBlbGFwc2VkCiogW2BXYWxsZXRFcnJvcjo6VXBncmFkZVdhc21Ob3RVcGxvYWRlZGBdIOKAlCB3YXNtIGhhc2ggd2FzIG5ldmVyIHJlZ2lzdGVyZWQgb24tY2hhaW4KCiMgT3BlcmF0aW9uYWwgTm90ZXMKQ29ycmVjdCB1cGdyYWRlIHNlcXVlbmNlIGlzOgoxLiBVcGxvYWQgbmV3IGNvbnRyYWN0IFdBU00gdmlhIGEgc2VwYXJhdGUgdHJhbnNhY3Rpb24g4oaSIG9idGFpbiB3YXNtX2hhc2gKMi4gQ2FsbCBgcHJvcG9zZV91cGdyYWRlYCB3aXRoIHRoYXQgaGFzaCBhbmQgZGVzaXJlZCBkZWxheQozLiBXYWl0IGZvciB0aGUgZGVsYXkgKGluIGxlZGdlcnMpIHRvIGVsYXBzZQo0LiBDYWxsIGBleGVjdXRlX3VwZ3JhZGVgIHdpdGggdGhlIHNhbWUgaGFzaAoKSWYgYSBXQVNNIGJsb2IgAAAAD2V4ZWN1dGVfdXBncmFkZQAAAAACAAAAAAAAAAhleGVjdXRvcgAAABMAAAAAAAAACXdhc21faGFzaAAAAAAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAAAAAHxLZWVwIGEgdXNlcidzIGVudHJpZXMgYWxpdmUgKGlzc3VlICMxODUpLiBQZXJtaXNzaW9ubGVzcyBzbyBhIGtlZXBlcgpjYW4gcGF5IGZvciBpdC4gUmV0dXJucyBob3cgbWFueSBlbnRyaWVzIHdlcmUgZXh0ZW5kZWQuAAAAD2V4dGVuZF91c2VyX3R0bAAAAAABAAAAAAAAAAR1c2VyAAAAEwAAAAEAAAAE",
        "AAAAAAAAAH5FZmZlY3RpdmUgZGFpbHkgY2FwIGZvciAodXNlciwgdG9rZW4pOyAwID0gdW5saW1pdGVkLiBQYW5pY3Mgd2l0aApgU3BlbmRMaW1pdEFyY2hpdmVkYCBpZiB0aGUgbGltaXQgd2FzIGFyY2hpdmVkIChpc3N1ZSAjMTg1KS4AAAAAAA9nZXRfc3BlbmRfbGltaXQAAAAAAgAAAAAAAAAEdXNlcgAAABMAAAAAAAAACHRva2VuX2lkAAAAEwAAAAEAAAAL",
        "AAAAAAAAAClBbW91bnQgc3BlbnQgaW4gdGhlIHRyYWlsaW5nIDI0IGggd2luZG93LgAAAAAAAA9nZXRfc3BlbnRfdG9kYXkAAAAAAgAAAAAAAAAEdXNlcgAAABMAAAAAAAAACHRva2VuX2lkAAAAEwAAAAEAAAAL",
        "AAAAAAAAACxSZXR1cm4gdGhlIHBlbmRpbmcgdXBncmFkZSBwcm9wb3NhbCwgaWYgYW55LgAAAA9wZW5kaW5nX3VwZ3JhZGUAAAAAAAAAAAEAAAPoAAAH0AAAAA9VcGdyYWRlUHJvcG9zYWwA",
        "AAAAAAAAA5NRdWV1ZSBhbiB1cGdyYWRlIGZvciBsYXRlciBleGVjdXRpb24uCgpUaGUgcHJvcG9zYWwgaXMgc3RvcmVkIGluIGNvbnRyYWN0IGluc3RhbmNlIHN0b3JhZ2UgYW5kIGVtaXR0ZWQgYXMgYW4KZXZlbnQgc28gdGhlIHVwZ3JhZGUgaXMgdmlzaWJsZSBvbi1jaGFpbiBiZWZvcmUgYW55IGNvZGUgc3dhcCBvY2N1cnMuCgpUaGUgcHJvdmlkZWQgYHdhc21faGFzaGAgaXMgc3RvcmVkIGFzLWlzICp3aXRob3V0IHZhbGlkYXRpb24qIOKAlCBpdCBpcwp0aGUgY2FsbGVyJ3MgcmVzcG9uc2liaWxpdHkgdG8gZW5zdXJlIGl0IG1hdGNoZXMgYSBibG9iIHByZXZpb3VzbHkgdXBsb2FkZWQKb24tY2hhaW4gdmlhIFtgRW52OjpkZXBsb3llcigpLnVwbG9hZF9jb250cmFjdF93YXNtKClgXS4gTm8gcHJlLWNoZWNrIGlzCnBlcmZvcm1lZCBoZXJlOyB2YWxpZGF0aW9uIG9jY3VycyB3aGVuIGBleGVjdXRlX3VwZ3JhZGVgIGlzIGNhbGxlZC4KCiMgRXJyb3JzCiogW2BXYWxsZXRFcnJvcjo6VXBncmFkZUFscmVhZHlQZW5kaW5nYF0g4oCUIGFuIHVwZ3JhZGUgaXMgYWxyZWFkeSBxdWV1ZWQKKiBbYFdhbGxldEVycm9yOjpVbmF1dGhvcml6ZWRgXSDigJQgY2FsbGVyIGlzIG5laXRoZXIgdGhlIGFkbWluIG5vciBhCltgUm9sZTo6VXBncmFkZXJgXSBob2xkZXIgKGlzc3VlICMxOTApCiogW2BXYWxsZXRFcnJvcjo6VXBncmFkZURlbGF5VG9vU2hvcnRgXSDigJQgYGRlbGF5X2luX2xlZGdlcnNgIGlzIGJlbG93CltgU2VsZjo6TUlOX1VQR1JBREVfREVMQVlfTEVER0VSU2BdIChzZWUgaXNzdWUgIzg0KQoKU2VlIFtgU2VsZjo6ZXhlY3V0ZV91cGdyYWRlYF0gZm9yIG9wZXJhdGlvbmFsIG5vdGVzIGFuZCB0aGUgY29ycmVjdApzZXF1ZW5jZSBvZiBzdGVwcyAodXBsb2FkIOKGkiBwcm9wb3NlIOKGkiB3YWl0IOKGkiBleGVjdXRlKS4AAAAAD3Byb3Bvc2VfdXBncmFkZQAAAAADAAAAAAAAAAhwcm9wb3NlcgAAABMAAAAAAAAACXdhc21faGFzaAAAAAAAA+4AAAAgAAAAAAAAABBkZWxheV9pbl9sZWRnZXJzAAAABAAAAAEAAAPpAAAD7QAAAAAAAAfQAAAAC1dhbGxldEVycm9yAA==",
        "AAAAAAAAADJSZXR1cm4gdGhlIGN1cnJlbnQgcmVjb3ZlcnkgY29uZmlndXJhdGlvbiwgaWYgYW55LgAAAAAAD3JlY292ZXJ5X2NvbmZpZwAAAAAAAAAAAQAAA+gAAAfQAAAADlJlY292ZXJ5Q29uZmlnAAA=",
        "AAAAAAAAAz9SZW1vdmUgYSBndWFyZGlhbi4gQWRtaW4tYXV0aG9yaXplZC4KClNhbWUgZnJlZXplL3RpbWVsb2NrIHJ1bGVzIGFzIFtgU2VsZjo6YWRkX2d1YXJkaWFuYF0gKGlzc3VlICMxNzUpOgppbW1lZGlhdGUgYmVmb3JlIHJlY292ZXJ5IGlzIGNvbmZpZ3VyZWQsIHF1ZXVlZCBmb3IKYFJlY292ZXJ5Q29uZmlnLmRlbGF5X2luX2xlZGdlcnNgIGFmdGVyd2FyZHMsIGFuZCByZWplY3RlZCB3aGlsZSBhCnJlY292ZXJ5IHByb3Bvc2FsIGlzIHBlbmRpbmcuIEJlY2F1c2UgdGhlIHNldCBpcyBmcm96ZW4gZHVyaW5nIGEKcmVjb3ZlcnksIGEgcmVtb3ZhbCBjYW4gbm8gbG9uZ2VyIHN0cmlwIGFwcHJvdmFscyBmcm9tIGFuIGluLWZsaWdodApwcm9wb3NhbCDigJQgdGhlIGFwcHJvdmFsLXN0cmlwcGluZyBwYXRoIGZyb20gaXNzdWUgIzI2IGlzIHVucmVhY2hhYmxlCmFuZCB3YXMgcmVtb3ZlZDsgYHJlcXVpcmVfZ3VhcmRpYW5gIHN0aWxsIHN0b3BzIGEgcmVtb3ZlZCBndWFyZGlhbgpmcm9tIGFjdGluZyBvbiBhbnkgKmxhdGVyKiBwcm9wb3NhbC4KCiMgRXJyb3JzCiogW2BXYWxsZXRFcnJvcjo6R3VhcmRpYW5Ob3RGb3VuZGBdCiogW2BXYWxsZXRFcnJvcjo6Tm90RW5vdWdoR3VhcmRpYW5zYF0g4oCUIHdvdWxkIGRyb3AgdGhlIGd1YXJkaWFuIGNvdW50CmJlbG93IHRoZSBjb25maWd1cmVkIHJlY292ZXJ5IHRocmVzaG9sZC4KKiBbYFdhbGxldEVycm9yOjpSZWNvdmVyeUFscmVhZHlQZW5kaW5nYF0g4oCUIGd1YXJkaWFuIHNldCBpcyBmcm96ZW4uCiogW2BXYWxsZXRFcnJvcjo6R3VhcmRpYW5DaGFuZ2VQZW5kaW5nYF0g4oCUIGFub3RoZXIgY2hhbmdlIGlzIHF1ZXVlZC4AAAAAD3JlbW92ZV9ndWFyZGlhbgAAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAACGd1YXJkaWFuAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAfQAAAAC1dhbGxldEVycm9yAA==",
        "AAAAAAAABABTZXQgYSByb2xsaW5nIDI0IGggc3BlbmQgbGltaXQgKGluIHN0cm9vcHMpIGZvciBhIHNwZWNpZmljIGFzc2V0LgoKYGxpbWl0ID0gMGAgcmVtb3ZlcyB0aGUgbGltaXQgKHVubGltaXRlZCkuCgojIyBEZWNyZWFzZXMgYXJlIGltbWVkaWF0ZSwgaW5jcmVhc2VzIGFyZSBkZWxheWVkIChpc3N1ZSAjMTc2KQpTcGVuZCBsaW1pdHMgZXhpc3QgdG8gY2FwIHRoZSBsb3NzIGZyb20gYSBjb21wcm9taXNlZCB1c2VyIGtleSwgYW5kCnRoYXQgc2FtZSBrZXkgaXMgYWxsIGBzZXRfc3BlbmRfbGltaXRgIHJlcXVpcmVzLiBTbzoKKiBhICoqZGVjcmVhc2UqKiAoYW55IG5vbi16ZXJvIGxpbWl0IGA8PWAgdGhlIGN1cnJlbnQgZWZmZWN0aXZlIGxpbWl0LApvciBhbnkgbm9uLXplcm8gbGltaXQgd2hlbiBjdXJyZW50bHkgdW5saW1pdGVkKSB0YWtlcyBlZmZlY3QgYXQgb25jZQphbmQgZGlzY2FyZHMgYW55IHF1ZXVlZCBpbmNyZWFzZTsKKiBhbiAqKmluY3JlYXNlKiogKG9yIGEgc3dpdGNoIHRvIHVubGltaXRlZCkgaXMgc3RvcmVkIGFzIGEKW2BQZW5kaW5nU3BlbmRMaW1pdGBdIHRoYXQgb25seSB0YWtlcyBlZmZlY3QKW2BTUEVORF9MSU1JVF9JTkNSRUFTRV9ERUxBWV9TRUNTYF0gbGF0ZXIsIGVtaXR0aW5nCmBzcGVuZF9saW1pdF9pbmNyZWFzZV9wZW5kaW5nYCBzbyB0aGUgYmFja2VuZCBjYW4gYWxlcnQgdGhlIG93bmVyLAp3aG8gY2FuIGNhbGwgYGNhbmNlbF9wZW5kaW5nX3NwZW5kX2xpbWl0YCAoYXMgY2FuIGFueSBndWFyZGlhbikuClNwZW5kcyBhYm92ZSB0aGUgb2xkIGxpbWl0IGtlZXAgZmFpbGluZyB1bnRpbCB0aGUgZGVsYXkgZWxhcHNlcy4KCioqUmV0cm9hY3RpdmUgZW5mb3JjZW1lbnQ6KiogaWYgdGhlIHVzZXIgaGFzIGFscmVhZHkgc3BlbnQgbW9yZSB0aGFuCmEgcHJvcG9zZWQgbG93ZXIgbGltaXQgaW4gdGhlIGN1cnJlbnQgZGF5IHdpbmRvdywgdGhlIGNhbGwgaXMgcmVqZWN0ZWQKd2l0aCBgU3BlbmRMaW1pdEV4Y2VlZGVkYC4KCiMgRXJyb3JzCiogW2BXYWxsZXRFcnJvcjo6SW52YWxpAAAAD3NldF9zcGVuZF9saW1pdAAAAAADAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAIdG9rZW5faWQAAAATAAAAAAAAAAVsaW1pdAAAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAAAAALJBIGd1YXJkaWFuIGFwcHJvdmVzIHRoZSBwZW5kaW5nIHJlY292ZXJ5IHByb3Bvc2FsLgoKT25jZSBhcHByb3ZhbHMgcmVhY2ggdGhlIGNvbmZpZ3VyZWQgdGhyZXNob2xkLCB0aGUgdGltZWxvY2sgaXMKYXJtZWQ6IGByZWFkeV9hdCA9IGN1cnJlbnRfbGVkZ2VyX3NlcXVlbmNlICsgZGVsYXlfaW5fbGVkZ2Vyc2AuAAAAAAAQYXBwcm92ZV9yZWNvdmVyeQAAAAEAAAAAAAAACGd1YXJkaWFuAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAfQAAAAC1dhbGxldEVycm9yAA==",
        "AAAAAAAABABFeGVjdXRlIGEgcmVjb3Zlcnkgb25jZSBxdW9ydW0gaGFzIGJlZW4gcmVhY2hlZCBhbmQgdGhlIHRpbWVsb2NrIGhhcwplbGFwc2VkLiBDYWxsYWJsZSBieSBhbnlvbmUgKHR5cGljYWxseSBhIGd1YXJkaWFuIG9yIHRoZSBuZXcgYWRtaW4KY2FuZGlkYXRlKSDigJQgYXV0aG9yaXphdGlvbiBjb21lcyBlbnRpcmVseSBmcm9tIHRoZSBndWFyZGlhbgpzaWduYXR1cmVzIGFscmVhZHkgcmVjb3JkZWQgb24gdGhlIHByb3Bvc2FsLCBub3QgZnJvbSB0aGUgY2FsbGVyLgoKRGVsaWJlcmF0ZWx5IGRvZXMgKipub3QqKiBjYWxsIGByZXF1aXJlX2FkbWluYC9gY3VycmVudC5yZXF1aXJlX2F1dGgoKWA6CnRoYXQgaXMgcHJlY2lzZWx5IHRoZSBjYXBhYmlsaXR5IHRoYXQgaXMgdW5hdmFpbGFibGUgd2hlbiBhIGRldmljZSBpcwpsb3N0LiBSZS1jaGVja3MgcXVvcnVtIGF0IGV4ZWN1dGlvbiB0aW1lIChub3QganVzdCBhdApgYXBwcm92ZV9yZWNvdmVyeWAgdGltZSkgaW4gY2FzZSBhIGd1YXJkaWFuIHJldm9rZWQgYmV0d2VlbiBxdW9ydW0KYW5kIHRpbWVsb2NrIGV4cGlyeSBpbiBhIHdheSB0aGlzIGNvbnRyYWN0IGRpZG4ndCBvYnNlcnZlIChkZWZlbnNlIGluCmRlcHRoOyBgcmV2b2tlX3JlY292ZXJ5X2FwcHJvdmFsYCBhbHJlYWR5IGNsZWFycyBgcmVhZHlfYXRgLCBidXQgdGhpcwpndWFyZHMgYWdhaW5zdCBhbnkgZnV0dXJlIGNvZGUgcGF0aCB0aGF0IGZvcmdldHMgdG8pLgoKQW55IGluLWZsaWdodCAqbm9ybWFsKiBgcHJvcG9zZV9hZG1pbmAvYGFjY2VwdF9hZG1pbmAgdHJhbnNmZXIgaXMKY2FuY2VsbGVkIGFzIHBhcnQgb2YgZXhlY3V0aW5nIGEgcmVjb3ZlcnksIHNvIHRoZSB0d28gZmxvd3MgY2FuJ3QgcmFjZS4KCiMgRXZlbnRzIChzZWUgaXNzdWUgIzkxKQpQdWJsaXNoZXMgKip0d28qKiBldmVudHMsIGRlbGliZXJhdGVseSwgbm90IG9uZToKMS4gYGFkbWluX3RyYW5zZmVycmVkYCDigJQgaWRlbnRpY2FsIHRvcGljIGFuZCBwYXlsb2FkIHNoYXBlIHRvIHdoYXQKYGFjY2VwdF9hZG1pbmAgcHViAAAAEGV4ZWN1dGVfcmVjb3ZlcnkAAAAAAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAAAAAD9SZXR1cm5zIHdoZXRoZXIgYHRva2VuX2lkYCBpcyBjdXJyZW50bHkgYWxsb3dsaXN0ZWQgZm9yIGBzZW5kYC4AAAAAEGlzX3Rva2VuX2FsbG93ZWQAAAABAAAAAAAAAAh0b2tlbl9pZAAAABMAAAABAAAAAQ==",
        "AAAAAQAAAIdBIHF1ZXVlZCBndWFyZGlhbiBhZGRpdGlvbiBvciByZW1vdmFsICgjMTc1KS4gQXBwbGllZCBieQpgYXBwbHlfZ3VhcmRpYW5fY2hhbmdlYCBvbmNlIGByZWFkeV9hdGAgaXMgcmVhY2hlZCBhbmQgbm8gcmVjb3ZlcnkgaXMKcGVuZGluZy4AAAAAAAAAAA5HdWFyZGlhbkNoYW5nZQAAAAAAAwAAAB9gdHJ1ZWAgPSBhZGQsIGBmYWxzZWAgPSByZW1vdmUuAAAAAANhZGQAAAAAAQAAAAAAAAAIZ3VhcmRpYW4AAAATAAAANUxlZGdlciBzZXF1ZW5jZSBmcm9tIHdoaWNoIHRoZSBjaGFuZ2UgbWF5IGJlIGFwcGxpZWQuAAAAAAAACHJlYWR5X2F0AAAABA==",
        "AAAAAQAAAAAAAAAAAAAADlJlY292ZXJ5Q29uZmlnAAAAAAACAAAAr0xlZGdlci1jb3VudCBkZWxheSBiZXR3ZWVuIHJlYWNoaW5nIHF1b3J1bSBhbmQgYGV4ZWN1dGVfcmVjb3ZlcnlgCmJlY29taW5nIGNhbGxhYmxlLiBHaXZlcyB0aGUgbGVnaXRpbWF0ZSBhZG1pbiBhIHdpbmRvdyB0byBub3RpY2UKYW5kIGNhbmNlbCBhIG1hbGljaW91cyBvciBtaXN0YWtlbiByZWNvdmVyeS4AAAAAEGRlbGF5X2luX2xlZGdlcnMAAAAEAAAAP051bWJlciBvZiBkaXN0aW5jdCBndWFyZGlhbiBhcHByb3ZhbHMgcmVxdWlyZWQgdG8gcmVhY2ggcXVvcnVtLgAAAAAJdGhyZXNob2xkAAAAAAAABA==",
        "AAAAAQAAAMtSZWFkLW9ubHkgdmlldyBvZiBhIHVzZXIncyByb2xsaW5nIDI0IGggc3BlbmQgd2luZG93IGZvciBvbmUgYXNzZXQsCnJldHVybmVkIGJ5IFtgR2xvYmVXYWxsZXQ6OmdldF9zcGVuZF9hbGxvd2FuY2VgXSAoaXNzdWVzICM1MCwgIzE3NykuCgpUaW1lcyBhcmUgbGVkZ2VyIHRpbWVzdGFtcHMgKFVuaXggc2Vjb25kcywgYnkgbGVkZ2VyIGNsb3NlIHRpbWUpLgAAAAAAAAAADlNwZW5kQWxsb3dhbmNlAAAAAAAGAAAAJUNvbmZpZ3VyZWQgZGFpbHkgY2FwICgwID0gdW5saW1pdGVkKS4AAAAAAAAFbGltaXQAAAAAAAALAAAAX1doZW4gdGhlIG9sZGVzdCBjb3VudGVkIGJ1Y2tldCByb2xscyBvZmYgYW5kIGByZW1haW5pbmdgIG5leHQgZ3Jvd3MuCjAgd2hlbiBub3RoaW5nIGlzIGNvdW50ZWQuAAAAAA5uZXh0X3JlZmlsbF9hdAAAAAAABgAAAIFgbGltaXQgLSBzcGVudGAsIGZsb29yZWQgYXQgMC4gMCB3aGVuIGBsaW1pdCA9PSAwYCDigJQgY2FsbGVycyBtdXN0CmNoZWNrIGBsaW1pdGAgdG8gZGlzdGluZ3Vpc2ggInVubGltaXRlZCIgZnJvbSAibm90aGluZyBsZWZ0Ii4AAAAAAAAJcmVtYWluaW5nAAAAAAAACwAAAH1BbW91bnQgc3BlbnQgaW4gdGhlIHJvbGxpbmcgd2luZG93LiBUcmFja2VkIGV2ZW4gd2hlbiBgbGltaXQgPT0gMGAKKGlzc3VlICMxNzkpLCBzbyB0dXJuaW5nIGEgbGltaXQgb24gbGF0ZXIgYWNjb3VudHMgZm9yIGl0LgAAAAAAAAVzcGVudAAAAAAAAAsAAACFV2hlbiBldmVyeSBzcGVuZCBjdXJyZW50bHkgY291bnRlZCB3aWxsIGhhdmUgcm9sbGVkIG9mZiAoYHNwZW50YApyZWFjaGVzIDAgaWYgbm90aGluZyBlbHNlIGlzIHNwZW50KS4gRXF1YWxzICJub3ciIHdoZW4gYHNwZW50ID09IDBgLgAAAAAAABB3aW5kb3dfcmVzZXRzX2F0AAAABgAAADtTdGFydCBvZiB0aGUgb2xkZXN0IGhvdXJseSBidWNrZXQgc3RpbGwgY291bnRlZCBpbiBgc3BlbnRgLgAAAAAMd2luZG93X3N0YXJ0AAAABg==",
        "AAAAAAAAAElSZXR1cm5zIHRoZSBjdXJyZW50bHkgY29uZmlndXJlZCB0b2tlbi13cmFwcGVyIGNvbnRyYWN0IGluc3RhbmNlLCBpZiBhbnkuAAAAAAAAEWdldF90b2tlbl93cmFwcGVyAAAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAP1BIGd1YXJkaWFuIGluaXRpYXRlcyBhIHJlY292ZXJ5IHRvIGBuZXdfYWRtaW5gLiBDb3VudHMgYXMgdGhhdApndWFyZGlhbidzIG93biBhcHByb3ZhbC4KCiMgRXJyb3JzCiogW2BXYWxsZXRFcnJvcjo6UmVjb3ZlcnlOb3RDb25maWd1cmVkYF0KKiBbYFdhbGxldEVycm9yOjpVbmF1dGhvcml6ZWRgXSDigJQgY2FsbGVyIGlzIG5vdCBhIHJlZ2lzdGVyZWQgZ3VhcmRpYW4uCiogW2BXYWxsZXRFcnJvcjo6UmVjb3ZlcnlBbHJlYWR5UGVuZGluZ2BdAAAAAAAAEWluaXRpYXRlX3JlY292ZXJ5AAAAAAAAAgAAAAAAAAAIZ3VhcmRpYW4AAAATAAAAAAAAAAluZXdfYWRtaW4AAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAAAAADxgdHJ1ZWAgd2hlbiBhIGxpbWl0IHdhcyBzZXQgYnV0IGl0cyBlbnRyeSBoYXMgYmVlbiBhcmNoaXZlZC4AAAARaXNfbGltaXRfYXJjaGl2ZWQAAAAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAIdG9rZW5faWQAAAATAAAAAQAAAAE=",
        "AAAAAAAAAC1SZXR1cm4gdGhlIHBlbmRpbmcgcmVjb3ZlcnkgcHJvcG9zYWwsIGlmIGFueS4AAAAAAAARcmVjb3ZlcnlfcHJvcG9zYWwAAAAAAAAAAAAAAQAAA+gAAAfQAAAAEFJlY292ZXJ5UHJvcG9zYWw=",
        "AAAAAAAAAEFBZG1pbjogc2V0IHRoZSB0b2tlbi13cmFwcGVyIGNvbnRyYWN0IGluc3RhbmNlIGBzZW5kYCBjYWxscyBpbnRvLgAAAAAAABFzZXRfdG9rZW5fd3JhcHBlcgAAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAQdG9rZW5fd3JhcHBlcl9pZAAAABMAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAQAAAAAAAAAAAAAAD1VwZ3JhZGVQcm9wb3NhbAAAAAADAAAAAAAAAAtwcm9wb3NlZF9ieQAAAAATAAAAAAAAAAhyZWFkeV9hdAAAAAQAAAAAAAAACXdhc21faGFzaAAAAAAAA+4AAAAg",
        "AAAAAAAAAERSZXR1cm4gdGhlIHZlcmlmaWVkIGFzc2V0IG1ldGFkYXRhIHN0b3JlZCB3aXRoIGFuIGFsbG93bGlzdGVkIHRva2VuLgAAABJhbGxvd2VkX3Rva2VuX2luZm8AAAAAAAEAAAAAAAAACHRva2VuX2lkAAAAEwAAAAEAAAPoAAAH0AAAABBBbGxvd2VkVG9rZW5JbmZv",
        "AAAAAAAAADhSZXR1cm4gdGhlIGxpc3Qgb2YgYWxsIGFsbG93ZWQgdG9rZW4gY29udHJhY3QgYWRkcmVzc2VzLgAAABJnZXRfYWxsb3dlZF90b2tlbnMAAAAAAAAAAAABAAAD6gAAABM=",
        "AAAAAQAAAAAAAAAAAAAAEEFsbG93ZWRUb2tlbkluZm8AAAADAAAAAAAAAAphc3NldF9jb2RlAAAAAAAQAAAAAAAAAAppc3N1ZXJfa2V5AAAAAAfQAAAACUlzc3VlcktleQAAAAAAAAAAAAAIdG9rZW5faWQAAAAT",
        "AAAAAQAAAAAAAAAAAAAAEFJlY292ZXJ5UHJvcG9zYWwAAAADAAAAAAAAAAlhcHByb3ZhbHMAAAAAAAPqAAAAEwAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAI1TZXQgb25jZSBxdW9ydW0gaXMgZmlyc3QgcmVhY2hlZDsgY2xlYXJlZCBhZ2FpbiBpZiBhcHByb3ZhbHMgZHJvcApiYWNrIGJlbG93IHRocmVzaG9sZC4gYGV4ZWN1dGVfcmVjb3ZlcnlgIHJlcXVpcmVzIGBsZWRnZXIgc2VxID49IHJlYWR5X2F0YC4AAAAAAAAIcmVhZHlfYXQAAAPoAAAABA==",
        "AAAAAQAAABNAZXZlbnQgcm9sZV9ncmFudGVkAAAAAAAAAAAQUm9sZUdyYW50ZWRFdmVudAAAAAMAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAAKZ3JhbnRlZF9ieQAAAAAAEwAAAAAAAAAEcm9sZQAAB9AAAAAEUm9sZQ==",
        "AAAAAQAAABNAZXZlbnQgcm9sZV9yZXZva2VkAAAAAAAAAAAQUm9sZVJldm9rZWRFdmVudAAAAAMAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAAKcmV2b2tlZF9ieQAAAAAAEwAAAAAAAAAEcm9sZQAAB9AAAAAEUm9sZQ==",
        "AAAAAAAAAEJMaW1pdCwgc3BlbmQgYW5kIHJlZmlsbCB0aW1lcyBmb3IgdGhlIHJvbGxpbmcgd2luZG93IChpc3N1ZSAjMTc3KS4AAAAAABNnZXRfc3BlbmRfYWxsb3dhbmNlAAAAAAIAAAAAAAAABHVzZXIAAAATAAAAAAAAAAh0b2tlbl9pZAAAABMAAAABAAAH0AAAAA5TcGVuZEFsbG93YW5jZQAA",
        "AAAAAAAAALdBZG1pbjogbW92ZSBhIGxlZ2FjeSBgKHVzZXIsIGFzc2V0X2NvZGUpYCBsaW1pdCBhbmQgc3BlbmQgcmVjb3JkIG9udG8KdGhlIHRva2VuLWtleWVkIHN0b3JhZ2UgKGlzc3VlICMxNzMpLiBUaGUgc3RyaWN0ZXIgbGltaXQgd2lucy4KUmV0dXJucyBgZmFsc2VgIHdoZW4gdGhlcmUgd2FzIG5vdGhpbmcgdG8gbWlncmF0ZS4AAAAAE21pZ3JhdGVfc3BlbmRfbGltaXQAAAAABAAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAKYXNzZXRfY29kZQAAAAAAEAAAAAAAAAAIdG9rZW5faWQAAAATAAAAAQAAA+kAAAABAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAAAAArVBZG1pbiBhbmQgdXNlcjogdHJpbSBhIHVzZXIncyBhc3NldCBsaXN0IHRvIFtgR2xvYmVXYWxsZXQ6Ok1BWF9BU1NFVFNgXSBpZiBpdCBleGNlZWRzIHRoZSBib3VuZC4KUmV0dXJucyB0aGUgbnVtYmVyIG9mIGFzc2V0cyB0cmltbWVkICgwIGlmIGFscmVhZHkgd2l0aGluIGxpbWl0KS4KCk9ubHkgdGhlIGRpc3BsYXkgbGlzdCBpcyB0cmltbWVkLiBTcGVuZCBsaW1pdHMgYW5kIHNwZW5kIHdpbmRvd3Mgb2YKdHJpbW1lZCBhc3NldHMgYXJlIGtlcHQgYW5kIGtlZXAgYmVpbmcgZW5mb3JjZWQgKGlzc3VlICMxNzgpOyBvbmUKYCgibWlncmF0aW9uIiwgImFzc2V0X3VudHJhY2tlZCIpYCBldmVudCB3aXRoIGAodXNlciwgY29kZSwgbGltaXQpYAppcyBlbWl0dGVkIHBlciB0cmltbWVkIGFzc2V0LgoKIyBBdXRob3JpemF0aW9uIERlY2lzaW9uCkR1YWwgYXV0aG9yaXphdGlvbiBpcyByZXF1aXJlZDogYGFkbWluLnJlcXVpcmVfYXV0aCgpYCBlbnN1cmVzIG9ubHkgYW4KYWRtaW5pc3RyYXRvciBjYW4gaW5pdGlhdGUgYSBtaWdyYXRpb24sIHdoaWxlIGB1c2VyLnJlcXVpcmVfYXV0aCgpYApwcmVzZXJ2ZXMgdGhlIHNlbGYtc292ZXJlaWduIHByb3BlcnR5IG9mIHRoZSB3YWxsZXQgYnkgZW5zdXJpbmcgdGhlCnVzZXIgY29uc2VudHMgdG8gdGhlIGV4YWN0IGFzc2V0IGxpc3QgbW9kaWZpY2F0aW9uIHRha2luZyBwbGFjZS4AAAAAAAATbWlncmF0ZV91c2VyX2Fzc2V0cwAAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAABHVzZXIAAAATAAAAAQAAA+kAAAAEAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAAAAADVUaGUgcGVuZGluZyBsaW1pdCBpbmNyZWFzZSBmb3IgKHVzZXIsIHRva2VuKSwgaWYgYW55LgAAAAAAABNwZW5kaW5nX3NwZW5kX2xpbWl0AAAAAAIAAAAAAAAABHVzZXIAAAATAAAAAAAAAAh0b2tlbl9pZAAAABMAAAABAAAD6AAAB9AAAAARUGVuZGluZ1NwZW5kTGltaXQAAAA=",
        "AAAAAAAABABDb25maWd1cmUgKG9yIHJlY29uZmlndXJlKSB0aGUgTS1vZi1OIHJlY292ZXJ5IHRocmVzaG9sZCBhbmQgdGhlCnBvc3QtcXVvcnVtIHRpbWVsb2NrIGRlbGF5LiBBZG1pbi1hdXRob3JpemVkLgoKIyMgRGVzaWduIGRlY2lzaW9uOiByZWplY3RlZCB3aGlsZSBhIHJlY292ZXJ5IGlzIHBlbmRpbmcgKGlzc3VlICMyOCkKQSBgUmVjb3ZlcnlQcm9wb3NhbGAncyBgcmVhZHlfYXRgIGlzIGNvbXB1dGVkIG9uY2UsIGF0IHRoZSBtb21lbnQKcXVvcnVtIGlzIHJlYWNoZWQgaW4gYGFwcHJvdmVfcmVjb3ZlcnlgLCBhbmQgZnJvemVuIGludG8gc3RvcmFnZSDigJQKaXQgZG9lcyBub3QgcmV0cm9hY3RpdmVseSB0cmFjayBsYXRlciBgZGVsYXlfaW5fbGVkZ2Vyc2AgY2hhbmdlcy4KTWVhbndoaWxlIGBleGVjdXRlX3JlY292ZXJ5YCdzIHF1b3J1bSBjaGVjayByZWFkcyB0aGUgKmxpdmUqCmBSZWNvdmVyeUNvbmZpZy50aHJlc2hvbGRgLCBub3QgdGhlIGNvbmZpZyBpbiBlZmZlY3Qgd2hlbiBxdW9ydW0gd2FzCnJlYWNoZWQuIFRoYXQgaGFsZi1saXZlLCBoYWxmLWZyb3plbiBjb3VwbGluZyBpcyBjb25mdXNpbmcgZW5vdWdoCihhbmQgdW5kZXJ0ZXN0ZWQgZW5vdWdoIOKAlCBzZWUgIzI4KSB0aGF0IHRoZSBzYWZlciBkZXNpZ24gaXMgdG8KZGlzYWxsb3cgdGhlIGFtYmlndWl0eSBvdXRyaWdodDogd2hpbGUgYSBgUmVjb3ZlcnlQcm9wb3NhbGAgZXhpc3RzLApgc2V0X3JlY292ZXJ5X2NvbmZpZ2AgaXMgcmVqZWN0ZWQgd2l0aCBbYFdhbGxldEVycm9yOjpSZWNvdmVyeUFscmVhZHlQZW5kaW5nYF0uCkFuIGFkbWluIHdobyB3YW50cyB0byBjaGFuZ2UgdGhlIHRocmVzaG9sZC9kZWxheSB3aGlsZSBhIHJlY292ZXJ5IGlzCmluIGZsaWdodCBtdXN0IGZpcnN0IGNhbGwgYGNhbmNlbF9yZWNvdmVyeWAgKGlmIHJlYWNoYWJsZSkg4oCUIHRoZQphbHJlYWR5LWV4aXN0aW5nLCB1bmFtYmlndW91cyB3YXkgdG8gc3RvcCBhIHBlbmRpbmcgcHJvcG9zYWwg4oCUIHJhdGhlcgp0aGFuIG11dGF0ZSBjb25maWcgdW5kZXJuAAAAE3NldF9yZWNvdmVyeV9jb25maWcAAAAAAwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAEAAAAAAAAABBkZWxheV9pbl9sZWRnZXJzAAAABAAAAAEAAAPpAAAD7QAAAAAAAAfQAAAAC1dhbGxldEVycm9yAA==",
        "AAAAAQAAABRAZXZlbnQgcGF1c2VfY2hhbmdlZAAAAAAAAAARUGF1c2VDaGFuZ2VkRXZlbnQAAAAAAAACAAAAAAAAAApjaGFuZ2VkX2J5AAAAAAATAAAAAAAAAAZwYXVzZWQAAAAAAAE=",
        "AAAAAQAAAItBIHNwZW5kLWxpbWl0IGluY3JlYXNlIHdhaXRpbmcgb3V0IFtgU1BFTkRfTElNSVRfSU5DUkVBU0VfREVMQVlfU0VDU2BdCigjMTc2KS4gYGxpbWl0ID09IDBgIG1lYW5zIHRoZSBwZW5kaW5nIGNoYW5nZSBzd2l0Y2hlcyB0byB1bmxpbWl0ZWQuAAAAAAAAAAARUGVuZGluZ1NwZW5kTGltaXQAAAAAAAACAAAAP0xlZGdlciB0aW1lc3RhbXAgKFVuaXggc2Vjb25kcykgZnJvbSB3aGljaCBgbGltaXRgIGlzIGluIGZvcmNlLgAAAAAMZWZmZWN0aXZlX2F0AAAABgAAAAAAAAAFbGltaXQAAAAAAAAL",
        "AAAAAQAAABRAZXZlbnQgc2VuZF9leGVjdXRlZAAAAAAAAAARU2VuZEV4ZWN1dGVkRXZlbnQAAAAAAAAEAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAnRvAAAAAAATAAAAAAAAAAh0b2tlbl9pZAAAABMAAAAAAAAABHVzZXIAAAAT",
        "AAAAAQAAABRAZXZlbnQgdG9rZW5fYWxsb3dlZAAAAAAAAAARVG9rZW5BbGxvd2VkRXZlbnQAAAAAAAAEAAAAAAAAAAphc3NldF9jb2RlAAAAAAAQAAAAAAAAAAtleGVjdXRlZF9ieQAAAAATAAAAAAAAAAppc3N1ZXJfa2V5AAAAAAfQAAAACUlzc3VlcktleQAAAAAAAAAAAAAIdG9rZW5faWQAAAAT",
        "AAAAAAAAAEFBbGxvd2xpc3QgbWFuYWdlcjogZHJvcCBhIHBlbmRpbmcgcHJvcG9zYWwgYmVmb3JlIGl0IGlzIGV4ZWN1dGVkLgAAAAAAABRjYW5jZWxfYWxsb3dlZF90b2tlbgAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAIdG9rZW5faWQAAAATAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAAAAAKpBbGxvd2xpc3QgbWFuYWdlcjogcmVtb3ZlIGB0b2tlbl9pZGAgZnJvbSB0aGUgc2VuZC1hbGxvd2xpc3QuCgpSZW1vdmFsIGlzIGltbWVkaWF0ZSAobm8gdGltZWxvY2spIOKAlCBzaHJpbmtpbmcgdGhlIGFsbG93bGlzdCBjYW4gb25seQpyZWR1Y2Ugd2hhdCBgc2VuZGAgaXMgYWJsZSB0byBtb3ZlLgAAAAAAFHJlbW92ZV9hbGxvd2VkX3Rva2VuAAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAh0b2tlbl9pZAAAABMAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAAAAAflMYW5kIHRoZSBxdWV1ZWQgZ3VhcmRpYW4tc2V0IGNoYW5nZSBvbmNlIGl0cyB0aW1lbG9jayBoYXMgZWxhcHNlZAooaXNzdWUgIzE3NSkuIFBlcm1pc3Npb25sZXNzIOKAlCB0aGUgYWRtaW4gYXV0aG9yaXplZCB0aGUgY2hhbmdlIHdoZW4KcXVldWVpbmcgaXQ7IHRoZSBkZWxheSBpcyB0aGUgZ3VhcmRpYW5zJyB3aW5kb3cgdG8gcmVhY3QuIFZhbGlkYXRpb24KaXMgcmUtcnVuIGF0IGFwcGx5IHRpbWUgYmVjYXVzZSB0aGUgc2V0IG1heSBoYXZlIGNoYW5nZWQgbWVhbndoaWxlLgoKIyBFcnJvcnMKKiBbYFdhbGxldEVycm9yOjpOb1BlbmRpbmdHdWFyZGlhbkNoYW5nZWBdCiogW2BXYWxsZXRFcnJvcjo6R3VhcmRpYW5DaGFuZ2VOb3RSZWFkeWBdCiogW2BXYWxsZXRFcnJvcjo6UmVjb3ZlcnlBbHJlYWR5UGVuZGluZ2BdIOKAlCB0aGUgc2V0IGlzIGZyb3plbiB3aGlsZSBhCnJlY292ZXJ5IGlzIGluIGZsaWdodDsgYSBzdWNjZXNzZnVsIHJlY292ZXJ5IGRpc2NhcmRzIHRoZSBjaGFuZ2UuAAAAAAAAFWFwcGx5X2d1YXJkaWFuX2NoYW5nZQAAAAAAAAAAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAAAAACpDYW5jZWwgdGhlIGN1cnJlbnQgcGVuZGluZyBhZG1pbiBwcm9wb3NhbC4AAAAAABVjYW5jZWxfYWRtaW5fdHJhbnNmZXIAAAAAAAABAAAAAAAAAAdjdXJyZW50AAAAABMAAAABAAAD6QAAA+0AAAAAAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAAAAAQRBbGxvd2xpc3QgbWFuYWdlcjogZmluYWxpemUgYSBwcm9wb3NhbCBvbmNlIGl0cyB0aW1lbG9jayBlbGFwc2VkLgoKIyBFcnJvcnMKKiBbYFdhbGxldEVycm9yOjpVbmF1dGhvcml6ZWRgXSDigJQgY2FsbGVyIGxhY2tzIFtgUm9sZTo6QWxsb3dsaXN0TWFuYWdlcmBdCiogW2BXYWxsZXRFcnJvcjo6QWxsb3dsaXN0UHJvcG9zYWxOb3RGb3VuZGBdCiogW2BXYWxsZXRFcnJvcjo6QWxsb3dsaXN0Tm90UmVhZHlgXSDigJQgdGltZWxvY2sgc3RpbGwgcnVubmluZwAAABVleGVjdXRlX2FsbG93ZWRfdG9rZW4AAAAAAAACAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAAAAAACHRva2VuX2lkAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAfQAAAAC1dhbGxldEVycm9yAA==",
        "AAAAAAAAAEJSZXR1cm4gdGhlIHBlbmRpbmcgKHRpbWVsb2NrZWQpIGFsbG93bGlzdCBwcm9wb3NhbCBmb3IgYHRva2VuX2lkYC4AAAAAABVwZW5kaW5nX2FsbG93ZWRfdG9rZW4AAAAAAAABAAAAAAAAAAh0b2tlbl9pZAAAABMAAAABAAAD6AAAB9AAAAATUGVuZGluZ0FsbG93ZWRUb2tlbgA=",
        "AAAAAAAAA5VBbGxvd2xpc3QgbWFuYWdlcjogcHJvcG9zZSBgdG9rZW5faWRgIGZvciB0aGUgYHNlbmRgIGFsbG93bGlzdC4KClRoZSBjb250cmFjdCBvbmx5IGFjY2VwdHMgZ2VudWluZSBTdGVsbGFyIEFzc2V0IENvbnRyYWN0cyAoaXNzdWUKIzE4OSk6IGl0IHJlYnVpbGRzIHRoZSBjbGFzc2ljIGFzc2V0J3MgWERSIGZyb20gYGFzc2V0X2NvZGVgICsKYGlzc3Vlcl9rZXlgIChyYXcgZWQyNTUxOSBpc3N1ZXIga2V5OyBgTm9uZWAgPSBuYXRpdmUgWExNKSwgZGVyaXZlcyB0aGUKU0FDIGFkZHJlc3MgdGhlIG5ldHdvcmsgd291bGQgYXNzaWduIHRvIHRoYXQgYXNzZXQsIGFuZCByZWplY3RzIHRoZQpwcm9wb3NhbCB1bmxlc3MgaXQgZXF1YWxzIGB0b2tlbl9pZGAuIEEgY3VzdG9tIGNvbnRyYWN0IHRoYXQgbWVyZWx5CipjbGFpbXMqIHRvIGJlICJVU0RDIiBjYW4gbmV2ZXIgbWF0Y2gsIGJlY2F1c2UgYSBTQUMncyBhZGRyZXNzIGlzIGEKcHVyZSBmdW5jdGlvbiBvZiB0aGUgYXNzZXQgaXQgd3JhcHMuIFRoZSBhZGRpdGlvbiBvbmx5IHRha2VzIGVmZmVjdAphZnRlciBbYFNlbGY6OkFMTE9XTElTVF9ERUxBWV9MRURHRVJTYF0gdmlhIGBleGVjdXRlX2FsbG93ZWRfdG9rZW5gLgoKIyBFcnJvcnMKKiBbYFdhbGxldEVycm9yOjpVbmF1dGhvcml6ZWRgXSDigJQgY2FsbGVyIGxhY2tzIFtgUm9sZTo6QWxsb3dsaXN0TWFuYWdlcmBdCiogW2BXYWxsZXRFcnJvcjo6SW52YWxpZEFzc2V0Q29kZWBdIC8gW2BXYWxsZXRFcnJvcjo6SW52YWxpZEFzc2V0SW5mb2BdCiogW2BXYWxsZXRFcnJvcjo6VG9rZW5Ob3RTdGVsbGFyQXNzZXRgXSDigJQgYHRva2VuX2lkYCBpcyBub3QgdGhhdCBhc3NldCdzIFNBQwoqIFtgV2FsbGV0RXJyb3I6OkFsbG93bGlzdEFscmVhZHlQZW5kaW5nYF0g4oCUIGFscmVhZHkgcHJvcG9zZWQgb3IgYWxsb3dlZAAAAAAAABVwcm9wb3NlX2FsbG93ZWRfdG9rZW4AAAAAAAAEAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAAAAAACHRva2VuX2lkAAAAEwAAAAAAAAAKYXNzZXRfY29kZQAAAAAAEAAAAAAAAAAKaXNzdWVyX2tleQAAAAAD6AAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAQAAAC1BIHRpbWVsb2NrZWQgYWxsb3dsaXN0IGFkZGl0aW9uIChpc3N1ZSAjMTg5KS4AAAAAAAAAAAAAE1BlbmRpbmdBbGxvd2VkVG9rZW4AAAAAAwAAAAAAAAAEaW5mbwAAB9AAAAAQQWxsb3dlZFRva2VuSW5mbwAAAAAAAAALcHJvcG9zZWRfYnkAAAAAEwAAAAAAAAAIcmVhZHlfYXQAAAAE",
        "AAAAAAAAAHBBZG1pbjogZGlzY2FyZCB0aGUgcXVldWVkIGd1YXJkaWFuLXNldCBjaGFuZ2UgKGlzc3VlICMxNzUpLgoKIyBFcnJvcnMKKiBbYFdhbGxldEVycm9yOjpOb1BlbmRpbmdHdWFyZGlhbkNoYW5nZWBdAAAAFmNhbmNlbF9ndWFyZGlhbl9jaGFuZ2UAAAAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAfQAAAAC1dhbGxldEVycm9yAA==",
        "AAAAAAAAAdRBZG1pbi10cmlnZ2VyZWQgbWlncmF0aW9uIGZyb20gdGhlIHYxIGluc3RhbmNlIGxheW91dCB0byB2MgooaXNzdWUgIzE4NCkuIE1vdmVzIGBHdWFyZGlhbnNgL2BHdWFyZGlhbk1lbWJlcnNoaXBgL2BSZWNvdmVyeVByb3Bvc2FsYApvdXQgb2YgaW5zdGFuY2Ugc3RvcmFnZSBpbnRvIHBlcnNpc3RlbnQga2V5cy4gUmV0dXJucyBgdHJ1ZWAgaWYgaXQKbWlncmF0ZWQsIGBmYWxzZWAgaWYgdGhlIGNvbnRyYWN0IHdhcyBhbHJlYWR5IG9uIHYyLiBFdmVyeSBndWFyZGlhbiBvcgpyZWNvdmVyeSB3cml0ZSBhbHNvIG1pZ3JhdGVzIGxhemlseSwgc28gY2FsbGluZyB0aGlzIGlzIG9wdGlvbmFsOyBpdApleGlzdHMgc28gb3BlcmF0b3JzIGNhbiBzaHJpbmsgdGhlIGluc3RhbmNlIGZvb3RwcmludCBpbW1lZGlhdGVseQphZnRlciB1cGdyYWRpbmcgaW5zdGVhZCBvZiB3YWl0aW5nIGZvciB0aGUgbmV4dCBndWFyZGlhbiB3cml0ZS4AAAAWbWlncmF0ZV9zdG9yYWdlX2xheW91dAAAAAAAAQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAQAAA+kAAAABAAAH0AAAAAtXYWxsZXRFcnJvcgA=",
        "AAAAAQAAABdAZXZlbnQgdG9rZW5fZGlzYWxsb3dlZAAAAAAAAAAAFFRva2VuRGlzYWxsb3dlZEV2ZW50AAAAAgAAAAAAAAAKcmVtb3ZlZF9ieQAAAAAAEwAAAAAAAAAIdG9rZW5faWQAAAAT",
        "AAAAAAAAADtSZXR1cm4gdGhlIHF1ZXVlZCBndWFyZGlhbi1zZXQgY2hhbmdlLCBpZiBhbnkgKGlzc3VlICMxNzUpLgAAAAAXcGVuZGluZ19ndWFyZGlhbl9jaGFuZ2UAAAAAAAAAAAEAAAPoAAAH0AAAAA5HdWFyZGlhbkNoYW5nZQAA",
        "AAAAAAAAAqxBIGd1YXJkaWFuIHJldm9rZXMgdGhlaXIgb3duIGFwcHJvdmFsIG9mIHRoZSBwZW5kaW5nIHJlY292ZXJ5LgoKSWYgYXBwcm92YWxzIGRyb3AgYmVsb3cgdGhyZXNob2xkLCB0aGUgdGltZWxvY2sgaXMgZGlzYXJtZWQKKGByZWFkeV9hdGAgY2xlYXJlZCkg4oCUIHF1b3J1bSBtdXN0IGJlIHJlYWNoZWQgYWdhaW4gZnJvbSBzY3JhdGNoLApyZXN0YXJ0aW5nIHRoZSBkZWxheSB3aW5kb3cuCgojIEVycm9ycwoqIFtgV2FsbGV0RXJyb3I6OlVuYXV0aG9yaXplZGBdIOKAlCBjYWxsZXIgaXMgbm90IGEgY3VycmVudGx5CnJlZ2lzdGVyZWQgZ3VhcmRpYW4uIEFkZGVkIGZvciBjb25zaXN0ZW5jeSB3aXRoCmBpbml0aWF0ZV9yZWNvdmVyeWAvYGFwcHJvdmVfcmVjb3ZlcnlgLCB3aGljaCBib3RoIGFscmVhZHkgZ2F0ZSBvbgpgcmVxdWlyZV9ndWFyZGlhbmA7IHRoaXMgZnVuY3Rpb24gd2FzIHRoZSBvbmUgZXhjZXB0aW9uIHRvIHRoYXQKcGF0dGVybiAoc2VlIGlzc3VlICMyNikg4oCUIGhhcm1sZXNzIG9uIGl0cyBvd24gc2luY2UgcmV2b2tpbmcgb25seQpldmVyICpyZW1vdmVzKiBhbiBhcHByb3ZhbCwgYnV0IGxlYXZpbmcgaXQgdW5jaGVja2VkIG1lYW50IGd1YXJkaWFuCm1lbWJlcnNoaXAgd2Fzbid0IGVuZm9yY2VkIGNvbnNpc3RlbnRseSBhY3Jvc3MgdGhlIHdob2xlIGFwcHJvdmFsCmxpZmVjeWNsZS4AAAAYcmV2b2tlX3JlY292ZXJ5X2FwcHJvdmFsAAAAAQAAAAAAAAAIZ3VhcmRpYW4AAAATAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAALV2FsbGV0RXJyb3IA",
        "AAAAAQAABABAZXZlbnQgcmVjb3ZlcnlfY29tcGxldGVkCgpQYXlsb2FkIG9mIHRoZSBgcmVjb3ZlcnlfY29tcGxldGVkYCBldmVudCBgZXhlY3V0ZV9yZWNvdmVyeWAgcHVibGlzaGVzCihzZWUgaXNzdWUgIzkxKS4gRXZlcnkgb3RoZXIgZXZlbnQgaW4gdGhpcyBjb250cmFjdCBpcyBhIHJhdyB0dXBsZSDigJQKdGhpcyBvbmUgd2FzIGRlbGliZXJhdGVseSBhIG5hbWVkIGAjW2NvbnRyYWN0dHlwZV1gIHN0cnVjdCBpbnN0ZWFkIChpc3N1ZSAjMTkyIGhhcyBzaW5jZSBhZGRlZCB0eXBlZCBzdHJ1Y3QgcGF5bG9hZHMgZm9yIGV2ZXJ5IG5ldyBldmVudCksIGFuZAp0aGF0J3MgYSBvbmUtb2ZmIGRlcGFydHVyZSB3b3J0aCBleHBsYWluaW5nIHJhdGhlciB0aGFuIGEgc3R5bGlzdGljCmFjY2lkZW50OiBhIHR1cGxlJ3MgZmllbGRzIGFyZSBwb3NpdGlvbmFsIGFuZCB1bmRvY3VtZW50ZWQgaW4gdGhlCm9uLWNoYWluIFhEUiBpdHNlbGYsIHdoaWNoIGlzIGEgdG9sZXJhYmxlIGVyZ29ub21pY3MgdHJhZGUtb2ZmIGZvciBhCjItMyBmaWVsZCBwYXlsb2FkIHdoZXJlIG9yZGVyIGlzIG9idmlvdXMgZnJvbSBjb250ZXh0LiBUaGlzIGV2ZW50IGhhcwpmaXZlIGZpZWxkcyBmZWVkaW5nIGEgc2VjdXJpdHktYWxlcnRpbmcgaW50ZWdyYXRpb24sIHdoZXJlIGEKdHJhbnNwb3NlZCBwYWlyIG9mIGBBZGRyZXNzYGVzIChlLmcuIGFuIGluZGV4ZXIgcmVhZGluZyBgbmV3X2FkbWluYAp3aGVyZSBgb2xkX2FkbWluYCBiZWxvbmdzKSBoYXMgcmVhbCBjb25zZXF1ZW5jZXMg4oCUIGl0IHdvdWxkIG1pc3JlcG9ydAoqd2hvIGp1c3QgbG9zdCBjb250cm9sIG9mIGEgd2FsbGV0KiBkdXJpbmcgZXhhY3RseSB0aGUgaW5jaWRlbnQgdGhhdAptb3N0IG5lZWRzIHRvIGJlIHJlcG9ydGVkIGNvcnJlY3RseS4gQSBuYW1lZCBzdHJ1Y3QgbWFrZXMgZXZlcnkgZmllbGQKc2VsZi1kZXNjcmliaW5nIGluIHRoZSBYRFIsIGluZGVwZW5kZW50IG9mIGFueSBvZmYtY2hhaW4gc2NoZW1hIHRoZQpyZWFkZXIgaGFzIHRvIGFscmVhZHkga25vdyBhbmQgAAAAAAAAABZSZWNvdmVyeUNvbXBsZXRlZEV2ZW50AAAAAAAGAAABZUV2ZXJ5IGd1YXJkaWFuIHdob3NlIGFwcHJvdmFsIGlzIG9uIHRoZSBleGVjdXRlZCBwcm9wb3NhbCDigJQgbm90Cmp1c3QgdGhlIGB0aHJlc2hvbGRgIG1pbmltdW0uIEEgcmVjb3ZlcnkgcmF0aWZpZWQgNS1vZi01IGFuZCBvbmUKcmF0aWZpZWQgMy1vZi01ICh3aXRoIGB0aHJlc2hvbGQgPT0gM2ApIGFyZSBkaWZmZXJlbnQtcmlzayBldmVudHMKZXZlbiB0aG91Z2ggYm90aCBzYXRpc2Z5IHRoZSBzYW1lIG9uLWNoYWluIHF1b3J1bSBjaGVjazsgYW4KYWxlcnRpbmcgaW50ZWdyYXRpb24gdGhhdCBvbmx5IGtub3dzICJxdW9ydW0gd2FzIHJlYWNoZWQiIGNhbid0CnRlbGwgdGhlbSBhcGFydCwgdGhpcyBmaWVsZCBsZXRzIGl0LgAAAAAAABNhcHByb3ZpbmdfZ3VhcmRpYW5zAAAAA+oAAAATAAABQExlZGdlciBzZXF1ZW5jZSBvZiB0aGUgYGV4ZWN1dGVfcmVjb3ZlcnlgIGNhbGwgaXRzZWxmLiBDb21wYXJpbmcKdGhpcyBhZ2FpbnN0IGByZWFkeV9hdGAgdGVsbHMgYW4gb2JzZXJ2ZXIgaG93IHByb21wdGx5IHRoZQpub3ctZXhlY3V0YWJsZSByZWNvdmVyeSB3YXMgYWN0dWFsbHkgY2xhaW1lZCDigJQgYSBsb25nIGdhcCBjYW4gYmUKYXMgbWVhbmluZ2Z1bCB0byBhIG1vbml0b3Jpbmcgc3lzdGVtIGFzIHRoZSByZWNvdmVyeSBpdHNlbGYgKGUuZy4KIndoeSBkaWQgbm9ib2R5IGV4ZWN1dGUgYW4gYXBwcm92ZWQgcmVjb3ZlcnkgZm9yIHRocmVlIGRheXM/IikuAAAAC2V4ZWN1dGVkX2F0AAAAAAQAAAAxQWRtaW4gYWRkcmVzcyB0aGUgZ3VhcmRpYW5zIHJlY292ZXJlZCBjb250cm9sIHRvLgAAAAAAAAluZXdfYWRtaW4AAAAAAAATAAAAOkFkbWluIGFkZHJlc3MgaW4gY29udHJvbCBpbW1lZGlhdGVseSBiZWZvcmUgdGhpcyByZWNvdmVyeS4AAAAAAAlvbGRfYWRtaW4AAAAAAAATAAAAgkxlZGdlciBzZXF1ZW5jZSBhdCB3aGljaCB0aGUgdGltZWxvY2sgZWxhcHNlZCBhbmQgdGhpcyByZWNvdmVyeQpiZWNhbWUgZXhlY3V0YWJsZSAoYFJlY292ZXJ5UHJvcG9zYWwucmVhZHlfYXRgIGF0IGV4ZWN1dGlvbiB0aW1lKS4AAAAAAAhyZWFkeV9hdAAAAAQAAACsYFJlY292ZXJ5Q29uZmlnLnRocmVzaG9sZGAgaW4gZWZmZWN0IGZvciB0aGlzIGV4ZWN1dGlvbiDigJQgdGhlCm1pbmltdW0gcXVvcnVtIHNpemUsIGZvciBjb21wdXRpbmcgaG93IG11Y2ggYWJvdmUvYmVsb3cgdGhlIGJhcmUKbWluaW11bSBgYXBwcm92aW5nX2d1YXJkaWFuc2AgYWN0dWFsbHkgd2FzLgAAAAl0aHJlc2hvbGQAAAAAAAAE",
        "AAAAAAAAAI5DYW5jZWwgYSBwZW5kaW5nIGxpbWl0IGluY3JlYXNlIGJlZm9yZSBpdCB0YWtlcyBlZmZlY3QuIFRoZSBvd25lciBvcgphbnkgZ3VhcmRpYW4gbWF5IGNhbmNlbC4KCiMgRXJyb3JzCiogW2BXYWxsZXRFcnJvcjo6Tm9QZW5kaW5nU3BlbmRMaW1pdGBdAAAAAAAaY2FuY2VsX3BlbmRpbmdfc3BlbmRfbGltaXQAAAAAAAMAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAEdXNlcgAAABMAAAAAAAAACHRva2VuX2lkAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAfQAAAAC1dhbGxldEVycm9yAA==",
        "AAAAAQAAAB9AZXZlbnQgdG9rZW5fYWxsb3dsaXN0X3Byb3Bvc2VkAAAAAAAAAAAbVG9rZW5BbGxvd2xpc3RQcm9wb3NlZEV2ZW50AAAAAAUAAAAAAAAACmFzc2V0X2NvZGUAAAAAABAAAAAAAAAACmlzc3Vlcl9rZXkAAAAAB9AAAAAJSXNzdWVyS2V5AAAAAAAAAAAAAAtwcm9wb3NlZF9ieQAAAAATAAAAAAAAAAhyZWFkeV9hdAAAAAQAAAAAAAAACHRva2VuX2lkAAAAEw==",
        "AAAAAQAAACBAZXZlbnQgdG9rZW5fYWxsb3dsaXN0X2NhbmNlbGxlZAAAAAAAAAAcVG9rZW5BbGxvd2xpc3RDYW5jZWxsZWRFdmVudAAAAAIAAAAAAAAADGNhbmNlbGxlZF9ieQAAABMAAAAAAAAACHRva2VuX2lkAAAAEw==",
        "AAAAAAAAAfpHcmFudCBhIHNwZW5kZXIgYWxsb3dhbmNlIG92ZXIgdGhlIGNhbGxlcidzIHRva2Vucy4KCioqT3ZlcndyaXRlIHNlbWFudGljczoqKiBjYWxsaW5nIGBhcHByb3ZlYCBmb3IgYW4gZXhpc3RpbmcKYChvd25lciwgc3BlbmRlcilgIHBhaXIgKipyZXBsYWNlcyoqIHRoZSBwcmV2aW91cyBhbGxvd2FuY2UKd2hvbGVzYWxlIOKAlCBpdCBkb2VzICoqbm90KiogYWRkIHRvIHRoZSByZW1haW5pbmcgYmFsYW5jZS4KSWYgYSBzcGVuZGVyIGhhcyBhbHJlYWR5IHVzZWQgcGFydCBvZiB0aGVpciBhbGxvd2FuY2UgYW5kCnRoZSBvd25lciBjYWxscyBgYXBwcm92ZWAgYWdhaW4sIHRoZSBuZXcgYGFtb3VudGAgYmVjb21lcyB0aGUKKnRvdGFsKiBhbGxvd2FuY2UsIG5vdCBhbiBpbmNyZW1lbnQgb24gdG9wIG9mIHdoYXQncyBsZWZ0LgoKVGhlIGFsbG93YW5jZSBhcHBsaWVzIHRvIGB0b2tlbl9pZGAgb25seSAoaXNzdWUgIzE3NCkuCgpgZXhwaXJ5X2xlZGdlcmAgbXVzdCBiZSBpbiB0aGUgZnV0dXJlLgAAAAAAB2FwcHJvdmUAAAAABQAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAdzcGVuZGVyAAAAABMAAAAAAAAACHRva2VuX2lkAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA1leHBpcnlfbGVkZ2VyAAAAAAAABAAAAAEAAAPpAAAD7QAAAAAAAAfQAAAADFdyYXBwZXJFcnJvcg==",
        "AAAAAAAAADhSZXR1cm4gY3VycmVudCBhbGxvd2FuY2UgZm9yIChvd25lciwgc3BlbmRlciwgdG9rZW5faWQpLgAAAAlhbGxvd2FuY2UAAAAAAAADAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAAB3NwZW5kZXIAAAAAEwAAAAAAAAAIdG9rZW5faWQAAAATAAAAAQAAB9AAAAAJQWxsb3dhbmNlAAAA",
        "AAAAAQAAAAAAAAAAAAAACUFsbG93YW5jZQAAAAAAAAIAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAANZXhwaXJ5X2xlZGdlcgAAAAAAAAQ=",
        "AAAAAAAAAURUcmFuc2ZlciB0b2tlbnMgZnJvbSBgZnJvbWAgdG8gYHRvYCB1c2luZyBhIHByZXZpb3VzbHkgZ3JhbnRlZCBhbGxvd2FuY2UuCgpEZWNyZW1lbnRzIHRoZSBgKGZyb20sIHNwZW5kZXIsIHRva2VuX2lkKWAgYWxsb3dhbmNlOyBmYWlscyBpZiBleHBpcmVkCm9yIGluc3VmZmljaWVudC4gQW4gYWxsb3dhbmNlIGdyYW50ZWQgZm9yIGEgZGlmZmVyZW50IHRva2VuIG5ldmVyCmFwcGxpZXMgKGBJbnN1ZmZpY2llbnRBbGxvd2FuY2VgLCBpc3N1ZSAjMTc0KS4KQW4gYWxsb3dhbmNlIGlzIHVzYWJsZSB0aHJvdWdoIGFuZCBpbmNsdWRpbmcgaXRzIGBleHBpcnlfbGVkZ2VyYC4AAAANdHJhbnNmZXJfZnJvbQAAAAAAAAUAAAAAAAAAB3NwZW5kZXIAAAAAEwAAAAAAAAAIdG9rZW5faWQAAAATAAAAAAAAAARmcm9tAAAAEwAAAAAAAAACdG8AAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAfQAAAADFdyYXBwZXJFcnJvcg==",
        "AAAABAAAAAAAAAAAAAAADFdyYXBwZXJFcnJvcgAAAAQAAAAAAAAAEEFsbG93YW5jZUV4cGlyZWQAAAfRAAAAAAAAABVJbnN1ZmZpY2llbnRBbGxvd2FuY2UAAAAAAAfSAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAH0wAAAAAAAAANSW52YWxpZEV4cGlyeQAAAAAAB9Q=",
        "AAAAAgAAAAAAAAAAAAAADldyYXBwZXJEYXRhS2V5AAAAAAACAAAAAQAAAUhMZWdhY3kgYChvd25lciwgc3BlbmRlcilgIGFsbG93YW5jZSB0aGF0IGFwcGxpZWQgdG8gKmV2ZXJ5KiB0b2tlbi4KTm8gbG9uZ2VyIHJlYWQgb3Igd3JpdHRlbiAoaXNzdWUgIzE3NCk6IGV4aXN0aW5nIGVudHJpZXMgYXJlIGluZXJ0CmFuZCBhcmNoaXZlIG9uIHRoZWlyIG93biBUVEwsIHNvIGEgbGVnYWN5IGFwcHJvdmFsIGNhbiBuZXZlciBiZSB1c2VkCnRvIG1vdmUgYSB0b2tlbiB0aGUgb3duZXIgZGlkIG5vdCBhcHByb3ZlLiBPd25lcnMgcmUtYXBwcm92ZSBwZXIKdG9rZW4uIEtlcHQgb25seSBzbyB0aGUgdmFyaWFudCdzIGRpc2NyaW1pbmFudCBzdGF5cyBzdGFibGUuAAAACUFsbG93YW5jZQAAAAAAAAIAAAATAAAAEwAAAAEAAAA2KG93bmVyLCBzcGVuZGVyLCB0b2tlbl9pZCkg4oaSIChhbW91bnQsIGV4cGlyeV9sZWRnZXIpAAAAAAAOVG9rZW5BbGxvd2FuY2UAAAAAAAMAAAATAAAAEwAAABM=",
        "AAAAAAAAAbtQZXJtaXNzaW9ubGVzcyBUVEwga2VlcGVyIGZvciBvbmUgYWxsb3dhbmNlIChpc3N1ZSAjMTg1KS4KClJlLWV4dGVuZHMgdGhlIGAob3duZXIsIHNwZW5kZXIsIHRva2VuX2lkKWAgZW50cnkgc28gc3RvcmFnZSBuZXZlciBhcmNoaXZlcyBpdApiZWZvcmUgaXRzIG93biBgZXhwaXJ5X2xlZGdlcmAuIFZhbHVlcyBhcmUgdW50b3VjaGVkLCBzbyBubyBhdXRoIGlzCm5lZWRlZCDigJQgYW55b25lICh0aGUgYmFja2VuZCBrZWVwZXIgam9iKSBtYXkgcGF5IGZvciBpdC4gUmV0dXJucyB0aGUKbnVtYmVyIG9mIGxlZGdlcnMgdGhlIGVudHJ5IHdhcyBleHRlbmRlZCB0byBsaXZlIGZvciAoMCB3aGVuIHRoZSBwYWlyCmhhcyBubyBhbGxvd2FuY2Ugb3IgaXQgaGFzIGFscmVhZHkgZXhwaXJlZCwgaW4gd2hpY2ggY2FzZSB0aGVyZSBpcwpub3RoaW5nIHdvcnRoIGtlZXBpbmcgYWxpdmUpLgAAAAAUZXh0ZW5kX2FsbG93YW5jZV90dGwAAAADAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAAB3NwZW5kZXIAAAAAEwAAAAAAAAAIdG9rZW5faWQAAAATAAAAAQAAAAQ=" ]),
      options
    )
  }
  public readonly fromJSON = {
    send: this.txFromJSON<Result<void>>,
        admin: this.txFromJSON<string>,
        pause: this.txFromJSON<Result<void>>,
        pauser: this.txFromJSON<Option<string>>,
        unpause: this.txFromJSON<Result<void>>,
        has_role: this.txFromJSON<boolean>,
        add_asset: this.txFromJSON<Result<void>>,
        guardians: this.txFromJSON<Array<string>>,
        is_paused: this.txFromJSON<boolean>,
        get_assets: this.txFromJSON<Array<AssetInfo>>,
        grant_role: this.txFromJSON<Result<void>>,
        initialize: this.txFromJSON<Result<void>>,
        set_pauser: this.txFromJSON<Result<void>>,
        pause_sends: this.txFromJSON<Result<void>>,
        revoke_role: this.txFromJSON<Result<void>>,
        accept_admin: this.txFromJSON<Result<void>>,
        add_guardian: this.txFromJSON<Result<void>>,
        record_spend: this.txFromJSON<Result<void>>,
        remove_asset: this.txFromJSON<Result<void>>,
        pending_admin: this.txFromJSON<Option<string>>,
        propose_admin: this.txFromJSON<Result<void>>,
        unpause_sends: this.txFromJSON<Result<void>>,
        allowed_tokens: this.txFromJSON<Array<string>>,
        is_send_paused: this.txFromJSON<boolean>,
        storage_layout: this.txFromJSON<u32>,
        transfer_admin: this.txFromJSON<Result<void>>,
        cancel_recovery: this.txFromJSON<Result<void>>,
        execute_upgrade: this.txFromJSON<Result<void>>,
        extend_user_ttl: this.txFromJSON<u32>,
        get_spend_limit: this.txFromJSON<i128>,
        get_spent_today: this.txFromJSON<i128>,
        pending_upgrade: this.txFromJSON<Option<UpgradeProposal>>,
        propose_upgrade: this.txFromJSON<Result<void>>,
        recovery_config: this.txFromJSON<Option<RecoveryConfig>>,
        remove_guardian: this.txFromJSON<Result<void>>,
        set_spend_limit: this.txFromJSON<Result<void>>,
        approve_recovery: this.txFromJSON<Result<void>>,
        execute_recovery: this.txFromJSON<Result<void>>,
        is_token_allowed: this.txFromJSON<boolean>,
        get_token_wrapper: this.txFromJSON<Option<string>>,
        initiate_recovery: this.txFromJSON<Result<void>>,
        is_limit_archived: this.txFromJSON<boolean>,
        recovery_proposal: this.txFromJSON<Option<RecoveryProposal>>,
        set_token_wrapper: this.txFromJSON<Result<void>>,
        allowed_token_info: this.txFromJSON<Option<AllowedTokenInfo>>,
        get_allowed_tokens: this.txFromJSON<Array<string>>,
        get_spend_allowance: this.txFromJSON<SpendAllowance>,
        migrate_spend_limit: this.txFromJSON<Result<boolean>>,
        migrate_user_assets: this.txFromJSON<Result<u32>>,
        pending_spend_limit: this.txFromJSON<Option<PendingSpendLimit>>,
        set_recovery_config: this.txFromJSON<Result<void>>,
        cancel_allowed_token: this.txFromJSON<Result<void>>,
        remove_allowed_token: this.txFromJSON<Result<void>>,
        apply_guardian_change: this.txFromJSON<Result<void>>,
        cancel_admin_transfer: this.txFromJSON<Result<void>>,
        execute_allowed_token: this.txFromJSON<Result<void>>,
        pending_allowed_token: this.txFromJSON<Option<PendingAllowedToken>>,
        propose_allowed_token: this.txFromJSON<Result<void>>,
        cancel_guardian_change: this.txFromJSON<Result<void>>,
        migrate_storage_layout: this.txFromJSON<Result<boolean>>,
        pending_guardian_change: this.txFromJSON<Option<GuardianChange>>,
        revoke_recovery_approval: this.txFromJSON<Result<void>>,
        cancel_pending_spend_limit: this.txFromJSON<Result<void>>,
        approve: this.txFromJSON<Result<void>>,
        allowance: this.txFromJSON<Allowance>,
        transfer_from: this.txFromJSON<Result<void>>,
        extend_allowance_ttl: this.txFromJSON<u32>
  }
}