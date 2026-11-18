/**
 * Mirrors `WalletError` from `contract/contracts/globe-wallet/src/lib.rs`,
 * mapping numeric error codes surfaced by Soroban simulation and execution
 * into machine-readable API error codes and user-facing explanations.
 *
 * Codes, variant names and API codes come from the generated
 * `./generated/walletErrors.generated.ts` (issue #193) — regenerate it with
 * `npx tsx scripts/gen-contract-spec.ts`, never edit numbers here. Only the
 * UI copy below is hand-written, keyed by variant name so a renumbering can
 * never silently attach the wrong message to a code.
 */
import { GENERATED_WALLET_ERRORS } from "./generated/walletErrors.generated";

export interface GlobeWalletErrorInfo {
  code: number;
  name: string;
  apiCode: string;
  userMessage: string;
}

/** User-facing copy per `WalletError` variant name. */
export const GLOBE_WALLET_USER_MESSAGES: Readonly<Record<string, string>> = {
  AlreadyInitialized: "This wallet contract is already initialized.",
  NotInitialized: "This wallet contract has not been initialized yet.",
  Unauthorized: "You do not have permission to perform this action.",
  AssetAlreadyAdded: "This asset has already been added to your wallet.",
  AssetNotFound: "The specified asset was not found in your wallet.",
  InvalidSpendLimit: "The spend limit amount provided is invalid.",
  SpendLimitExceeded: "Payment would exceed your configured daily spend limit for this asset.",
  NoAssetsProvided: "No assets were provided for this operation.",
  NoPendingAdmin: "There is no pending admin transfer to accept.",
  SpendOverflow: "The transaction amount caused a numeric overflow.",
  AssetLimitExceeded: "The asset limit has been exceeded.",
  MaxAssetsReached: "You have reached the maximum number of assets permitted in this wallet.",
  UpgradeAlreadyPending: "A contract upgrade proposal is already pending.",
  UpgradeNotPending: "No contract upgrade is currently pending.",
  UpgradeHashMismatch: "The upgrade hash does not match the proposed upgrade.",
  UpgradeNotReady: "The required timelock delay for this upgrade has not elapsed yet.",
  UpgradeFailed: "The contract upgrade failed to execute.",
  GuardianAlreadyAdded: "This guardian address is already registered.",
  GuardianNotFound: "The specified address is not a registered guardian.",
  InvalidRecoveryThreshold: "The recovery threshold must be greater than 1 and no more than the total number of guardians.",
  NotEnoughGuardians: "There are not enough guardians configured to support this recovery threshold.",
  RecoveryNotConfigured: "Social recovery has not been configured on this wallet yet.",
  RecoveryAlreadyPending: "A social recovery proposal is already in progress.",
  NoPendingRecovery: "There is no pending social recovery proposal to act upon.",
  AlreadyApproved: "You have already approved this recovery proposal.",
  ApprovalNotFound: "No approval found from this guardian to revoke.",
  RecoveryNotReady: "The recovery timelock delay has not yet passed.",
  RecoveryNotQuorate: "Recovery approvals have dropped below the required threshold quorum.",
  InvalidAssetInfo: "The asset code or issuer configuration is invalid.",
  UpgradeWasmNotUploaded: "The proposed contract WASM has not been uploaded to the network.",
  GuardianLimitExceeded: "You have reached the maximum number of guardians allowed.",
  RecoveryNewAdminUnchanged: "The proposed recovery address is already the current wallet admin.",
  InvalidAssetCode: "Asset code cannot be empty and cannot exceed maximum allowed length.",
  TokenNotAllowed: "This token is not on the admin-approved allowlist for transfers.",
  TokenWrapperNotSet: "Token wrapper contract instance has not been configured by an admin.",
  TokenTransferFailed: "The token transfer failed. Please check allowance and account balance.",
  UpgradeDelayTooShort: "The proposed upgrade timelock delay is below the minimum required ledgers.",
  RecoveryDelayTooShort: "The recovery timelock delay is below the minimum required ledgers.",
  ContractPaused: "Transfers are temporarily paused on this wallet contract.",
  TokenNotStellarAsset: "This token is not a verified Stellar Asset Contract and cannot be allowlisted.",
  AllowlistProposalNotFound: "There is no pending allowlist proposal for this token.",
  AllowlistNotReady: "The allowlist timelock for this token has not elapsed yet.",
  AllowlistAlreadyPending: "This token is already allowlisted or has a pending allowlist proposal.",
};

const FALLBACK_USER_MESSAGE = "The wallet contract rejected this request.";

function buildErrorTable(): Record<number, GlobeWalletErrorInfo> {
  const table: Record<number, GlobeWalletErrorInfo> = {};
  for (const e of GENERATED_WALLET_ERRORS) {
    table[e.code] = {
      code: e.code,
      name: e.name,
      apiCode: e.apiCode,
      userMessage: GLOBE_WALLET_USER_MESSAGES[e.name] ?? FALLBACK_USER_MESSAGE,
    };
  }
  // Backward compatibility aliases for legacy single/double-digit codes
  // (9..28) used before the 1001+ namespace (issue #23).
  for (let legacy = 9; legacy <= 28; legacy++) {
    const info = table[legacy + 1000];
    if (info) table[legacy] = info;
  }
  return table;
}

export const GLOBE_WALLET_ERRORS: Readonly<Record<number, GlobeWalletErrorInfo>> = buildErrorTable();

/**
 * Mapping of numeric error code to variant name.
 */
export const GLOBE_WALLET_ERROR_CODES: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(GLOBE_WALLET_ERRORS).map(([code, info]) => [Number(code), info.name])
);

const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/;

/**
 * Extracts a contract error code from a raw string or number.
 */
export function extractContractErrorCode(raw: string | number): number | null {
  if (typeof raw === "number") return raw;
  const match = raw.match(CONTRACT_ERROR_PATTERN);
  return match ? Number(match[1]) : null;
}

/**
 * Returns the human-readable user-facing UI message for a contract error code.
 */
export function getGlobeWalletUserMessage(codeOrRaw: number | string): string | null {
  const code = extractContractErrorCode(codeOrRaw);
  if (code === null) return null;
  return GLOBE_WALLET_ERRORS[code]?.userMessage ?? null;
}

/**
 * Returns the stable API error code string for a contract error code.
 */
export function getGlobeWalletApiCode(codeOrRaw: number | string): string | null {
  const code = extractContractErrorCode(codeOrRaw);
  if (code === null) return null;
  return GLOBE_WALLET_ERRORS[code]?.apiCode ?? null;
}

/**
 * Extracts a `Error(Contract, #N)` code from a raw Soroban simulation/
 * transaction error string and appends its `WalletError` name and user message, if known.
 * Falls back to returning the input unchanged when no such code is found.
 */
export function describeGlobeWalletError(raw: string): string {
  const code = extractContractErrorCode(raw);
  if (code === null) return raw;
  const info = GLOBE_WALLET_ERRORS[code];
  return info ? `${info.name} (contract error #${code}): ${info.userMessage}` : raw;
}
