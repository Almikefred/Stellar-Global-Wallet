/**
 * Legacy Stellar API service - backwards compatibility wrapper.
 *
 * This file composes the split modules to maintain the original public API.
 * New code should import from the specific modules:
 *   - transactionBuilder.ts for pure transaction building
 *   - horizonService.ts for Horizon read operations
 *   - transactionSubmitter.ts for submission with locking/retries
 *
 * This service is kept small (< 500 lines) for maintainability.
 */

import { AccountLock, InProcessAccountLock } from "./locks/accountLock";
import { BuiltTransactionRegistry, BuildIntent } from "./builtTransactions";
import { HorizonService } from "./horizonService";
import { TransactionSubmitter, MAX_SEQ_RETRIES, RETRY_BASE_DELAY_MS, PATH_EXPIRED_OPERATION_CODES } from "./transactionSubmitter";
import { describeUnsignedTransaction, UnsignedTransactionInfo } from "./transactionEnvelope";
import { baseAccountId } from "./transactionBuilder";
import type { TransactionSummary, TransactionDetail } from "@stellar-global-wallet/types";
import { config } from "../config";
import * as StellarSdk from "@stellar/stellar-sdk";
import { SendOperationType, SendPrecheckWarning, SendPrecheckResult, PathPaymentBuild, PaymentHistoryItem, PaymentExportRecord, MIN_STARTING_BALANCE } from "./transactionBuilder";

// Re-exported for backward compatibility
export type { TransactionSummary, PathPaymentBuild, SendPrecheckWarning, SendPrecheckResult, PaymentHistoryItem, PaymentExportRecord, SendOperationType };

export class StellarService {
  private horizonService: HorizonService;
  private transactionSubmitter: TransactionSubmitter;
  private builtTxs: BuiltTransactionRegistry | null;

  constructor(
    accountLock: AccountLock = new InProcessAccountLock(),
    builtTxs: BuiltTransactionRegistry | null = null
  ) {
    const server = new StellarSdk.Horizon.Server(config.HORIZON_URL);
    this.horizonService = new HorizonService({
      server,
      networkPassphrase: config.NETWORK_PASSPHRASE,
    });
    this.transactionSubmitter = new TransactionSubmitter({
      horizonService: this.horizonService,
      accountLock,
      builtTransactionRegistry: builtTxs ?? undefined,
    });
    this.builtTxs = builtTxs;
  }

  /** Record an unsigned transaction a build endpoint is about to return (#194). */
  protected async recordBuilt(tx: StellarSdk.Transaction, intent: BuildIntent): Promise<void> {
    if (this.builtTxs) await this.builtTxs.record(tx, intent);
  }

  // Pure build operations (delegated to transactionBuilder)

