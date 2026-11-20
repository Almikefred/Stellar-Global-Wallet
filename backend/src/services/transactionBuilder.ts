/**
 * Pure transaction builders for Stellar operations.
 *
 * These functions build unsigned transactions and return XDR without making
 * any network calls. They can be used client-side in the SDK without any
 * Horizon dependency.
 *
 * For operations that need Horizon reads (account sequence, fees), use
 * horizonService.ts which injects the Horizon server.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { BUILD_TIMEOUT_SECONDS } from "./transactionEnvelope";
import { config } from "../config";
import { fromStroops, toStroops } from "../utils/stroops";
import { isGAddress } from "../utils/stellarAddress";
import type { TransactionSummary } from "@stellar-global-wallet/types";

// Re-exported for backward compatibility
export type { TransactionSummary };

/**
 * Minimum starting balance for a brand-new account: the base reserve (0.5
 * XLM) x 2 base entries.
 */
export const MIN_STARTING_BALANCE = "1";

/** Base reserve per ledger entry, in XLM. */
export const BASE_RESERVE = "0.5";

/** Which operation the send/build path chose for a destination (#65). */
export type SendOperationType = "payment" | "createAccount";

/** Unsigned path payment plus what the swap screen shows before the user signs. */
export interface PathPaymentBuild {
  xdr: string;
  networkPassphrase: string;
  fee: string;
  sequence: string;
  timeBounds: { minTime: string; maxTime: string };
  expiresAt: string | null;
  expectedSend: string;
  expectedReceive: string;
  minReceive?: string;
  maxSend?: string;
  slippageBps: number;
  path: string[];
}

/** One pre-signing warning returned by `precheckSend` (#64). */
export interface SendPrecheckWarning {
  code:
    | "DESTINATION_IS_SOURCE"
    | "SOURCE_NOT_FUNDED"
    | "DESTINATION_NOT_FUNDED"
    | "DESTINATION_WILL_BE_CREATED"
    | "NO_TRUSTLINE"
    | "TRUSTLINE_NOT_AUTHORIZED"
    | "MEMO_REQUIRED"
    | "AMOUNT_EXCEEDS_SPENDABLE";
  message: string;
  blocking: boolean;
}

export interface SendPrecheckResult {
  warnings: SendPrecheckWarning[];
  blocking: boolean;
  operationType: SendOperationType;
  spendable: string | undefined;
}

/**
 * The underlying G... account of a G... or muxed M... address. Existence,
 * trustline and SEP-29 checks run against the base account; the muxed ID
 * only matters in the operation's destination field.
 */
export function baseAccountId(address: string): string {
  return address.startsWith("M")
    ? StellarSdk.MuxedAccount.fromAddress(address, "0").baseAccount().accountId()
    : address;
}

/**
 * Parse an asset string (CODE:ISSUER or XLM) into an Asset object.
 * Does NOT validate the issuer exists - use horizonService for that.
 */
export function parseAsset(asset?: string): StellarSdk.Asset {
  if (!asset || asset.toUpperCase() === "XLM") {
    return StellarSdk.Asset.native();
  }
  const parts = asset.split(":");
  if (parts.length !== 2) {
    throw new Error(`Invalid asset format: ${asset}`);
  }
  const [code, issuer] = parts;
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
    throw new Error(`Invalid asset code: ${code}`);
  }
  if (!isGAddress(issuer)) {
    throw new Error(`Invalid asset issuer: ${issuer}`);
  }
  return new StellarSdk.Asset(code, issuer);
}

/**
 * Parse a list of path asset strings into Asset objects.
 */
export function parsePathAssets(assets: string[]): StellarSdk.Asset[] {
  return assets.map((asset) => parseAsset(asset));
}

/**
 * Check if an account requires a memo based on SEP-29.
 * Reads the account's data entries for "config.memo_required" = "MQ==".
 */
export function accountRequiresMemo(account: StellarSdk.Horizon.AccountResponse): boolean {
  // In TypeScript, data_dict is not exposed in the AccountResponse type
  // but it exists at runtime. We use type assertion for access.
  const dataDict = (account as any).data_dict;
  return dataDict?.["config.memo_required"] === "MQ==";
}

