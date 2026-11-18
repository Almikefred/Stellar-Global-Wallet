import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config";
import {
  SorobanRebuildRequiredError,
  SorobanSimulationError,
  SorobanTransactionError,
  SorobanUnavailableError,
} from "./sorobanErrors";
import { getCachedSimulate, setCachedSimulate } from "./sorobanCache";
import { SourceAccountNotFoundError, TransactionExpiredError } from "./stellarErrors";
import {
  assertNotExpired,
  BUILD_TIMEOUT_SECONDS,
  describeUnsignedTransaction,
  parseSignedTransaction,
  SubmitSignedPending,
  SubmitSignedResult,
  UnsignedTransactionInfo,
} from "./transactionEnvelope";

const { rpc } = StellarSdk;

// Soroban RPC's getTransaction reports NOT_FOUND until the ledger closes
// (~5s on testnet/mainnet). Polling every 1.5s up to 30s comfortably covers
// normal ledger close time plus retries without hanging a request forever.
const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 30_000;

export interface ContractCallResult<T = unknown> {
  result: T;
  hash: string;
  ledger: number;
}

/** A simulated and assembled invocation, ready for the user to sign. */
export interface PreparedInvocation extends UnsignedTransactionInfo {
  /** Soroban resource fee (stroops) added to the inclusion fee by simulation. */
  minResourceFee: string;
  /**
   * Authorization entries from simulation, base64 XDR. Entries that use
   * address credentials must be signed too; source-account entries are
   * covered by signing the envelope.
   */
  authEntries: string[];
  /** Ledger the simulation ran against. */
  latestLedger: number;
  /**
   * Present when simulation found archived entries in the footprint (#185):
   * an unsigned RestoreFootprint transaction that must be signed and
   * submitted *before* the main transaction. The main transaction's
   * sequence number already accounts for it (restore = n+1, invoke = n+2).
   */
  restore?: {
    transactionXdr: string;
    hash: string;
    minResourceFee: string;
  };
}

/**
 * Builds a RestoreFootprint transaction from a simulation's
 * `restorePreamble` (#185). The resource fee from the preamble is added to
 * the base fee, and the preamble's footprint is attached as Soroban data so
 * the network restores exactly the archived entries the invocation needs.
 */
export function buildRestoreTransaction(
  sourceAccount: StellarSdk.Account,
  restorePreamble: { minResourceFee: string; transactionData: StellarSdk.SorobanDataBuilder },
  networkPassphrase: string,
  timeoutSeconds = 30
): StellarSdk.Transaction {
  const fee = (BigInt(StellarSdk.BASE_FEE) + BigInt(restorePreamble.minResourceFee)).toString();
  return new StellarSdk.TransactionBuilder(sourceAccount, { fee, networkPassphrase })
    .setSorobanData(restorePreamble.transactionData.build())
    .addOperation(StellarSdk.Operation.restoreFootprint({}))
    .setTimeout(timeoutSeconds)
    .build();
}

export class SorobanService {
  private readonly server: StellarSdk.rpc.Server;
  private readonly networkPassphrase: string;

  constructor() {
    this.networkPassphrase = config.SOROBAN_NETWORK_PASSPHRASE;
    this.server = new rpc.Server(config.SOROBAN_RPC_URL);
  }

