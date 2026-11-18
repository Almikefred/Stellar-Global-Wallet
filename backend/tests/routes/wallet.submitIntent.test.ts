import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createClientSigningRouter } from "../../src/routes/clientSigning";
import { StellarService } from "../../src/services/stellar";
import { BuiltTransactionRegistry, InMemoryBuiltTransactionStore } from "../../src/services/builtTransactions";
import { InProcessAccountLock } from "../../src/services/locks/accountLock";
import { metrics, resetMetrics } from "../../src/services/metrics";
import { appWithRouter, authHeader } from "../helpers/routerApp";
import { feeBumped, signedPayment, TEST_PASSPHRASE } from "../helpers/signedTx";

jest.mock("../../src/services/idempotency", () => ({
  getCachedResult: jest.fn(async () => null),
  cacheResult: jest.fn(async () => undefined),
}));

const { Horizon } = StellarSdk;

/** The same payment as `signedPayment` would build for `keypair`, plus one extra operation. */
function withExtraOperation(keypair: StellarSdk.Keypair) {
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(keypair.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: TEST_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: StellarSdk.Keypair.random().publicKey(),
        asset: StellarSdk.Asset.native(),
        amount: "5",
      })
    )
    .addOperation(
      StellarSdk.Operation.payment({
        destination: StellarSdk.Keypair.random().publicKey(),
        asset: StellarSdk.Asset.native(),
        amount: "1000",
      })
    )
    .setTimeout(180)
    .build();
  tx.sign(keypair);
  return tx.toXDR();
}

describe("POST /api/v1/wallet/submit — envelope must match a build (issue #194)", () => {
  let registry: BuiltTransactionRegistry;
  let app: ReturnType<typeof appWithRouter>;
  const post = () => request(app).post("/api/v1/wallet/submit").set(authHeader());

  beforeEach(() => {
    resetMetrics();
    registry = new BuiltTransactionRegistry(new InMemoryBuiltTransactionStore(), TEST_PASSPHRASE);
    app = appWithRouter(
      "/api/v1/wallet",
      createClientSigningRouter(new StellarService(new InProcessAccountLock(), registry))
    );
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function mockSubmit(hash = "b".repeat(64)) {
    return jest
      .spyOn(Horizon.Server.prototype, "submitTransaction")
      .mockResolvedValue({ hash, ledger: 9, successful: true } as never);
  }

  it("relays the exact transaction the API built", async () => {
    const built = signedPayment();
    await registry.record(built.tx, { kind: "payment", params: { amount: "5" } });
    const submit = mockSubmit(built.hash);

    const res = await post().send({ signedXdr: built.xdr }).expect(200);

    expect(res.body.hash).toBe(built.hash);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("relays a fee-bump wrapping a built transaction", async () => {
    const built = signedPayment();
    await registry.record(built.tx, { kind: "payment", params: {} });
    const bump = feeBumped(built.tx, StellarSdk.Keypair.random());
    mockSubmit(bump.hash);

    await post().send({ signedXdr: bump.xdr }).expect(200);
  });

  it("rejects a signed envelope with an extra operation as ENVELOPE_MODIFIED", async () => {
    const built = signedPayment();
    await registry.record(built.tx, { kind: "payment", params: {} });
    const submit = mockSubmit();

    const res = await post().send({ signedXdr: withExtraOperation(built.keypair) }).expect(400);

    expect(res.body.error).toMatchObject({
      code: "INVALID_TRANSACTION",
      details: { reason: "ENVELOPE_MODIFIED", intent: "payment" },
    });
    expect(res.body.error.details.differences[0]).toContain("operation count 2");
    expect(submit).not.toHaveBeenCalled();
    expect(metrics.submitRejected.get({ reason: "ENVELOPE_MODIFIED" })).toBe(1);
  });

  it("rejects a transaction the API never built as NOT_BUILT_BY_API", async () => {
    const submit = mockSubmit();

    const res = await post().send({ signedXdr: signedPayment().xdr }).expect(400);

    expect(res.body.error.details.reason).toBe("NOT_BUILT_BY_API");
    expect(submit).not.toHaveBeenCalled();
    expect(metrics.submitRejected.get({ reason: "NOT_BUILT_BY_API" })).toBe(1);
  });

  it("still reports TX_EXPIRED for a built transaction past its time bounds", async () => {
    const built = signedPayment({ maxTime: Math.floor(Date.now() / 1000) - 1 });
    await registry.record(built.tx, { kind: "payment", params: {} });
    const submit = mockSubmit();

    const res = await post().send({ signedXdr: built.xdr }).expect(400);

    expect(res.body.error.code).toBe("TX_EXPIRED");
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects a record made for another network", async () => {
    const built = signedPayment();
    const otherNetwork = new BuiltTransactionRegistry(new InMemoryBuiltTransactionStore(), StellarSdk.Networks.PUBLIC);
    const store = new InMemoryBuiltTransactionStore();
    await store.save({ ...(await otherNetwork.record(built.tx, { kind: "payment", params: {} })) });
    registry = new BuiltTransactionRegistry(store, TEST_PASSPHRASE);
    app = appWithRouter("/api/v1/wallet", createClientSigningRouter(new StellarService(new InProcessAccountLock(), registry)));
    mockSubmit();

    const res = await post().send({ signedXdr: built.xdr }).expect(400);

    expect(res.body.error.details.reason).toBe("WRONG_NETWORK");
  });
});
