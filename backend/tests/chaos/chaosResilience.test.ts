/**
 * Hermetic real-socket chaos resilience test suite (#234).
 *
 * Runs as part of standard `npm test` (no Docker needed) by placing a real
 * loopback TCP/HTTP fault-injection proxy (`LocalTcpFaultProxy`) in front of
 * local upstream servers and exercising the REAL Express routes, `StellarService`,
 * `SorobanService`, `RedisAccountLock`, `Pool`, and health checks under:
 *   - Network partitions (connection close / refused)
 *   - Mid-stream TCP peer resets (RST)
 *   - High latency & silent timeouts (blackholes)
 *   - Upstream HTTP 502/503/504 faults
 *   - Fault recovery (verify clean healing once fault is removed)
 *
 * Strictly verifies pass criteria:
 *   1. Shared error envelope (`{ error: { code, message, retryable? } }`) with
 *      registered `ERROR_CODES` and zero stack/secret/host leaks.
 *   2. ZERO duplicate transaction submissions under slow Horizon, 504 timeouts,
 *      concurrent idempotent retries, Postgres failure, and Redis partitions.
 *   3. Fail-closed `RedisAccountLock` (`LOCK_UNAVAILABLE` 503).
 *   4. `/health` liveness stays 200 while `/api/v1/health/details` accurately
 *      reports `down` (Horizon/RPC) or `degraded` (Postgres/Redis).
 */

import http from "node:http";
import * as StellarSdk from "@stellar/stellar-sdk";
import request from "supertest";
import { createClient, type RedisClientType } from "redis";

// Controllable Postgres/idempotency backing store to inject real DB partitions
// and verify zero unguarded Horizon submissions when idempotency storage fails.
const mockDbState = {
  partitioned: false,
  resetNext: false,
  latencyMs: 0,
  idempotencyRows: new Map<
    string,
    { fingerprint: string; hash: string; successful: boolean; committed: boolean }
  >(),
};

jest.mock("../../src/services/idempotency", () => {
  const actual = jest.requireActual("../../src/services/idempotency");
  const maybeFailDb = async () => {
    if (mockDbState.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, mockDbState.latencyMs));
    }
    if (mockDbState.partitioned) {
      const err = new Error("Connection terminated unexpectedly (172.18.0.5:15432)");
      (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
      throw actual.translateIdempotencyStoreError(err);
    }
    if (mockDbState.resetNext) {
      mockDbState.resetNext = false;
      const err = new Error("read ECONNRESET 172.18.0.5:15432");
      (err as NodeJS.ErrnoException).code = "ECONNRESET";
      throw actual.translateIdempotencyStoreError(err);
    }
  };

  return {
    ...actual,
    claimIdempotencyKey: jest.fn(async (src: string, key: string, fp: string) => {
      await maybeFailDb();
      const k = `${src}:${key}`;
      const existing = mockDbState.idempotencyRows.get(k);
      if (!existing) {
        mockDbState.idempotencyRows.set(k, {
          fingerprint: fp,
          hash: "",
          successful: false,
          committed: false,
        });
        return { status: "claimed" };
      }
      if (existing.fingerprint !== fp) return { status: "conflict" };
      if (!existing.committed) return { status: "in-flight" };
      return { status: "hit", result: { hash: existing.hash, successful: existing.successful } };
    }),
    commitIdempotencyResult: jest.fn(
      async (src: string, key: string, fp: string, hash: string, successful: boolean) => {
        await maybeFailDb();
        mockDbState.idempotencyRows.set(`${src}:${key}`, {
          fingerprint: fp,
          hash,
          successful,
          committed: true,
        });
      }
    ),
    releaseIdempotencyKey: jest.fn(async (src: string, key: string) => {
      const k = `${src}:${key}`;
      const existing = mockDbState.idempotencyRows.get(k);
      if (existing && !existing.committed) mockDbState.idempotencyRows.delete(k);
    }),
  };
});