  /**
   * Simulates a contract call and returns the decoded return value without
   * ever submitting a transaction. Use for read-only functions (e.g.
   * `get_assets`) — free, no state change, no signing key required. The
   * given `sourcePublicKey` only pays the (simulated, never-charged)
   * transaction's nominal source-account role; it does not need to match
   * any address referenced by the call.
   */
  async simulate<T = unknown>(params: {
    contractId: string;
    method: string;
    args: StellarSdk.xdr.ScVal[];
    sourcePublicKey: string;
  }): Promise<T> {
    const { contractId, method, args, sourcePublicKey } = params;

    // #86 — Redis cache: encode args as base64 XDR for a stable cache key.
    // scValToNative is not round-trippable, so we key on the raw XDR bytes.
    const argsKey = Buffer.from(args.map((a) => a.toXDR("base64")).join("|")).toString(
      "base64"
    );
    const cached = await getCachedSimulate<T>(contractId, method, argsKey);
    if (cached !== null) return cached;

    // Simulation never checks the source's sequence number, so a read with
    // no natural caller (e.g. guardians(), #51) can use an account that
    // doesn't exist on-chain — same fallback as buildUnsignedTransaction.
    let sourceAccount: StellarSdk.Account;
    try {
      sourceAccount = await this.server.getAccount(sourcePublicKey);
    } catch {
      sourceAccount = new StellarSdk.Account(sourcePublicKey, "0");
    }
    const tx = this.buildInvocation(sourceAccount, contractId, method, args);

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new SorobanSimulationError(
        `Simulation failed for ${contractId}.${method}: ${sim.error}`,
        sim.error
      );
    }
    const result = this.parseSimResult<T>(sim);
    await setCachedSimulate(contractId, method, argsKey, result);
    return result;
  }

  /**
   * Simulates, then — only if simulation succeeds — assembles, signs, and
   * submits the invocation, polling until the network reports a final
   * status. `sourceSecretKey` both pays the fee and provides the signature;
   * for globe-wallet's user-scoped functions (e.g. `record_spend`) this must
   * be the same account passed as the `user` argument, since that's whose
   * `require_auth()` the contract checks.
   */
  async invoke<T = unknown>(params: {
    contractId: string;
    method: string;
    args: StellarSdk.xdr.ScVal[];
    sourceSecretKey: string;
  }): Promise<ContractCallResult<T>> {
    const { contractId, method, args, sourceSecretKey } = params;
    const keypair = StellarSdk.Keypair.fromSecret(sourceSecretKey);
    let sourceAccount = await this.server.getAccount(keypair.publicKey());
    let tx = this.buildInvocation(sourceAccount, contractId, method, args);

    // Simulation-before-submission: this is what lets us reject a doomed
    // call (bad args, insufficient auth, a contract error like
    // SpendLimitExceeded) before ever paying network fees or waiting on
    // ledger close. sendTransaction is never reached below this point on a
    // failed simulation.
    let sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new SorobanSimulationError(
        `Simulation failed for ${contractId}.${method}: ${sim.error}`,
        sim.error
      );
    }

    // #185 — archived entries in the footprint: restore them first, then
    // rebuild and re-simulate against the restored state.
    if (rpc.Api.isSimulationRestore(sim)) {
      await this.submitRestore(keypair, sim.restorePreamble);
      sourceAccount = await this.server.getAccount(keypair.publicKey());
      tx = this.buildInvocation(sourceAccount, contractId, method, args);
      sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        throw new SorobanSimulationError(
          `Simulation failed for ${contractId}.${method} after restore: ${sim.error}`,
          sim.error
        );
      }
    }

    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(keypair);

    const send = await this.server.sendTransaction(prepared);
    if (send.status === "ERROR") {
      throw new SorobanSimulationError(
        `${contractId}.${method} was rejected before entering the ledger (status: ${send.status})`,
        send.errorResult ? send.errorResult.toXDR("base64") : send.status
      );
    }

    const final = await this.pollTransaction(send.hash);
    if (final.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const result =
        final.returnValue !== undefined
          ? (StellarSdk.scValToNative(final.returnValue) as T)
          : (undefined as T);
      return { result, hash: send.hash, ledger: final.ledger };
    }

    if (final.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new SorobanTransactionError(
        `${contractId}.${method} passed simulation but failed on-chain (hash ${send.hash})`,
        send.hash
      );
    }

    throw new SorobanTransactionError(
      `${contractId}.${method} did not reach a final status within ${POLL_TIMEOUT_MS}ms (hash ${send.hash})`,
      send.hash
    );
  }

  /** Signs, submits and waits for a RestoreFootprint transaction (#185). */
  private async submitRestore(
    keypair: StellarSdk.Keypair,
    preamble: { minResourceFee: string; transactionData: StellarSdk.SorobanDataBuilder }
  ): Promise<void> {
    const account = await this.server.getAccount(keypair.publicKey());
    const restoreTx = buildRestoreTransaction(account, preamble, this.networkPassphrase);
    restoreTx.sign(keypair);
    const send = await this.server.sendTransaction(restoreTx);
    if (send.status === "ERROR") {
      throw new SorobanSimulationError(
        "RestoreFootprint was rejected before entering the ledger",
        send.errorResult ? send.errorResult.toXDR("base64") : send.status
      );
    }
    const final = await this.pollTransaction(send.hash);
    if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new SorobanTransactionError(
        `RestoreFootprint did not succeed (hash ${send.hash}, status ${final.status})`,
        send.hash
      );
    }
  }

  private buildInvocation(
    sourceAccount: StellarSdk.Account,
    contractId: string,
    method: string,
    args: StellarSdk.xdr.ScVal[],
    timeoutSeconds = 30
  ) {
    const contract = new StellarSdk.Contract(contractId);
    return new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(timeoutSeconds)
      .build();
  }

  private parseSimResult<T>(sim: StellarSdk.rpc.Api.SimulateTransactionSuccessResponse): T {
    if (!sim.result) return undefined as T;
    return StellarSdk.scValToNative(sim.result.retval) as T;
  }

  private async pollTransaction(
    hash: string
  ): Promise<StellarSdk.rpc.Api.GetTransactionResponse> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let response = await this.server.getTransaction(hash);
    while (
      response.status === rpc.Api.GetTransactionStatus.NOT_FOUND &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      response = await this.server.getTransaction(hash);
    }
    return response;
  }

  /**
   * Non-custodial counterpart to {@link invoke}: simulates the call and
   * returns the assembled (footprint + resource fee) transaction *unsigned*,
   * for the user's wallet to sign. Unlike {@link buildUnsignedTransaction}
   * the source account must exist (its sequence number is used) and a failed
   * simulation is an error, never a silent fallback to an unprepared XDR.
   */
  async prepareInvocation(params: {
    contractId: string;
    method: string;
    args: StellarSdk.xdr.ScVal[];
    sourcePublicKey: string;
  }): Promise<PreparedInvocation> {
    const { contractId, method, args, sourcePublicKey } = params;

    let sourceAccount: StellarSdk.Account;
    try {
      sourceAccount = await this.server.getAccount(sourcePublicKey);
    } catch (err) {
      if (err instanceof Error && /account not found/i.test(err.message)) {
        throw new SourceAccountNotFoundError(sourcePublicKey);
      }
      throw new SorobanUnavailableError();
    }

    const tx = this.buildInvocation(sourceAccount, contractId, method, args, BUILD_TIMEOUT_SECONDS);
    let sim: StellarSdk.rpc.Api.SimulateTransactionResponse;
    try {
      sim = await this.server.simulateTransaction(tx);
    } catch {
      throw new SorobanUnavailableError();
    }
    if (rpc.Api.isSimulationError(sim)) {
      throw new SorobanSimulationError(
        `Simulation failed for ${contractId}.${method}: ${sim.error}`,
        sim.error
      );
    }

    // #185 — archived entries: hand back a RestoreFootprint tx to sign
    // first (sequence n+1) and rebuild the invocation at n+2 so both can be
    // submitted back to back without another round trip.
    let restore: PreparedInvocation["restore"];
    let invocationTx = tx;
    if (rpc.Api.isSimulationRestore(sim)) {
      // Building `tx` above bumped `sourceAccount` to n+1; start again from n.
      const base = new StellarSdk.Account(
        sourcePublicKey,
        (BigInt(sourceAccount.sequenceNumber()) - 1n).toString()
      );
      const restoreTx = buildRestoreTransaction(
        base,
        sim.restorePreamble,
        this.networkPassphrase,
        BUILD_TIMEOUT_SECONDS
      );
      restore = {
        transactionXdr: restoreTx.toXDR(),
        hash: restoreTx.hash().toString("hex"),
        minResourceFee: sim.restorePreamble.minResourceFee,
      };
      invocationTx = this.buildInvocation(base, contractId, method, args, BUILD_TIMEOUT_SECONDS);
    }

    const prepared = rpc.assembleTransaction(invocationTx, sim).build();
    return {
      ...describeUnsignedTransaction(prepared, this.networkPassphrase),
      minResourceFee: sim.minResourceFee,
      authEntries: (sim.result?.auth ?? []).map((entry) => entry.toXDR("base64")),
      latestLedger: sim.latestLedger,
      ...(restore ? { restore } : {}),
    };
  }

  /**
   * Submits a client-signed Soroban transaction and polls until the network
   * reports a final status. Never re-simulates or re-signs: the user signed a
   * specific footprint, so anything that invalidates it (moved ledger, stale
   * sequence, expiry) is reported for the client to rebuild. If the network
   * hasn't decided within the polling window the hash comes back as pending.
   */
  async submitSigned(params: { signedXdr: string }): Promise<SubmitSignedResult | SubmitSignedPending> {
    const parsed = parseSignedTransaction(params.signedXdr, this.networkPassphrase);
    assertNotExpired(parsed.transaction);

    let send: StellarSdk.rpc.Api.SendTransactionResponse;
    try {
      send = await this.server.sendTransaction(parsed.transaction);
    } catch {
      throw new SorobanUnavailableError();
    }

    if (send.status === "ERROR") throw translateSendError(send, parsed.hash);
    if (send.status === "TRY_AGAIN_LATER") {
      throw new SorobanUnavailableError("Soroban RPC is busy. Try again shortly.");
    }

    // PENDING, or DUPLICATE (already queued by an earlier submit): wait for the outcome.
    const final = await this.pollTransaction(send.hash);
    if (final.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { hash: send.hash, ledger: final.ledger, successful: true };
    }
    if (final.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new SorobanTransactionError(
        `Transaction failed on-chain after passing simulation (hash ${send.hash})`,
        send.hash
      );
    }
    return { hash: send.hash, status: "pending" };
  }

  /**
   * Builds an unsigned transaction XDR for a contract call.
   * Assembles simulation footprint and auth when simulation succeeds.
   */
  async buildUnsignedTransaction(params: {
    contractId: string;
    method: string;
    args: StellarSdk.xdr.ScVal[];
    sourcePublicKey: string;
  }): Promise<string> {
    const { contractId, method, args, sourcePublicKey } = params;
    let sourceAccount: StellarSdk.Account;
    try {
      sourceAccount = await this.server.getAccount(sourcePublicKey);
    } catch {
      sourceAccount = new StellarSdk.Account(sourcePublicKey, "0");
    }
    const tx = this.buildInvocation(sourceAccount, contractId, method, args);

    try {
      const sim = await this.server.simulateTransaction(tx);
      if (!rpc.Api.isSimulationError(sim)) {
        const prepared = rpc.assembleTransaction(tx, sim).build();
        return prepared.toXDR();
      }
    } catch {
      // Fall back to invocation transaction if simulation is not supported
    }

    return tx.toXDR();
  }

  /**
   * Reads `liveUntilLedgerSeq` for each ledger key (#185 TTL keeper). Keys
   * that have no live entry (never written, or archived) are absent from
   * the returned map, keyed by the base64 XDR of the LedgerKey.
   */
  async getLiveUntil(keys: StellarSdk.xdr.LedgerKey[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (keys.length === 0) return out;
    const res = await this.server.getLedgerEntries(...keys);
    for (const entry of res.entries) {
      if (typeof entry.liveUntilLedgerSeq === "number") {
        out.set(entry.key.toXDR("base64"), entry.liveUntilLedgerSeq);
      }
    }
    return out;
  }

  /**
   * Returns the latest ledger sequence from Soroban RPC.
   */
  async getLatestLedger(): Promise<number> {
    const latest = await this.server.getLatestLedger();
    return latest.sequence;
  }
}

/** Result codes that mean the signed transaction is stale and the client must rebuild it. */
const REBUILD_RESULT_CODES = ["txSorobanInvalid", "txBadSeq", "txInsufficientFee"];

function translateSendError(send: StellarSdk.rpc.Api.SendTransactionResponse, hash: string): Error {
  const resultCode = send.errorResult?.result().switch().name ?? "unknown";
  if (resultCode === "txTooLate") {
    return new TransactionExpiredError("The transaction expired before it reached the network. Build a new one and sign it again.");
  }
  if (REBUILD_RESULT_CODES.includes(resultCode)) {
    return new SorobanRebuildRequiredError(
      `The prepared transaction is no longer valid (${resultCode}). Build it again and sign the new one.`,
      resultCode
    );
  }
  return new SorobanSimulationError(
    `Transaction ${hash} was rejected before entering the ledger (${resultCode})`,
    send.errorResult ? send.errorResult.toXDR("base64") : resultCode
  );
}
