/**
 * Hermetic local-quickstart end-to-end suite (#232):
 * Exercises the FULL stack — deployed Soroban contracts (`globe-wallet` +
 * `token-wrapper`), Express backend API, and `@globe-wallet/sdk` (`ApiClient`
 * + `GlobeWalletClient` + `sacTokenId`) — against a local `stellar/quickstart`
 * container (`--local --enable-soroban-rpc`).
 *
 * Zero dependency on public testnet or Friendbot rate limits.
 *
 * Prerequisites:
 *   docker compose --profile local up -d postgres redis stellar
 *   ./contract/scripts/deploy-local.sh
 *
 * Run locally:
 *   npm run test:e2e:local --workspace backend
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  ApiError,
  GlobeWalletClient,
  InMemoryTokenStore,
  createClient,
  sacTokenId,
} from "@globe-wallet/sdk";
import { createApp } from "../../src/app";
import { ensureAuditTable, pool } from "../../src/db";
import { initKeys } from "../../src/utils/jwtKeys";
import { StellarService } from "../../src/services/stellar";
import { SorobanService } from "../../src/services/soroban";
import { GlobeWalletContract } from "../../src/services/contracts/globeWallet";
import {
  BuiltTransactionRegistry,
  InMemoryBuiltTransactionStore,
} from "../../src/services/builtTransactions";
import { InProcessAccountLock } from "../../src/services/locks/accountLock";
import { E2eArtifactRecorder } from "./helpers/e2eArtifacts";

const localE2eEnabled = process.env.E2E_LOCAL === "1";
const maybeDescribe = localE2eEnabled ? describe : describe.skip;

interface LocalDeploymentManifest {
  network: string;
  horizonUrl?: string;
  rpcUrl: string;
  friendbotUrl?: string;
  networkPassphrase: string;
  deployerAddress?: string;
  contracts: {
    "globe-wallet": string;
    "token-wrapper": string;
  };
}

function loadLocalDeployment(): LocalDeploymentManifest {
  const manifestPath =
    process.env.E2E_LOCAL_MANIFEST ??
    path.resolve(__dirname, "../../../contract/deployments/local.json");

  if (fs.existsSync(manifestPath)) {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as LocalDeploymentManifest;
  }

  const contractId = process.env.GLOBE_WALLET_CONTRACT_ID;
  if (!contractId) {
    throw new Error(
      `No local deployment manifest found at ${manifestPath} and GLOBE_WALLET_CONTRACT_ID is unset. ` +
        "Run ./contract/scripts/deploy-local.sh first."
    );
  }

  return {
    network: "local",
    horizonUrl: process.env.E2E_LOCAL_HORIZON_URL ?? "http://localhost:8000",
    rpcUrl: process.env.E2E_LOCAL_RPC_URL ?? "http://localhost:8000/soroban/rpc",
    friendbotUrl: process.env.E2E_LOCAL_FRIENDBOT_URL ?? "http://localhost:8000/friendbot",
    networkPassphrase:
      process.env.E2E_LOCAL_NETWORK_PASSPHRASE ?? "Standalone Network ; February 2017",
    contracts: {
      "globe-wallet": contractId,
      "token-wrapper": process.env.TOKEN_WRAPPER_CONTRACT_ID ?? "",
    },
  };
}

async function withRetries<T>(fn: () => Promise<T>, attempts = 5, delayMs = 1500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

async function fundLocalAccount(friendbotUrl: string, horizonUrl: string): Promise<StellarSdk.Keypair> {
  const kp = StellarSdk.Keypair.random();
  await withRetries(async () => {
    const res = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(kp.publicKey())}`);
    if (!res.ok) {
      const check = await fetch(`${horizonUrl}/accounts/${kp.publicKey()}`);
      if (!check.ok) {
        throw new Error(`Local Friendbot failed for ${kp.publicKey()}: ${res.status}`);
      }
    }
  });
  return kp;
}

function signXdrLocally(xdr: string, passphrase: string, signer: StellarSdk.Keypair): string {
  const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, passphrase);
  tx.sign(signer);
  return tx.toXDR();
}

function createSdkContractClient(
  contractId: string,
  rpcUrl: string,
  networkPassphrase: string,
  signer: StellarSdk.Keypair
): GlobeWalletClient {
  return new GlobeWalletClient({
    contractId,
    networkPassphrase,
    rpcUrl,
    allowHttp: rpcUrl.startsWith("http://"),
    publicKey: signer.publicKey(),
    signTransaction: async (txXdr: string) => ({
      signedTxXdr: signXdrLocally(txXdr, networkPassphrase, signer),
      signerAddress: signer.publicKey(),
    }),
  });
}

async function authenticateViaSep10(
  apiBaseUrl: string,
  keypair: StellarSdk.Keypair,
  recorder: E2eArtifactRecorder
) {
  const tokenStore = new InMemoryTokenStore();
  const sdk = createClient({ baseUrl: apiBaseUrl, tokenStore, maxRetries: 2 });

  const challenge = await sdk.request<{ transaction: string; networkPassphrase: string }>(
    `/api/v1/auth/challenge?account=${encodeURIComponent(keypair.publicKey())}`
  );
  recorder.record("auth", "SEP-10 challenge received", {
    account: keypair.publicKey(),
    networkPassphrase: challenge.networkPassphrase,
  });

  const signedChallenge = signXdrLocally(
    challenge.transaction,
    challenge.networkPassphrase,
    keypair
  );
  const tokenRes = await sdk.request<{
    accessToken: string;
    refreshToken: string;
    account: string;
  }>("/api/v1/auth/token", {
    method: "POST",
    body: { transaction: signedChallenge },
  });

  tokenStore.set({
    accessToken: tokenRes.accessToken,
    refreshToken: tokenRes.refreshToken,
  });
  recorder.record("auth", "SEP-10 JWT issued", { account: tokenRes.account });
  return { sdk, tokenStore };
}

maybeDescribe("Local quickstart E2E: contract + backend + SDK (#232)", () => {
  const recorder = new E2eArtifactRecorder("local-quickstart-e2e");

  let deployment: LocalDeploymentManifest;
  let horizonUrl: string;
  let rpcUrl: string;
  let friendbotUrl: string;
  let networkPassphrase: string;
  let globeWalletContractId: string;

  let server: http.Server;
  let apiBaseUrl: string;

  let owner: StellarSdk.Keypair;
  let recipient: StellarSdk.Keypair;
  let guardian1: StellarSdk.Keypair;
  let guardian2: StellarSdk.Keypair;
  let guardian3: StellarSdk.Keypair;
  let recoveryCandidate: StellarSdk.Keypair;

  beforeAll(async () => {
    deployment = loadLocalDeployment();
    horizonUrl = process.env.E2E_LOCAL_HORIZON_URL ?? deployment.horizonUrl ?? "http://localhost:8000";
    rpcUrl = process.env.E2E_LOCAL_RPC_URL ?? deployment.rpcUrl;
    friendbotUrl =
      process.env.E2E_LOCAL_FRIENDBOT_URL ?? deployment.friendbotUrl ?? `${horizonUrl}/friendbot`;
    networkPassphrase =
      process.env.E2E_LOCAL_NETWORK_PASSPHRASE ?? deployment.networkPassphrase;
    globeWalletContractId = deployment.contracts["globe-wallet"];

    process.env.HORIZON_URL = horizonUrl;
    process.env.SOROBAN_RPC_URL = rpcUrl;
    process.env.NETWORK_PASSPHRASE = networkPassphrase;
    process.env.SOROBAN_NETWORK_PASSPHRASE = networkPassphrase;
    process.env.GLOBE_WALLET_CONTRACT_ID = globeWalletContractId;
    process.env.SEP10_SIGNING_SECRET ??= StellarSdk.Keypair.random().secret();

    await ensureAuditTable().catch(() => undefined);
    await initKeys().catch(() => undefined);

    const builtTxs = new BuiltTransactionRegistry(
      new InMemoryBuiltTransactionStore(),
      networkPassphrase
    );
    const stellar = new StellarService(new InProcessAccountLock(), builtTxs, {
      horizonUrl,
      networkPassphrase,
    });
    const soroban = new SorobanService({
      rpcUrl,
      networkPassphrase,
      pollIntervalMs: 1_000,
      pollTimeoutMs: 45_000,
    });
    const globeWallet = new GlobeWalletContract(soroban, globeWalletContractId);
    const app = createApp(stellar, globeWallet, undefined, {
      disableHealthCache: true,
      healthCheckDeps: { horizonUrl, sorobanRpcUrl: rpcUrl },
    });

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind ephemeral port for local E2E backend");
    }
    apiBaseUrl = `http://127.0.0.1:${address.port}`;

    recorder.record("setup", "Booted local E2E backend", {
      apiBaseUrl,
      horizonUrl,
      rpcUrl,
      globeWalletContractId,
    });

    [owner, recipient, guardian1, guardian2, guardian3, recoveryCandidate] = await Promise.all([
      fundLocalAccount(friendbotUrl, horizonUrl),
      fundLocalAccount(friendbotUrl, horizonUrl),
      fundLocalAccount(friendbotUrl, horizonUrl),
      fundLocalAccount(friendbotUrl, horizonUrl),
      fundLocalAccount(friendbotUrl, horizonUrl),
      fundLocalAccount(friendbotUrl, horizonUrl),
    ]);

    recorder.record("setup", "Funded 6 local quickstart accounts via Friendbot", {
      owner: owner.publicKey(),
      recipient: recipient.publicKey(),
      guardians: [guardian1.publicKey(), guardian2.publicKey(), guardian3.publicKey()],
      recoveryCandidate: recoveryCandidate.publicKey(),
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await pool.end().catch(() => undefined);
  });

  async function runWithArtifactCapture(testName: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const paths = recorder.writeFailureArtifact(testName, err);
      console.error(`[e2e-local] Failure diagnostics written to ${paths.mdPath}`);
      throw err;
    }
  }

  it("completes non-custodial send + idempotent replay + path payment via SDK and backend", async () => {
    await runWithArtifactCapture("send-and-path-payment", async () => {
      const { sdk } = await authenticateViaSep10(apiBaseUrl, owner, recorder);

      const health = await sdk.request<{ status: string }>("/health");
      expect(health.status).toBe("ok");

      const beforeBalances = await sdk.request<{ balances: Record<string, string> }>(
        `/api/v1/account/${recipient.publicKey()}/balances`
      );
      const beforeXlm = Number(beforeBalances.balances.XLM);

      // 1. Precheck send
      const precheck = await sdk.request<{ blocking: boolean; operationType: string }>(
        "/api/v1/wallet/send/precheck",
        {
          method: "POST",
          body: {
            sourcePublicKey: owner.publicKey(),
            destinationPublicKey: recipient.publicKey(),
            amount: "10",
          },
        }
      );
      expect(precheck.blocking).toBe(false);
      expect(precheck.operationType).toBe("payment");
      recorder.record("send", "Precheck passed", precheck);

      // 2. Build unsigned payment XDR -> sign locally -> submit with Idempotency-Key
      const built = await sdk.request<{ xdr: string; networkPassphrase: string }>(
        "/api/v1/wallet/send/build",
        {
          method: "POST",
          body: {
            sourcePublicKey: owner.publicKey(),
            destinationPublicKey: recipient.publicKey(),
            amount: "10",
            memo: "local-e2e",
          },
        }
      );
      const signedXdr = signXdrLocally(built.xdr, built.networkPassphrase, owner);
      const idempotencyKey = `e2e-send-${Date.now()}`;

      const submitted = await sdk.request<{ hash: string; successful: boolean }>(
        "/api/v1/wallet/submit",
        {
          method: "POST",
          idempotencyKey,
          body: { signedXdr },
        }
      );
      expect(submitted.successful).toBe(true);
      expect(submitted.hash).toMatch(/^[0-9a-f]{64}$/);
      recorder.record("send", "Payment submitted", submitted);

      // 3. Replay exact same Idempotency-Key -> identical hash, zero double-spend
      const replayed = await sdk.request<{ hash: string; successful: boolean }>(
        "/api/v1/wallet/submit",
        {
          method: "POST",
          idempotencyKey,
          body: { signedXdr },
        }
      );
      expect(replayed.hash).toBe(submitted.hash);
      expect(replayed.successful).toBe(true);

      const afterBalances = await sdk.request<{ balances: Record<string, string> }>(
        `/api/v1/account/${recipient.publicKey()}/balances`
      );
      expect(Number(afterBalances.balances.XLM)).toBeCloseTo(beforeXlm + 10, 5);
      recorder.record("send", "Verified balance delta (+10 XLM, no duplicate spend)", {
        beforeXlm,
        afterXlm: Number(afterBalances.balances.XLM),
      });

      // 4. Non-custodial strict-send path payment (same-asset XLM -> XLM)
      const pathBuilt = await sdk.request<{ xdr: string; networkPassphrase: string }>(
        "/api/v1/wallet/path-payment-strict-send/build",
        {
          method: "POST",
          body: {
            sourcePublicKey: owner.publicKey(),
            destinationPublicKey: recipient.publicKey(),
            sendAmount: "5",
            destAsset: "XLM",
            quotedDestAmount: "5",
          },
        }
      );
      const pathSigned = signXdrLocally(pathBuilt.xdr, pathBuilt.networkPassphrase, owner);
      const pathSubmitted = await sdk.request<{ hash: string; successful: boolean }>(
        "/api/v1/wallet/submit",
        {
          method: "POST",
          body: { signedXdr: pathSigned },
        }
      );
      expect(pathSubmitted.successful).toBe(true);
      recorder.record("send", "Path payment submitted", pathSubmitted);
    });
  });

  it("enforces spend limits and timelocked limit increases on the deployed globe-wallet contract", async () => {
    await runWithArtifactCapture("spend-limits", async () => {
      const { sdk } = await authenticateViaSep10(apiBaseUrl, owner, recorder);
      const ownerContract = createSdkContractClient(
        globeWalletContractId,
        rpcUrl,
        networkPassphrase,
        owner
      );

      // 1. Initialize deployed globe-wallet with owner as admin.
      const initTx = await ownerContract.initialize({ admin: owner.publicKey() });
      await initTx.signAndSend();
      recorder.record("contract", "Initialized globe-wallet admin", { admin: owner.publicKey() });

      const adminState = await sdk.request<{ admin: string; pendingAdmin: string | null }>(
        "/api/v1/contract/admin"
      );
      expect(adminState.admin).toBe(owner.publicKey());

      // 2. Register native XLM asset via backend build + local sign + backend submit.
      const addAssetBuilt = await sdk.request<{ xdr: string }>(
        "/api/v1/contract/wallet/assets/build",
        {
          method: "POST",
          body: { user: owner.publicKey(), asset: { code: "XLM", issuer: null } },
        }
      );
      const addAssetSigned = signXdrLocally(addAssetBuilt.xdr, networkPassphrase, owner);
      const addAssetSubmitted = await sdk.request<{ hash: string; successful: boolean }>(
        "/api/v1/contract/wallet/submit",
        {
          method: "POST",
          body: { signedXdr: addAssetSigned },
        }
      );
      expect(addAssetSubmitted.successful).toBe(true);

      const assets = await sdk.request<{ assets: Array<{ code: string }> }>(
        `/api/v1/contract/wallet/${owner.publicKey()}/assets`
      );
      expect(assets.assets.some((a) => a.code === "XLM")).toBe(true);
      recorder.record("limits", "Whitelisted XLM asset verified via backend", assets);

      // 3. Set rolling 24h spend limit on native XLM SAC token via @globe-wallet/sdk.
      const xlmTokenId = sacTokenId("XLM", null, networkPassphrase);
      const limitStroops = 500_000_000n; // 50 XLM
      const setLimitTx = await ownerContract.set_spend_limit({
        user: owner.publicKey(),
        token_id: xlmTokenId,
        limit: limitStroops,
      });
      await setLimitTx.signAndSend();

      const allowanceBefore = await ownerContract.get_spend_allowance({
        user: owner.publicKey(),
        token_id: xlmTokenId,
      });
      expect(allowanceBefore.result.limit).toBe(limitStroops);
      expect(allowanceBefore.result.spent).toBe(0n);
      expect(allowanceBefore.result.remaining).toBe(limitStroops);
      recorder.record("limits", "Set 50 XLM daily spend limit", {
        tokenId: xlmTokenId,
        limit: limitStroops.toString(),
      });

      // 4. Record spend WITHIN limit (20 XLM) -> succeeds & decrements remaining to 30 XLM.
      const spendOk = await ownerContract.record_spend({
        user: owner.publicKey(),
        token_id: xlmTokenId,
        amount: 200_000_000n,
      });
      await spendOk.signAndSend();

      const allowanceAfter = await ownerContract.get_spend_allowance({
        user: owner.publicKey(),
        token_id: xlmTokenId,
      });
      expect(allowanceAfter.result.spent).toBe(200_000_000n);
      expect(allowanceAfter.result.remaining).toBe(300_000_000n);

      // 5. Record spend EXCEEDING remaining limit (40 XLM > 30 XLM) -> rejected in simulation!
      const overLimitTx = await ownerContract.record_spend({
        user: owner.publicKey(),
        token_id: xlmTokenId,
        amount: 400_000_000n,
      });
      expect(overLimitTx.result.isErr()).toBe(true);
      recorder.record("limits", "Over-limit spend cleanly rejected by contract", {
        attemptedStroops: "400000000",
        remainingStroops: allowanceAfter.result.remaining.toString(),
      });

      // 6. Attempt limit increase (100 XLM) -> queued with 24h timelock, active cap stays 50 XLM.
      const raiseTx = await ownerContract.set_spend_limit({
        user: owner.publicKey(),
        token_id: xlmTokenId,
        limit: 1_000_000_000n,
      });
      await raiseTx.signAndSend();

      const pendingRaise = await ownerContract.pending_spend_limit({
        user: owner.publicKey(),
        token_id: xlmTokenId,
      });
      expect(pendingRaise.result).toBeDefined();
      const stillCapped = await ownerContract.get_spend_allowance({
        user: owner.publicKey(),
        token_id: xlmTokenId,
      });
      expect(stillCapped.result.limit).toBe(limitStroops);

      // 7. Decrease limit (25 XLM) -> takes effect immediately & cancels pending raise.
      const lowerTx = await ownerContract.set_spend_limit({
        user: owner.publicKey(),
        token_id: xlmTokenId,
        limit: 250_000_000n,
      });
      await lowerTx.signAndSend();
      const lowered = await ownerContract.get_spend_allowance({
        user: owner.publicKey(),
        token_id: xlmTokenId,
      });
      expect(lowered.result.limit).toBe(250_000_000n);
      recorder.record("limits", "Verified timelocked raise and immediate decrease");
    });
  });

  it("completes guardian registration, recovery initiation, quorum approval, timelock check, revocation, and cancellation", async () => {
    await runWithArtifactCapture("social-recovery", async () => {
      const { sdk: ownerSdk } = await authenticateViaSep10(apiBaseUrl, owner, recorder);
      const { sdk: g1Sdk } = await authenticateViaSep10(apiBaseUrl, guardian1, recorder);
      const { sdk: g2Sdk } = await authenticateViaSep10(apiBaseUrl, guardian2, recorder);

      // 1. Add 3 guardians via backend build + local admin signature + backend submit.
      for (const guardian of [guardian1, guardian2, guardian3]) {
        const built = await ownerSdk.request<{ xdr: string }>(
          "/api/v1/contract/wallet/guardians/add/build",
          {
            method: "POST",
            body: { admin: owner.publicKey(), guardian: guardian.publicKey() },
          }
        );
        const signed = signXdrLocally(built.xdr, networkPassphrase, owner);
        const res = await ownerSdk.request<{ successful: boolean }>(
          "/api/v1/contract/wallet/submit",
          { method: "POST", body: { signedXdr: signed } }
        );
        expect(res.successful).toBe(true);
      }

      const guardiansView = await ownerSdk.request<{ guardians: string[] }>(
        "/api/v1/contract/wallet/guardians"
      );
      expect(guardiansView.guardians).toHaveLength(3);
      recorder.record("recovery", "Registered 3 guardians", guardiansView);

      // 2. Configure 2-of-3 recovery with MIN_RECOVERY_DELAY_LEDGERS (17,280 ledgers = ~24h).
      const ownerContract = createSdkContractClient(
        globeWalletContractId,
        rpcUrl,
        networkPassphrase,
        owner
      );
      const cfgTx = await ownerContract.set_recovery_config({
        admin: owner.publicKey(),
        threshold: 2,
        delay_in_ledgers: 17_280,
      });
      await cfgTx.signAndSend();

      const recoveryState = await ownerSdk.request<{
        configured: boolean;
        guardianCount: number;
        config: { threshold: number; delayInLedgers: number } | null;
      }>("/api/v1/contract/wallet/recovery");
      expect(recoveryState.configured).toBe(true);
      expect(recoveryState.guardianCount).toBe(3);
      expect(recoveryState.config).toEqual({ threshold: 2, delayInLedgers: 17_280 });

      // 3. Cross-account security check: Guardian 2 CANNOT build initiate_recovery as Guardian 1.
      await expect(
        g2Sdk.request("/api/v1/contract/wallet/recovery/initiate/build", {
          method: "POST",
          body: {
            guardian: guardian1.publicKey(),
            newAdmin: recoveryCandidate.publicKey(),
          },
        })
      ).rejects.toMatchObject({ status: 403, code: "ACCOUNT_MISMATCH" });

      // 4. Guardian 1 initiates recovery for recoveryCandidate.
      const initBuilt = await g1Sdk.request<{ xdr: string }>(
        "/api/v1/contract/wallet/recovery/initiate/build",
        {
          method: "POST",
          body: {
            guardian: guardian1.publicKey(),
            newAdmin: recoveryCandidate.publicKey(),
          },
        }
      );
      const initRes = await g1Sdk.request<{ successful: boolean }>(
        "/api/v1/contract/wallet/submit",
        {
          method: "POST",
          body: { signedXdr: signXdrLocally(initBuilt.xdr, networkPassphrase, guardian1) },
        }
      );
      expect(initRes.successful).toBe(true);

      // 5. Guardian 2 approves recovery -> quorum (2/2) reached, timelock armed.
      const approveBuilt = await g2Sdk.request<{ xdr: string }>(
        "/api/v1/contract/wallet/recovery/approve/build",
        {
          method: "POST",
          body: { guardian: guardian2.publicKey() },
        }
      );
      const approveRes = await g2Sdk.request<{ successful: boolean }>(
        "/api/v1/contract/wallet/submit",
        {
          method: "POST",
          body: { signedXdr: signXdrLocally(approveBuilt.xdr, networkPassphrase, guardian2) },
        }
      );
      expect(approveRes.successful).toBe(true);

      const proposal = await ownerSdk.request<{
        proposal: {
          newAdmin: string;
          approvalsCount: number;
          quorumReached: boolean;
          executable: boolean;
          readyAtLedger: number | null;
        } | null;
      }>("/api/v1/contract/wallet/recovery/proposal");
      expect(proposal.proposal).toMatchObject({
        newAdmin: recoveryCandidate.publicKey(),
        approvalsCount: 2,
        quorumReached: true,
        executable: false,
      });
      expect(proposal.proposal?.readyAtLedger).not.toBeNull();
      recorder.record("recovery", "Quorum reached and timelock armed", proposal);

      // 6. Premature execute_recovery MUST be rejected before timelock elapses.
      await expect(
        g1Sdk.request("/api/v1/contract/wallet/recovery/execute/build", {
          method: "POST",
          body: { sourcePublicKey: guardian1.publicKey() },
        })
      ).rejects.toBeInstanceOf(ApiError);

      // 7. Guardian 2 revokes approval -> quorum drops back below threshold.
      const revokeBuilt = await g2Sdk.request<{ xdr: string }>(
        "/api/v1/contract/wallet/recovery/revoke-approval/build",
        {
          method: "POST",
          body: { guardian: guardian2.publicKey() },
        }
      );
      await g2Sdk.request("/api/v1/contract/wallet/submit", {
        method: "POST",
        body: { signedXdr: signXdrLocally(revokeBuilt.xdr, networkPassphrase, guardian2) },
      });

      const afterRevoke = await ownerSdk.request<{
        proposal: { approvalsCount: number; quorumReached: boolean } | null;
      }>("/api/v1/contract/wallet/recovery/proposal");
      expect(afterRevoke.proposal?.approvalsCount).toBe(1);
      expect(afterRevoke.proposal?.quorumReached).toBe(false);

      // 8. Admin cancels active recovery -> proposal cleared.
      const cancelBuilt = await ownerSdk.request<{ xdr: string }>(
        "/api/v1/contract/wallet/recovery/cancel/build",
        {
          method: "POST",
          body: { admin: owner.publicKey() },
        }
      );
      await ownerSdk.request("/api/v1/contract/wallet/submit", {
        method: "POST",
        body: { signedXdr: signXdrLocally(cancelBuilt.xdr, networkPassphrase, owner) },
      });

      const afterCancel = await ownerSdk.request<{ proposal: unknown | null }>(
        "/api/v1/contract/wallet/recovery/proposal"
      );
      expect(afterCancel.proposal).toBeNull();
      recorder.record("recovery", "Admin cancelled recovery cleanly");
    });
  });
});
