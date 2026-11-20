/**
 * Horizon service layer for read operations.
 *
 * Injects the Horizon server for testing and contains all read operations.
 * Submission operations are in transactionSubmitter.ts.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { AppError, NotFoundError, ValidationError } from "../errors/appError";
import { config } from "../config";
import { isGAddress } from "../utils/stellarAddress";
import {
  explorerTxUrl,
  HistoryFilters,
  HistoryItem,
  HistoryPage,
  HorizonOperationLike,
  HorizonTransactionLike,
  mapOperationToHistoryItem,
  scanHistory,
  stroopsToXlm,
} from "./transactionHistory";
import { getVerifiedAssets } from "./verifiedAssets";
import { assetKey, computePaymentFlags, parseVerifiedAssetsList, PaymentFlag } from "./paymentFlags";
import { baseAccountId } from "./transactionBuilder";
import { accountRequiresMemo } from "./transactionBuilder";
import { SendPrecheckWarning } from "./transactionBuilder";

export interface HorizonServiceOptions {
  server: StellarSdk.Horizon.Server;
  networkPassphrase: string;
}

export class HorizonService {
  private server: StellarSdk.Horizon.Server;
  private networkPassphrase: string;

  constructor(options: HorizonServiceOptions) {
    this.server = options.server;
    this.networkPassphrase = options.networkPassphrase;
  }

  async getAccount(publicKey: string) {
    try {
      return await this.server.loadAccount(publicKey);
    } catch (err) {
      if (hasResponseStatus(err, 404)) {
        throw new NotFoundError(`Account ${publicKey} was not found on Horizon`, "ACCOUNT_NOT_FOUND");
      }
      throw err;
    }
  }

  /** Like `getAccount`, but resolves to `null` instead of throwing on 404. */
  async loadAccountOrNull(publicKey: string): Promise<StellarSdk.Horizon.AccountResponse | null> {
    try {
      return await this.server.loadAccount(publicKey);
    } catch (err) {
      if (hasResponseStatus(err, 404)) return null;
      throw err;
    }
  }

  async getBalances(publicKey: string): Promise<Record<string, string>> {
    const account = await this.getAccount(publicKey);
    const result: Record<string, string> = {};
    for (const b of account.balances) {
      if (b.asset_type === "native") result["XLM"] = b.balance;
      else if ("asset_code" in b) result[b.asset_code] = b.balance;
    }
    return result;
  }

  async getTransactions(
    publicKey: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{
    transactions: { id: string; hash: string; ledger: number; created_at: string; operation_count: number; memo: string | null }[];
    next: string | undefined;
    hasMore: boolean;
  }>;
  async getTransactions(publicKey: string, limit: number): Promise<{ id: string; hash: string; ledger: number; created_at: string; operation_count: number; memo: string | null }[]>;
  async getTransactions(
    publicKey: string,
    optionsOrLimit?: { limit?: number; cursor?: string } | number
  ) {
    let limit = 20;
    let cursor: string | undefined;
    if (typeof optionsOrLimit === "number") {
      limit = optionsOrLimit;
    } else if (typeof optionsOrLimit === "object" && optionsOrLimit !== null) {
      limit = optionsOrLimit.limit ?? 20;
      cursor = optionsOrLimit.cursor;
    }

    let builder = this.server
      .transactions()
      .forAccount(publicKey)
      .limit(limit)
      .order("desc");
    if (cursor) {
      builder = builder.cursor(cursor);
    }
    const records = await builder.call();
    const transactions = records.records.map((tx) => ({
      id: tx.id,
      hash: tx.hash,
      ledger: tx.ledger_attr,
      created_at: tx.created_at,
      operation_count: tx.operation_count,
      memo: tx.memo,
    }));
    const lastRecord = records.records[records.records.length - 1];
    const result = {
      transactions,
      next: lastRecord ? (lastRecord as unknown as { paging_token: string }).paging_token : undefined,
      hasMore: records.records.length === limit,
    };

    if (typeof optionsOrLimit === "number") {
      return transactions;
    }
    return result;
  }

  async getPaymentHistory(
    publicKey: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{
    payments: PaymentHistoryItem[];
    next: string | undefined;
    hasMore: boolean;
  }> {
    const limit = options?.limit ?? 20;
    const cursor = options?.cursor;

    let builder = this.server
      .payments()
      .forAccount(publicKey)
      .join("transactions")
      .limit(limit)
      .order("desc");
    if (cursor) {
      builder = builder.cursor(cursor);
    }
    const records = await builder.call();

    const dustThreshold = config.SPAM_DUST_THRESHOLD;
    const verifiedAssets = new Set([
      ...getVerifiedAssets().map((a) => assetKey(a.code, a.issuer)),
      ...parseVerifiedAssetsList(config.VERIFIED_ASSETS),
    ]);

    const payments: PaymentHistoryItem[] = await Promise.all(
      records.records.map(async (op) => {
        const amount = "amount" in op ? op.amount : undefined;
        const assetType = "asset_type" in op ? op.asset_type : undefined;
        const assetCode = "asset_code" in op ? op.asset_code : undefined;
        const assetIssuer = "asset_issuer" in op ? op.asset_issuer : undefined;
        const from = "from" in op ? op.from : undefined;
        const to = "to" in op ? op.to : undefined;

        let memo: string | undefined;
        try {
          const transaction = await op.transaction();
          memo = transaction.memo;
        } catch (err) {
          console.warn(`[horizonService] failed to read joined transaction for operation ${op.id}: ${err}`);
        }

        const flags = computePaymentFlags(
          { amount, assetType, assetCode, assetIssuer, memo },
          { dustThreshold, verifiedAssets }
        );

        return {
          id: op.id,
          type: op.type,
          transactionHash: op.transaction_hash,
          createdAt: op.created_at,
          from,
          to,
          amount,
          assetType,
          assetCode,
          assetIssuer,
          memo,
          flags,
        };
      })
    );

    const lastRecord = records.records[records.records.length - 1];
    return {
      payments,
      next: lastRecord ? (lastRecord as unknown as { paging_token: string }).paging_token : undefined,
      hasMore: records.records.length === limit,
    };
  }

  async getHistory(
    publicKey: string,
    options: { limit?: number; cursor?: string; filters?: HistoryFilters } = {}
  ): Promise<HistoryPage> {
    return scanHistory(
      (cursor, pageSize) => this.fetchHistoryPage(publicKey, cursor, pageSize),
      {
        limit: options.limit ?? 20,
        cursor: options.cursor,
        filters: options.filters,
        scanCap: config.HISTORY_SCAN_CAP,
      }
    );
  }

  async fetchHistoryPage(
    publicKey: string,
    cursor: string | undefined,
    pageSize: number
  ): Promise<HistoryItem[]> {
    let builder = this.server
      .operations()
      .forAccount(publicKey)
      .join("transactions")
      .includeFailed(true)
      .limit(pageSize)
      .order("desc");
    if (cursor) {
      builder = builder.cursor(cursor);
    }

    let records: StellarSdk.Horizon.ServerApi.OperationRecord[];
    try {
      records = (await builder.call()).records;
    } catch (err) {
      if (hasResponseStatus(err, 404)) {
        throw new NotFoundError(`Account ${publicKey} was not found on Horizon`, "ACCOUNT_NOT_FOUND");
      }
      if (hasResponseStatus(err, 400) && cursor) {
        throw new ValidationError([
          { location: "query", message: "cursor is not a valid history cursor", path: "cursor", value: cursor },
        ]);
      }
      throw err;
    }

    return Promise.all(
      records.map(async (op) => {
        let tx: HorizonTransactionLike | undefined;
        try {
          tx = (await op.transaction()) as unknown as HorizonTransactionLike;
        } catch (err) {
          console.warn(`[horizonService] failed to read joined transaction for operation ${op.id}: ${err}`);
        }
        return mapOperationToHistoryItem(op as unknown as HorizonOperationLike, tx, publicKey);
      })
    );
  }

  async getTransactionDetail(hash: string, perspective?: string): Promise<{
    hash: string;
    ledger: number;
    createdAt: string;
    successful: boolean;
    sourceAccount: string;
    feeAccount: string;
    fee: string;
    maxFee: string;
    memo: string | null;
    memoType: string | null;
    operationCount: number;
    perspective: string;
    operations: HistoryItem[];
    explorerUrl: string | null;
  }> {
    let tx: StellarSdk.Horizon.ServerApi.TransactionRecord;
    try {
      tx = await this.server.transactions().transaction(hash).call();
    } catch (err) {
      if (hasResponseStatus(err, 404)) {
        throw new NotFoundError(`Transaction ${hash} was not found on Horizon`, "TRANSACTION_NOT_FOUND");
      }
      throw err;
    }

    const ops = await this.server
      .operations()
      .forTransaction(hash)
      .includeFailed(true)
      .limit(200)
      .call();

    const viewer = perspective ?? tx.source_account;
    const txLike = tx as unknown as HorizonTransactionLike;
    return {
      hash: tx.hash,
      ledger: tx.ledger_attr,
      createdAt: tx.created_at,
      successful: tx.successful,
      sourceAccount: tx.source_account,
      feeAccount: tx.fee_account,
      fee: stroopsToXlm(tx.fee_charged),
      maxFee: stroopsToXlm(tx.max_fee),
      memo: tx.memo ?? null,
      memoType: tx.memo_type,
      operationCount: tx.operation_count,
      perspective: viewer,
      operations: ops.records.map((op) => mapOperationToHistoryItem(op as unknown as HorizonOperationLike, txLike, viewer)),
      explorerUrl: explorerTxUrl(this.networkPassphrase, tx.hash),
    };
  }

  async destinationRequiresMemo(publicKey: string): Promise<boolean> {
    try {
      const account = await this.getAccount(publicKey);
      return accountRequiresMemo(account);
    } catch {
      return false;
    }
  }

  async currentBaseFee(): Promise<number> {
    return this.server.fetchBaseFee();
  }

  async findStrictSendPaths(
    sourcePublicKey: string,
    sendAsset: StellarSdk.Asset,
    sendAmount: string,
    destinationAssets: StellarSdk.Asset[]
  ): Promise<StellarSdk.Horizon.ServerApi.PaymentPathRecord[]> {
    return this.server
      .strictSendPaths(sourcePublicKey, sendAsset, sendAmount, destinationAssets)
      .call();
  }

  async findStrictReceivePaths(
    destinationPublicKey: string,
    receiveAsset: StellarSdk.Asset,
    receiveAmount: string,
    sourceAssets: StellarSdk.Asset[]
  ): Promise<StellarSdk.Horizon.ServerApi.PaymentPathRecord[]> {
    return this.server
      .strictReceivePaths(destinationPublicKey, receiveAsset, receiveAmount, sourceAssets)
      .call();
  }

  async precheckSend(
    sourcePublicKey: string,
    destinationPublicKey: string,
    amount: string,
    asset?: string
  ): Promise<{ warnings: SendPrecheckWarning[]; blocking: boolean; operationType: "payment" | "createAccount"; spendable: string | undefined }> {
    const warnings: SendPrecheckWarning[] = [];
    const stellarAsset = asset ? this.parseAsset(asset) : StellarSdk.Asset.native();
    const destination = baseAccountId(destinationPublicKey);

    // Check if source account exists
    const sourceAccount = await this.loadAccountOrNull(sourcePublicKey);
    if (!sourceAccount) {
      warnings.push({
        code: "SOURCE_NOT_FUNDED",
        message: `Source account ${sourcePublicKey} does not exist`,
        blocking: true,
      });
    }

    // Check if destination account exists
    const destinationAccount = await this.loadAccountOrNull(destination);
    const operationType: "payment" | "createAccount" = destinationAccount ? "payment" : "createAccount";

    // Check memo requirement
    if (operationType === "payment") {
      const requiresMemo = await this.destinationRequiresMemo(destination);
      if (requiresMemo) {
        warnings.push({
          code: "MEMO_REQUIRED",
          message: "Destination account requires a memo",
          blocking: false,
        });
      }
    }

    // Check destination for createAccount
    if (operationType === "createAccount") {
      if (!stellarAsset.isNative()) {
        warnings.push({
          code: "DESTINATION_NOT_FUNDED",
          message: `Destination ${destination} does not exist. Only XLM can be sent via createAccount.`,
          blocking: true,
        });
      } else {
        const amountStroops = BigInt(toStroops(amount));
        const minStartingBalance = BigInt(toStroops("1"));
        if (amountStroops < minStartingBalance) {
          warnings.push({
            code: "DESTINATION_NOT_FUNDED",
            message: `Creating account requires at least 1 XLM, trying to send ${amount}`,
            blocking: true,
          });
        }
      }
    }

    // Check source spendable balance
    let spendable: string | undefined;
    if (sourceAccount) {
      const maxSpendable = BigInt(sourceAccount.max_spendable);
      const amountStroops = BigInt(toStroops(amount));
      if (maxSpendable < amountStroops) {
        spendable = fromStroops(maxSpendable);
        warnings.push({
          code: "AMOUNT_EXCEEDS_SPENDABLE",
          message: `Insufficient balance. Maximum sendable: ${spendable}`,
          blocking: true,
        });
      } else {
        spendable = fromStroops(maxSpendable);
      }
    }

    const blocking = warnings.some((w) => w.blocking);
    return { warnings, blocking, operationType, spendable };
  }

  private parseAsset(asset: string): StellarSdk.Asset {
    return asset.toUpperCase() === "XLM" ? StellarSdk.Asset.native() : new StellarSdk.Asset(asset.split(":")[0], asset.split(":")[1]);
  }
}

function hasResponseStatus(err: unknown, status: number): boolean {
  return (err as { response?: { status?: number } })?.response?.status === status;
}

interface PaymentHistoryItem {
  id: string;
  type: string;
  transactionHash: string;
  createdAt: string;
  from: string | undefined;
  to: string | undefined;
  amount: string | undefined;
  assetType: string | undefined;
  assetCode: string | undefined;
  assetIssuer: string | undefined;
  memo: string | undefined;
  flags: PaymentFlag[];
}