jest.mock("../../src/services/sorobanCache", () => ({
  getCachedSimulate: jest.fn(async () => null),
  setCachedSimulate: jest.fn(async () => undefined),
  markPendingTransaction: jest.fn(async () => undefined),
  clearPendingTransaction: jest.fn(async () => undefined),
}));

jest.mock("../../src/services/sessionStore", () => ({
  sessionStore: { isSessionRevoked: jest.fn(async () => false) },
}));

import { createApp } from "../../src/app";
import { StellarService } from "../../src/services/stellar";
import { SorobanService } from "../../src/services/soroban";
import { GlobeWalletContract } from "../../src/services/contracts/globeWallet";
import { RedisAccountLock } from "../../src/services/locks/redisAccountLock";
import { LockUnavailableError } from "../../src/services/stellarErrors";
import { generateAccessToken } from "../../src/utils/jwt";
import { LocalTcpFaultProxy, getRefusedPort } from "./localFaultProxy";
import { assertChaosErrorEnvelope } from "./chaosAssertions";

const PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const CONTRACT_ID =
  process.env.GLOBE_WALLET_CONTRACT_ID ??
  "CBGLPMNSM4FWMIZ6FFBSRN7FNVCHCI2SLZNODA27LEOXFPLWNYEAEP3K";

function signedTxFor(
  kp: StellarSdk.Keypair,
  destination: string,
  seq = "100",
  memo?: string
): string {
  const builder = new StellarSdk.TransactionBuilder(new StellarSdk.Account(kp.publicKey(), seq), {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination,
        asset: StellarSdk.Asset.native(),
        amount: "1",
      })
    )
    .setTimeout(300);
  if (memo) builder.addMemo(StellarSdk.Memo.text(memo));
  const tx = builder.build();
  tx.sign(kp);
  return tx.toXDR();
}