  async buildPayment(params: {
    sourcePublicKey: string;
    destinationPublicKey: string;
    amount: string;
    asset?: string;
    memo?: string;
  }): Promise<UnsignedTransactionInfo & { operationType: SendOperationType }> {
    const { sourcePublicKey, destinationPublicKey, amount, asset, memo } = params;
    const sourceAccount = await this.horizonService.loadAccountOrNull(sourcePublicKey);
    if (!sourceAccount) {
      throw new Error(`Source account ${sourcePublicKey} not found`);
    }

    const { operationType } = await this.transactionSubmitter["getSendOperationType"](
      destinationPublicKey,
      asset,
      amount
    );

    const destination = baseAccountId(destinationPublicKey);
    const stellarAsset = asset ? this.parseAsset(asset) : StellarSdk.Asset.native();
    
    const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: await this.horizonService.currentBaseFee(),
      networkPassphrase: config.NETWORK_PASSPHRASE,
    })
      .addOperation(StellarSdk.Operation.payment({
        destination,
        asset: stellarAsset,
        amount,
      }))
      .setTimeout(180);
    if (memo) builder.addMemo(StellarSdk.Memo.text(memo));

    const tx = builder.build();
    await this.recordBuilt(tx, {
      kind: "payment",
      params: { sourcePublicKey, destinationPublicKey, amount, asset: asset ?? "XLM", operationType },
    });

    return {
      ...describeUnsignedTransaction(tx, config.NETWORK_PASSPHRASE),
      operationType,
    };
  }

  // Horizon read operations (delegated to horizonService)

  async getAccount(publicKey: string) {
    return this.horizonService.getAccount(publicKey);
  }

  async loadAccountOrNull(publicKey: string) {
    return this.horizonService.loadAccountOrNull(publicKey);
  }

  async getBalances(publicKey: string) {
    return this.horizonService.getBalances(publicKey);
  }

  async getTransactions(
    publicKey: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{
    transactions: TransactionSummary[];
    next: string | undefined;
    hasMore: boolean;
  }>;
  async getTransactions(publicKey: string, limit: number): Promise<TransactionSummary[]>;
  async getTransactions(
    publicKey: string,
    optionsOrLimit?: { limit?: number; cursor?: string } | number
  ) {
    return this.horizonService.getTransactions(publicKey, optionsOrLimit as any);
  }

  async getPaymentHistory(
    publicKey: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{
    payments: PaymentHistoryItem[];
    next: string | undefined;
    hasMore: boolean;
  }> {
    return this.horizonService.getPaymentHistory(publicKey, options);
  }

  async getHistory(
    publicKey: string,
    options: { limit?: number; cursor?: string; filters?: any } = {}
  ) {
    return this.horizonService.getHistory(publicKey, options);
  }

  async getTransactionDetail(hash: string, perspective?: string): Promise<TransactionDetail> {
    const detail = await this.horizonService.getTransactionDetail(hash, perspective);
    return {
      hash: detail.hash,
      ledger: detail.ledger,
      createdAt: detail.createdAt,
      successful: detail.successful,
      sourceAccount: detail.sourceAccount,
      feeAccount: detail.feeAccount,
      fee: detail.fee,
      maxFee: detail.maxFee,
      memo: detail.memo,
      memoType: detail.memoType,
      operationCount: detail.operationCount,
      perspective: detail.perspective,
      operations: detail.operations,
      explorerUrl: detail.explorerUrl,
    };
  }

  async destinationRequiresMemo(publicKey: string): Promise<boolean> {
    return this.horizonService.destinationRequiresMemo(publicKey);
  }

  async currentBaseFee(): Promise<number> {
    return this.horizonService.currentBaseFee();
  }

  // Submission operations (delegated to transactionSubmitter)

  async sendPayment(params: {
    sourceSecretKey: string;
    destinationPublicKey: string;
    amount: string;
    asset?: string;
    memo?: string;
  }) {
    return this.transactionSubmitter.sendPayment(params);
  }

  async pathPaymentStrictSend(params: {
    sourceSecretKey: string;
    sendAsset: string;
    sendAmount: string;
    destinationPublicKey: string;
    destAsset: string;
    destMin: string;
    path: string[];
    memo?: string;
  }) {
    return this.transactionSubmitter.pathPaymentStrictSend(params);
  }

  async pathPaymentStrictReceive(params: {
    sourceSecretKey: string;
    sendAsset: string;
    sendMax: string;
    destinationPublicKey: string;
    destAsset: string;
    destAmount: string;
    path: string[];
    memo?: string;
  }) {
    return this.transactionSubmitter.pathPaymentStrictReceive(params);
  }

  async submitSigned(params: { signedXdr: string }) {
    return this.transactionSubmitter.submitSigned(params);
  }

  // Key management

  generateKeypair(): StellarSdk.Keypair {
    return StellarSdk.Keypair.random();
  }

  private parseAsset(asset: string): StellarSdk.Asset {
    return asset.toUpperCase() === "XLM" ? StellarSdk.Asset.native() : new StellarSdk.Asset(asset.split(":")[0], asset.split(":")[1]);
  }
}