/**
 * Build an unsigned payment transaction.
 * Returns the unsigned envelope with proper fee and sequence.
 */
export function buildPaymentTransaction(
  sourceAccount: StellarSdk.Horizon.AccountResponse,
  destinationPublicKey: string,
  amount: string,
  asset?: string,
  memo?: string
): StellarSdk.Transaction {
  const stellarAsset = parseAsset(asset);
  const destination = baseAccountId(destinationPublicKey);
  const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination,
        asset: stellarAsset,
        amount,
      })
    )
    .setTimeout(BUILD_TIMEOUT_SECONDS);
  if (memo) builder.addMemo(StellarSdk.Memo.text(memo));
  return builder.build();
}

/**
 * Build an unsigned path payment strict send transaction.
 */
export function buildPathPaymentStrictSendTransaction(
  sourceAccount: StellarSdk.Horizon.AccountResponse,
  sendAsset: StellarSdk.Asset,
  sendAmount: string,
  destinationPublicKey: string,
  destAsset: StellarSdk.Asset,
  destMin: string,
  path: StellarSdk.Asset[] = [],
  memo?: string
): StellarSdk.Transaction {
  const destination = baseAccountId(destinationPublicKey);
  const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.pathPaymentStrictSend({
        sendAsset,
        sendAmount,
        destination,
        destAsset,
        destMin,
        path,
      })
    )
    .setTimeout(BUILD_TIMEOUT_SECONDS);
  if (memo) builder.addMemo(StellarSdk.Memo.text(memo));
  return builder.build();
}

/**
 * Build an unsigned path payment strict receive transaction.
 */
export function buildPathPaymentStrictReceiveTransaction(
  sourceAccount: StellarSdk.Horizon.AccountResponse,
  sendAsset: StellarSdk.Asset,
  sendMax: string,
  destinationPublicKey: string,
  destAsset: StellarSdk.Asset,
  destAmount: string,
  path: StellarSdk.Asset[] = [],
  memo?: string
): StellarSdk.Transaction {
  const destination = baseAccountId(destinationPublicKey);
  const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.pathPaymentStrictReceive({
        sendAsset,
        sendMax,
        destination,
        destAsset,
        destAmount,
        path,
      })
    )
    .setTimeout(BUILD_TIMEOUT_SECONDS);
  if (memo) builder.addMemo(StellarSdk.Memo.text(memo));
  return builder.build();
}

/**
 * Build an unsigned changeTrust transaction.
 */
export function buildTrustlineTransaction(
  sourceAccount: StellarSdk.Horizon.AccountResponse,
  asset: { code: string; issuer: string },
  limit?: string
): StellarSdk.Transaction {
  const limitValue = limit ?? "922337203685.4775807";
  if (!/^[A-Za-z0-9]{1,12}$/.test(asset.code) || asset.code.toUpperCase() === "XLM") {
    throw new Error(`Invalid trustline asset code: ${asset.code}`);
  }
  if (!isGAddress(asset.issuer)) {
    throw new Error(`Invalid trustline asset issuer: ${asset.issuer}`);
  }
  const trustAsset = new StellarSdk.Asset(asset.code, asset.issuer);
  const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.NETWORK_PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset: trustAsset, limit: limitValue }))
    .setTimeout(BUILD_TIMEOUT_SECONDS);
  return builder.build();
}

/**
 * Build a transaction with custom operations.
 * This is the low-level builder that other helpers use.
 */
export function buildTransaction(
  sourceAccount: StellarSdk.Horizon.AccountResponse,
  operations: StellarSdk.Operation[],
  memo?: string,
  timeoutSeconds: number = BUILD_TIMEOUT_SECONDS
): StellarSdk.Transaction {
  const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.NETWORK_PASSPHRASE,
  })
    .addOperations(operations as any)
    .setTimeout(timeoutSeconds);
  if (memo) builder.addMemo(StellarSdk.Memo.text(memo));
  return builder.build();
}