describe("Chaos Resilience Suite — Horizon, Soroban RPC, Postgres, Redis (#234)", () => {
  const alice = StellarSdk.Keypair.random();
  const bob = StellarSdk.Keypair.random();
  let aliceJwt: string;

  let horizonUpstream: http.Server;
  let rpcUpstream: http.Server;
  let horizonProxy: LocalTcpFaultProxy;
  let rpcProxy: LocalTcpFaultProxy;

  let horizonSubmitCount = 0;
  let rpcSendCount = 0;
  let ipSeq = 1;

  function nextIp(): string {
    ipSeq += 1;
    return `203.0.113.${(ipSeq % 240) + 10}`;
  }

  beforeAll(async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);

    aliceJwt = generateAccessToken(alice.publicKey(), "sep10");

    // 1. Real loopback Horizon upstream
    horizonUpstream = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ network_passphrase: PASSPHRASE }));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/accounts/")) {
        const pk = url.pathname.split("/").pop() ?? alice.publicKey();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            _links: {
              self: { href: `http://127.0.0.1/accounts/${pk}` },
              data: { href: `http://127.0.0.1/accounts/${pk}/data/{key}`, templated: true },
            },
            id: pk,
            account_id: pk,
            sequence: "100",
            subentry_count: 0,
            thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
            flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
            balances: [{ asset_type: "native", balance: "100.0000000" }],
            signers: [{ key: pk, weight: 1, type: "ed25519_public_key" }],
            data: {},
            data_attr: {},
          })
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/transactions") {
        req.resume();
        req.on("end", () => {
          horizonSubmitCount += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              hash: "c".repeat(64),
              ledger: 500,
              successful: true,
            })
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => horizonUpstream.listen(0, "127.0.0.1", () => resolve()));
    const hAddr = horizonUpstream.address() as { port: number };
    horizonProxy = new LocalTcpFaultProxy("127.0.0.1", hAddr.port);
    await horizonProxy.start();

    // 2. Real loopback Soroban RPC upstream
    rpcUpstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          id?: number;
          method?: string;
        };
        const reply = (result: unknown) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }));
        };
        if (body.method === "getHealth") {
          reply({ status: "healthy", latestLedger: 999 });
          return;
        }
        if (body.method === "getLedgerEntries") {
          const accountEntry = new StellarSdk.xdr.AccountEntry({
            accountId: StellarSdk.Keypair.fromPublicKey(alice.publicKey()).xdrAccountId(),
            balance: StellarSdk.xdr.Int64.fromString("100000000000"),
            seqNum: StellarSdk.xdr.Int64.fromString("100"),
            numSubEntries: 0,
            inflationDest: null,
            flags: 0,
            homeDomain: "",
            thresholds: Buffer.from([1, 1, 1, 1]),
            signers: [],
            ext: new StellarSdk.xdr.AccountEntryExt(0),
          });
          const key = StellarSdk.xdr.LedgerKey.account(
            new StellarSdk.xdr.LedgerKeyAccount({
              accountId: StellarSdk.Keypair.fromPublicKey(alice.publicKey()).xdrAccountId(),
            })
          );
          reply({
            entries: [
              {
                key: key.toXDR("base64"),
                xdr: StellarSdk.xdr.LedgerEntryData.account(accountEntry).toXDR("base64"),
                lastModifiedLedgerSeq: 999,
              },
            ],
            latestLedger: 999,
          });
          return;
        }
        if (body.method === "simulateTransaction") {
          const emptyData = new StellarSdk.SorobanDataBuilder().build();
          reply({
            minResourceFee: "500",
            cost: { cpuInsns: "100", memBytes: "100" },
            transactionData: emptyData.toXDR("base64"),
            events: [],
            results: [{ auth: [], xdr: StellarSdk.xdr.ScVal.scvVoid().toXDR("base64") }],
            latestLedger: 999,
          });
          return;
        }
        if (body.method === "sendTransaction") {
          rpcSendCount += 1;
          reply({ status: "PENDING", hash: "d".repeat(64), latestLedger: 999 });
          return;
        }
        if (body.method === "getTransaction") {
          // Return NOT_FOUND to simulate slow ledger close / poll timeout when testing 202 pending.
          reply({ status: "NOT_FOUND", latestLedger: 999 });
          return;
        }
        reply({});
      });
    });

    await new Promise<void>((resolve) => rpcUpstream.listen(0, "127.0.0.1", () => resolve()));
    const rAddr = rpcUpstream.address() as { port: number };
    rpcProxy = new LocalTcpFaultProxy("127.0.0.1", rAddr.port);
    await rpcProxy.start();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await horizonProxy.stop();
    await rpcProxy.stop();
    horizonUpstream.closeAllConnections?.();
    rpcUpstream.closeAllConnections?.();
    await new Promise<void>((resolve) => horizonUpstream.close(() => resolve()));
    await new Promise<void>((resolve) => rpcUpstream.close(() => resolve()));
  });

  beforeEach(() => {
    horizonProxy.setMode({ type: "ok" });
    rpcProxy.setMode({ type: "ok" });
    horizonSubmitCount = 0;
    rpcSendCount = 0;
    mockDbState.partitioned = false;
    mockDbState.resetNext = false;
    mockDbState.latencyMs = 0;
    mockDbState.idempotencyRows.clear();
  });

  function buildChaosApp(opts: {
    horizonUrl?: string;
    rpcUrl?: string;
    redisUrl?: string;
    lockBackend?: "in-process" | "redis";
    healthTimeoutMs?: number;
    pollTimeoutMs?: number;
  } = {}) {
    const hUrl = opts.horizonUrl ?? horizonProxy.url;
    const rUrl = opts.rpcUrl ?? rpcProxy.url;
    const stellar = new StellarService(undefined, null, {
      horizonUrl: hUrl,
      networkPassphrase: PASSPHRASE,
    });
    const soroban = new SorobanService({
      rpcUrl: rUrl,
      networkPassphrase: PASSPHRASE,
      pollIntervalMs: 25,
      pollTimeoutMs: opts.pollTimeoutMs ?? 120,
    });
    const globeWallet = new GlobeWalletContract(soroban, CONTRACT_ID);
    return createApp(stellar, globeWallet, undefined, {
      disableHealthCache: true,
      healthCheckDeps: {
        horizonUrl: hUrl,
        sorobanRpcUrl: rUrl,
        redisUrl: opts.redisUrl,
        lockBackend: opts.lockBackend ?? "in-process",
        timeoutMs: opts.healthTimeoutMs ?? 400,
        checkPostgres: async () => {
          if (mockDbState.latencyMs > 0) {
            await new Promise((r) => setTimeout(r, mockDbState.latencyMs));
          }
          if (mockDbState.partitioned) {
            throw new Error("Postgres partitioned");
          }
        },
      },
    });
  }

  // ── 1. HORIZON CHAOS ─────────────────────────────────────────────────────
  describe("Horizon chaos scenarios", () => {
    it("partition: returns 502 HORIZON_UNAVAILABLE (retryable), /health stays 200, /health/details reports down (503), then recovers", async () => {
      const app = buildChaosApp();
      horizonProxy.setMode({ type: "partition" });

      const readRes = await request(app)
        .get(`/api/v1/account/${alice.publicKey()}`)
        .set("X-Forwarded-For", nextIp());
      assertChaosErrorEnvelope(readRes, {
        statuses: [502],
        codes: ["HORIZON_UNAVAILABLE"],
        retryable: true,
      });

      const liveness = await request(app).get("/health").set("X-Forwarded-For", nextIp());
      expect(liveness.status).toBe(200);
      expect(liveness.body).toEqual({ status: "ok" });

      const detailsDown = await request(app)
        .get("/api/v1/health/details")
        .set("X-Forwarded-For", nextIp());
      expect(detailsDown.status).toBe(503);
      expect(detailsDown.body.status).toBe("down");
      expect(detailsDown.body.checks.horizon.ok).toBe(false);

      // Heal partition and verify full recovery without process restart.
      horizonProxy.setMode({ type: "ok" });
      const recovered = await request(app)
        .get(`/api/v1/account/${alice.publicKey()}`)
        .set("X-Forwarded-For", nextIp());
      expect(recovered.status).toBe(200);
      expect(recovered.body.account_id).toBe(alice.publicKey());

      const detailsUp = await request(app)
        .get("/api/v1/health/details")
        .set("X-Forwarded-For", nextIp());
      expect(detailsUp.status).toBe(200);
      expect(detailsUp.body.status).toBe("ok");
    });

    it("TCP reset mid-submission: returns clean 502 HORIZON_UNAVAILABLE and releases idempotency key for safe retry", async () => {
      const app = buildChaosApp();
      const xdr = signedTxFor(alice, bob.publicKey());

      horizonProxy.setMode({ type: "reset_peer" });
      const first = await request(app)
        .post("/api/v1/wallet/submit")
        .set("X-Forwarded-For", nextIp())
        .set("Authorization", `Bearer ${aliceJwt}`)
        .set("Idempotency-Key", "chaos-reset-1")
        .send({ signedXdr: xdr });
      assertChaosErrorEnvelope(first, {
        statuses: [502],
        codes: ["HORIZON_UNAVAILABLE"],
        retryable: true,
      });
      expect(horizonSubmitCount).toBe(0);

      // Once Horizon heals, retrying with the SAME Idempotency-Key succeeds cleanly once.
      horizonProxy.setMode({ type: "ok" });
      const retry = await request(app)
        .post("/api/v1/wallet/submit")
        .set("X-Forwarded-For", nextIp())
        .set("Authorization", `Bearer ${aliceJwt}`)
        .set("Idempotency-Key", "chaos-reset-1")
        .send({ signedXdr: xdr });
      expect(retry.status).toBe(200);
      expect(retry.body.successful).toBe(true);
      expect(horizonSubmitCount).toBe(1);
    });

    it("latency + concurrent duplicate retries: guarantees ZERO duplicate Horizon submissions", async () => {
      const app = buildChaosApp();
      const xdr = signedTxFor(alice, bob.publicKey());

      // Inject 300ms latency on Horizon so the first request stays in-flight
      // while two concurrent retries arrive with the exact same Idempotency-Key.
      horizonProxy.setMode({ type: "latency", delayMs: 300 });

      const [r1, r2, r3] = await Promise.all([
        request(app)
          .post("/api/v1/wallet/submit")
          .set("X-Forwarded-For", nextIp())
          .set("Authorization", `Bearer ${aliceJwt}`)
          .set("Idempotency-Key", "chaos-concurrent-1")
          .send({ signedXdr: xdr }),
        request(app)
          .post("/api/v1/wallet/submit")
          .set("X-Forwarded-For", nextIp())
          .set("Authorization", `Bearer ${aliceJwt}`)
          .set("Idempotency-Key", "chaos-concurrent-1")
          .send({ signedXdr: xdr }),
        request(app)
          .post("/api/v1/wallet/submit")
          .set("X-Forwarded-For", nextIp())
          .set("Authorization", `Bearer ${aliceJwt}`)
          .set("Idempotency-Key", "chaos-concurrent-1")
          .send({ signedXdr: xdr }),
      ]);

      const statuses = [r1.status, r2.status, r3.status].sort();
      expect(statuses).toEqual([200, 409, 409]);

      for (const res of [r1, r2, r3].filter((r) => r.status === 409)) {
        assertChaosErrorEnvelope(res, {
          statuses: [409],
          codes: ["IDEMPOTENCY_KEY_IN_FLIGHT"],
          retryable: true,
        });
      }

      // CRITICAL PASS CRITERION: Horizon received strictly 1 submission, never 2 or 3.
      expect(horizonSubmitCount).toBe(1);
    });

    it("HTTP 504 timeout on submit: returns 202 pending and blocks duplicate replay while in-flight", async () => {
      const app = buildChaosApp();
      // Include a memo so Stellar SDK skips the GET /accounts SEP-29 lookup and
      // hits POST /transactions directly with the injected 504 gateway timeout.
      const xdr = signedTxFor(alice, bob.publicKey(), "100", "chaos-504");

      horizonProxy.setMode({ type: "http_status", status: 504 });
      const first = await request(app)
        .post("/api/v1/wallet/submit")
        .set("X-Forwarded-For", nextIp())
        .set("Authorization", `Bearer ${aliceJwt}`)
        .set("Idempotency-Key", "chaos-504-1")
        .send({ signedXdr: xdr });
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({ status: "pending", hash: expect.any(String) });

      // Retrying with the same key must NOT re-submit because the 504 outcome is unknown.
      horizonProxy.setMode({ type: "ok" });
      const second = await request(app)
        .post("/api/v1/wallet/submit")
        .set("X-Forwarded-For", nextIp())
        .set("Authorization", `Bearer ${aliceJwt}`)
        .set("Idempotency-Key", "chaos-504-1")
        .send({ signedXdr: xdr });
      assertChaosErrorEnvelope(second, {
        statuses: [409],
        codes: ["IDEMPOTENCY_KEY_IN_FLIGHT"],
        retryable: true,
      });
      expect(horizonSubmitCount).toBe(0);
    });

    it("HTTP 503 on submit: classifies as 502 HORIZON_UNAVAILABLE (retryable) rather than 400 HORIZON_REJECTED", async () => {
      const app = buildChaosApp();
      const xdr = signedTxFor(alice, bob.publicKey(), "100", "chaos-503");

      horizonProxy.setMode({ type: "http_status", status: 503 });
      const failed = await request(app)
        .post("/api/v1/wallet/submit")
        .set("X-Forwarded-For", nextIp())
        .set("Authorization", `Bearer ${aliceJwt}`)
        .set("Idempotency-Key", "chaos-503-1")
        .send({ signedXdr: xdr });
      assertChaosErrorEnvelope(failed, {
        statuses: [502],
        codes: ["HORIZON_UNAVAILABLE"],
        retryable: true,
      });

      horizonProxy.setMode({ type: "ok" });
      const retry = await request(app)
        .post("/api/v1/wallet/submit")
        .set("X-Forwarded-For", nextIp())
        .set("Authorization", `Bearer ${aliceJwt}`)
        .set("Idempotency-Key", "chaos-503-1")
        .send({ signedXdr: xdr });
      expect(retry.status).toBe(200);
      expect(horizonSubmitCount).toBe(1);
    });
  });

  // ── 2. SOROBAN RPC CHAOS ─────────────────────────────────────────────────
  describe("Soroban RPC chaos scenarios", () => {
    it("partition & TCP reset: build and submit return 503 SOROBAN_UNAVAILABLE (retryable) with clean envelope", async () => {
      const app = buildChaosApp();
      const xdr = signedTxFor(alice, bob.publicKey());

      for (const mode of [{ type: "partition" as const }, { type: "reset_peer" as const }]) {
        rpcProxy.setMode(mode);

        const buildRes = await request(app)
          .post("/api/v1/contract/wallet/spend/build")
          .set("X-Forwarded-For", nextIp())
          .set("Authorization", `Bearer ${aliceJwt}`)
          .send({ userPublicKey: alice.publicKey(), assetCode: "XLM", amount: "1000" });
        assertChaosErrorEnvelope(buildRes, {
          statuses: [503],
          codes: ["SOROBAN_UNAVAILABLE"],
          retryable: true,
        });

        const submitRes = await request(app)
          .post("/api/v1/contract/wallet/submit")
          .set("X-Forwarded-For", nextIp())
          .set("Authorization", `Bearer ${aliceJwt}`)
          .send({ signedXdr: xdr });
        assertChaosErrorEnvelope(submitRes, {
          statuses: [503],
          codes: ["SOROBAN_UNAVAILABLE"],
          retryable: true,
        });
      }

      const detailsDown = await request(app)
        .get("/api/v1/health/details")
        .set("X-Forwarded-For", nextIp());
      expect(detailsDown.status).toBe(503);
      expect(detailsDown.body.status).toBe("down");
      expect(detailsDown.body.checks.rpc.ok).toBe(false);
    });

    it("slow ledger close / poll timeout: submits ONCE and returns 202 pending without double-submitting", async () => {
      const app = buildChaosApp({ pollTimeoutMs: 80 });
      const xdr = signedTxFor(alice, bob.publicKey());

      const res = await request(app)
        .post("/api/v1/contract/wallet/submit")
        .set("X-Forwarded-For", nextIp())
        .set("Authorization", `Bearer ${aliceJwt}`)
        .send({ signedXdr: xdr });

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: "pending", hash: "d".repeat(64) });
      expect(rpcSendCount).toBe(1);
    });
  });

  // ── 3. POSTGRES CHAOS ────────────────────────────────────────────────────
  describe("Postgres chaos scenarios", () => {
    it("partition: refuses idempotent submit BEFORE calling Horizon (zero unguarded duplicates) and marks /health/details degraded", async () => {
      const app = buildChaosApp();
      const xdr = signedTxFor(alice, bob.publicKey());
      mockDbState.partitioned = true;

      const submitRes = await request(app)
        .post("/api/v1/wallet/submit")
        .set("X-Forwarded-For", nextIp())
        .set("Authorization", `Bearer ${aliceJwt}`)
        .set("Idempotency-Key", "pg-down-key-1")
        .send({ signedXdr: xdr });

      assertChaosErrorEnvelope(submitRes, {
        statuses: [503],
        codes: ["SERVICE_UNAVAILABLE"],
        retryable: true,
      });
      expect(JSON.stringify(submitRes.body)).not.toContain("172.18.0.5");
      // CRITICAL: Postgres outage during idempotency claim MUST prevent Horizon submission.
      expect(horizonSubmitCount).toBe(0);

      // Health details degrades (200 degraded because Horizon/RPC are still healthy).
      const details = await request(app)
        .get("/api/v1/health/details")
        .set("X-Forwarded-For", nextIp());
      expect(details.status).toBe(200);
      expect(details.body.status).toBe("degraded");
      expect(details.body.checks.postgres.ok).toBe(false);
    });

    it("high latency exceeding health deadline: times out cleanly without hanging", async () => {
      const app = buildChaosApp({ healthTimeoutMs: 150 });
      mockDbState.latencyMs = 500;

      const start = Date.now();
      const details = await request(app)
        .get("/api/v1/health/details")
        .set("X-Forwarded-For", nextIp());
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1200);
      expect(details.body.status).toBe("degraded");
      expect(details.body.checks.postgres.ok).toBe(false);
      expect(details.body.checks.postgres.error).toBe("TimeoutError");
    });

    it("TCP reset on Postgres: fails cleanly once and recovers on next request", async () => {
      const app = buildChaosApp();
      const xdr = signedTxFor(alice, bob.publicKey());
      mockDbState.resetNext = true;

      const failed = await request(app)
        .post("/api/v1/wallet/submit")
        .set("X-Forwarded-For", nextIp())
        .set("Authorization", `Bearer ${aliceJwt}`)
        .set("Idempotency-Key", "pg-reset-1")
        .send({ signedXdr: xdr });
      assertChaosErrorEnvelope(failed, { statuses: [500, 503] });
      expect(horizonSubmitCount).toBe(0);

      const recovered = await request(app)
        .post("/api/v1/wallet/submit")
        .set("X-Forwarded-For", nextIp())
        .set("Authorization", `Bearer ${aliceJwt}`)
        .set("Idempotency-Key", "pg-reset-1")
        .send({ signedXdr: xdr });
      expect(recovered.status).toBe(200);
      expect(horizonSubmitCount).toBe(1);
    });
  });

  // ── 4. REDIS CHAOS ───────────────────────────────────────────────────────
  describe("Redis chaos scenarios", () => {
    it("partition: RedisAccountLock fails closed with LOCK_UNAVAILABLE (503 retryable) and NEVER runs submission callback", async () => {
      const closedPort = await getRefusedPort();
      const client = createClient({
        url: `redis://127.0.0.1:${closedPort}`,
        disableOfflineQueue: true,
        socket: { reconnectStrategy: false },
      }) as RedisClientType;
      client.on("error", () => undefined);

      const lock = new RedisAccountLock(client, { maxWaitMs: 200, retryDelayMs: 50 });
      const callback = jest.fn(async () => "submitted");

      await expect(lock.withLock(alice.publicKey(), callback)).rejects.toBeInstanceOf(
        LockUnavailableError
      );
      await expect(lock.withLock(alice.publicKey(), callback)).rejects.toMatchObject({
        code: "LOCK_UNAVAILABLE",
        status: 503,
        retryable: true,
      });
      // CRITICAL PASS CRITERION: callback never executed unlocked.
      expect(callback).not.toHaveBeenCalled();

      // Health details marks Redis degraded when LOCK_BACKEND=redis.
      const app = buildChaosApp({
        redisUrl: `redis://127.0.0.1:${closedPort}`,
        lockBackend: "redis",
        healthTimeoutMs: 400,
      });
      const details = await request(app)
        .get("/api/v1/health/details")
        .set("X-Forwarded-For", nextIp());
      expect(details.status).toBe(200);
      expect(details.body.status).toBe("degraded");
      expect(details.body.checks.redis.ok).toBe(false);
    });

    it("blackhole timeout on Redis port: health check bounds wait via TimeoutError", async () => {
      const closedPort = await getRefusedPort();
      const blackholeProxy = new LocalTcpFaultProxy("127.0.0.1", closedPort);
      await blackholeProxy.start();
      blackholeProxy.setMode({ type: "timeout" });

      try {
        const app = buildChaosApp({
          redisUrl: `redis://127.0.0.1:${blackholeProxy.port}`,
          lockBackend: "redis",
          healthTimeoutMs: 250,
        });
        const start = Date.now();
        const details = await request(app)
          .get("/api/v1/health/details")
          .set("X-Forwarded-For", nextIp());
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(1500);
        expect(details.body.status).toBe("degraded");
        expect(details.body.checks.redis.ok).toBe(false);
      } finally {
        await blackholeProxy.stop();
      }
    });
  });
});
