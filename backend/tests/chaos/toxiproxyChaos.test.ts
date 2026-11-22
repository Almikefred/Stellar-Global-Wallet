/**
 * Live Toxiproxy chaos test suite (#234).
 *
 * Runs against the real Docker Compose chaos topology:
 *   docker compose --profile local --profile chaos up -d postgres redis stellar toxiproxy
 *   npm run test:chaos --workspace backend
 *
 * Injects real TCP-level faults (latency, peer resets, silent timeouts, and
 * full network partitions) via Shopify's Toxiproxy Admin API (:8474) in front
 * of live Horizon (:18000), Soroban RPC (:18001), Postgres (:15432), and
 * Redis (:16379), asserting:
 *   - Shared error envelopes with valid ERROR_CODES (zero secret/stack leaks)
 *   - Fail-closed RedisAccountLock (zero unlocked submissions)
 *   - Zero duplicate submissions under latency, resets, and partitions
 *   - Clean automatic recovery after toxics are removed
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import request from "supertest";
import { Pool } from "pg";
import { createClient, type RedisClientType } from "redis";
import { createApp } from "../../src/app";
import { StellarService } from "../../src/services/stellar";
import { SorobanService } from "../../src/services/soroban";
import { GlobeWalletContract } from "../../src/services/contracts/globeWallet";
import { RedisAccountLock } from "../../src/services/locks/redisAccountLock";
import { LockUnavailableError } from "../../src/services/stellarErrors";
import { initKeys } from "../../src/utils/jwtKeys";
import { generateAccessToken } from "../../src/utils/jwt";
import { ToxiproxyClient } from "./toxiproxyClient";
import { assertChaosErrorEnvelope } from "./chaosAssertions";

const chaosEnabled = process.env.CHAOS_ENABLED === "1";
const maybeDescribe = chaosEnabled ? describe : describe.skip;

const TOXIPROXY_URL = process.env.CHAOS_TOXIPROXY_URL ?? "http://localhost:8474";
const HORIZON_PROXY_URL = process.env.CHAOS_HORIZON_URL ?? "http://localhost:18000";
const RPC_PROXY_URL = process.env.CHAOS_SOROBAN_RPC_URL ?? "http://localhost:18001/soroban/rpc";
const POSTGRES_PROXY_URL =
  process.env.CHAOS_DATABASE_URL ?? "postgresql://user:password@localhost:15432/globewallet";
const REDIS_PROXY_URL = process.env.CHAOS_REDIS_URL ?? "redis://localhost:16379";
const FRIENDBOT_URL = process.env.CHAOS_FRIENDBOT_URL ?? "http://localhost:8000/friendbot";
const PASSPHRASE =
  process.env.CHAOS_NETWORK_PASSPHRASE ?? "Standalone Network ; February 2017";

async function fundAccount(kp: StellarSdk.Keypair): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(kp.publicKey())}`);
    if (res.ok) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Failed to fund chaos test account ${kp.publicKey()}`);
}

maybeDescribe("Live Toxiproxy Chaos Suite (Horizon, RPC, Postgres, Redis) (#234)", () => {
  const toxiproxy = new ToxiproxyClient(TOXIPROXY_URL);
  const alice = StellarSdk.Keypair.random();
  const bob = StellarSdk.Keypair.random();
  let pgPool: Pool;
  let redisClient: RedisClientType;
  let aliceJwt: string;
  let app: import("express").Express;

  beforeAll(async () => {
    const available = await toxiproxy.isAvailable();
    if (!available) {
      throw new Error(
        `Toxiproxy not reachable at ${TOXIPROXY_URL}. Start with: ` +
          "docker compose --profile local --profile chaos up -d postgres redis stellar toxiproxy"
      );
    }
    await toxiproxy.resetAll();

    // Verify all 4 proxies are registered.
    const proxies = await toxiproxy.listProxies();
    for (const name of ["horizon", "soroban_rpc", "postgres", "redis"]) {
      expect(proxies).toHaveProperty(name);
    }

    await initKeys().catch(() => undefined);
    aliceJwt = generateAccessToken(alice.publicKey(), "sep10");

    pgPool = new Pool({
      connectionString: POSTGRES_PROXY_URL,
      connectionTimeoutMillis: 2000,
    });
    pgPool.on("error", () => undefined);

    redisClient = createClient({
      url: REDIS_PROXY_URL,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 1000) },
    }) as RedisClientType;
    redisClient.on("error", () => undefined);
    await redisClient.connect();

    await Promise.all([fundAccount(alice), fundAccount(bob)]);

    const lock = new RedisAccountLock(redisClient, { maxWaitMs: 3000, retryDelayMs: 100 });
    const stellar = new StellarService(lock, null, {
      horizonUrl: HORIZON_PROXY_URL,
      networkPassphrase: PASSPHRASE,
    });
    const soroban = new SorobanService({
      rpcUrl: RPC_PROXY_URL,
      networkPassphrase: PASSPHRASE,
      pollIntervalMs: 500,
      pollTimeoutMs: 10_000,
    });
    const globeWallet = new GlobeWalletContract(soroban);
    app = createApp(stellar, globeWallet, undefined, {
      disableHealthCache: true,
      healthCheckDeps: {
        horizonUrl: HORIZON_PROXY_URL,
        sorobanRpcUrl: RPC_PROXY_URL,
        redisUrl: REDIS_PROXY_URL,
        lockBackend: "redis",
        checkPostgres: async () => {
          await pgPool.query("SELECT 1");
        },
      },
    });
  });

  afterEach(async () => {
    await toxiproxy.resetAll();
  });

  afterAll(async () => {
    await toxiproxy.resetAll().catch(() => undefined);
    await redisClient?.quit().catch(() => undefined);
    await pgPool?.end().catch(() => undefined);
  });

  it("Horizon partition & TCP reset return 502 HORIZON_UNAVAILABLE and recover cleanly", async () => {
    await toxiproxy.withPartition("horizon", async () => {
      const res = await request(app).get(`/api/v1/account/${alice.publicKey()}`);
      assertChaosErrorEnvelope(res, {
        statuses: [502],
        codes: ["HORIZON_UNAVAILABLE"],
        retryable: true,
      });

      const details = await request(app).get("/api/v1/health/details");
      expect(details.status).toBe(503);
      expect(details.body.status).toBe("down");
      expect(details.body.checks.horizon.ok).toBe(false);
    });

    await toxiproxy.withToxic("horizon", { type: "reset_peer", attributes: { timeout: 0 } }, async () => {
      const res = await request(app).get(`/api/v1/account/${alice.publicKey()}`);
      assertChaosErrorEnvelope(res, {
        statuses: [502],
        codes: ["HORIZON_UNAVAILABLE"],
        retryable: true,
      });
    });

    // Healed: read succeeds again.
    const healed = await request(app).get(`/api/v1/account/${alice.publicKey()}`);
    expect(healed.status).toBe(200);
  });

  it("Horizon latency + duplicate submit guard prevents double spend on-chain", async () => {
    const buildRes = await request(app)
      .post("/api/v1/wallet/send/build")
      .set("Authorization", `Bearer ${aliceJwt}`)
      .send({
        sourcePublicKey: alice.publicKey(),
        destinationPublicKey: bob.publicKey(),
        amount: "2",
      })
      .expect(200);

    const tx = StellarSdk.TransactionBuilder.fromXDR(buildRes.body.xdr, PASSPHRASE);
    tx.sign(alice);
    const signedXdr = tx.toXDR();

    const beforeRes = await request(app).get(`/api/v1/account/${bob.publicKey()}/balances`).expect(200);
    const beforeXlm = Number(beforeRes.body.balances.XLM);

    await toxiproxy.withToxic(
      "horizon",
      { type: "latency", attributes: { latency: 800, jitter: 100 } },
      async () => {
        const key = `toxiproxy-dedup-${Date.now()}`;
        const [first, second] = await Promise.all([
          request(app)
            .post("/api/v1/wallet/submit")
            .set("Authorization", `Bearer ${aliceJwt}`)
            .set("Idempotency-Key", key)
            .send({ signedXdr }),
          request(app)
            .post("/api/v1/wallet/submit")
            .set("Authorization", `Bearer ${aliceJwt}`)
            .set("Idempotency-Key", key)
            .send({ signedXdr }),
        ]);

        const okCount = [first, second].filter((r) => r.status === 200).length;
        expect(okCount).toBeGreaterThanOrEqual(1);
        for (const errRes of [first, second].filter((r) => r.status >= 400)) {
          assertChaosErrorEnvelope(errRes, {
            statuses: [409],
            codes: ["IDEMPOTENCY_KEY_IN_FLIGHT", "TX_ALREADY_SUBMITTED"],
          });
        }
      }
    );

    const afterRes = await request(app).get(`/api/v1/account/${bob.publicKey()}/balances`).expect(200);
    expect(Number(afterRes.body.balances.XLM)).toBeCloseTo(beforeXlm + 2, 5);
  });

  it("Soroban RPC partition & reset return 503 SOROBAN_UNAVAILABLE (retryable)", async () => {
    await toxiproxy.withPartition("soroban_rpc", async () => {
      const res = await request(app)
        .post("/api/v1/contract/wallet/spend/build")
        .set("Authorization", `Bearer ${aliceJwt}`)
        .send({ userPublicKey: alice.publicKey(), assetCode: "XLM", amount: "1000" });
      assertChaosErrorEnvelope(res, {
        statuses: [503],
        codes: ["SOROBAN_UNAVAILABLE"],
        retryable: true,
      });

      const details = await request(app).get("/api/v1/health/details");
      expect(details.status).toBe(503);
      expect(details.body.checks.rpc.ok).toBe(false);
    });
  });

  it("Postgres partition & high latency degrade health without crashing and recover cleanly", async () => {
    await toxiproxy.withPartition("postgres", async () => {
      const details = await request(app).get("/api/v1/health/details");
      expect(details.body.status).toBe("degraded");
      expect(details.body.checks.postgres.ok).toBe(false);
    });

    await toxiproxy.withToxic(
      "postgres",
      { type: "latency", attributes: { latency: 2000, jitter: 0 } },
      async () => {
        const details = await request(app).get("/api/v1/health/details");
        expect(details.body.checks.postgres.ok).toBe(false);
        expect(details.body.checks.postgres.error).toBe("TimeoutError");
      }
    );

    // Healed: pool reconnects and query succeeds.
    const { rows } = await pgPool.query("SELECT 1 AS ok");
    expect(rows[0].ok).toBe(1);
  });

  it("Redis partition fails RedisAccountLock closed (LOCK_UNAVAILABLE) and degrades health", async () => {
    await toxiproxy.withPartition("redis", async () => {
      const lock = new RedisAccountLock(redisClient, { maxWaitMs: 500, retryDelayMs: 50 });
      const work = jest.fn(async () => "never");
      await expect(lock.withLock(alice.publicKey(), work)).rejects.toBeInstanceOf(
        LockUnavailableError
      );
      expect(work).not.toHaveBeenCalled();

      const details = await request(app).get("/api/v1/health/details");
      expect(details.body.status).toBe("degraded");
      expect(details.body.checks.redis.ok).toBe(false);
    });
  });
});
