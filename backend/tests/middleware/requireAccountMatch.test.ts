import express from "express";
import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  assertSignedXdrAccountMatch,
  requireAccountMatch,
} from "../../src/middleware/requireAccountMatch";
import { errorHandler } from "../../src/middleware/errorHandler";

const ALICE_KP = StellarSdk.Keypair.random();
const BOB_KP = StellarSdk.Keypair.random();
const ALICE = ALICE_KP.publicKey();
const BOB = BOB_KP.publicKey();

function appAs(sub: string | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (sub) req.user = { sub };
    next();
  });
  app.use(requireAccountMatch());
  app.post("/build", (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe("requireAccountMatch (#33)", () => {
  it("allows a request for the authenticated account", async () => {
    const res = await request(appAs(ALICE)).post("/build").send({ sourcePublicKey: ALICE });
    expect(res.status).toBe(200);
  });

  it("rejects a request acting for another account", async () => {
    const res = await request(appAs(ALICE)).post("/build").send({ sourcePublicKey: BOB });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_MISMATCH");
  });

  it("checks the admin, not the guardian, on guardian changes", async () => {
    const ok = await request(appAs(ALICE)).post("/build").send({ admin: ALICE, guardian: BOB });
    expect(ok.status).toBe(200);
    const denied = await request(appAs(BOB)).post("/build").send({ admin: ALICE, guardian: BOB });
    expect(denied.status).toBe(403);
  });

  it("passes requests that name no account", async () => {
    const res = await request(appAs(ALICE)).post("/build").send({ amount: "1" });
    expect(res.status).toBe(200);
  });

  it("does not scope the legacy shared API-key identity", async () => {
    const res = await request(appAs("api-key-user")).post("/build").send({ sourcePublicKey: BOB });
    expect(res.status).toBe(200);
  });

  it("requires authentication", async () => {
    const res = await request(appAs(undefined)).post("/build").send({});
    expect(res.status).toBe(401);
  });

  it("enforces account match on innerAccount (sponsor-fee, #233)", async () => {
    const ok = await request(appAs(ALICE)).post("/build").send({ innerAccount: ALICE });
    expect(ok.status).toBe(200);
    const denied = await request(appAs(BOB)).post("/build").send({ innerAccount: ALICE });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("ACCOUNT_MISMATCH");
  });

  it("enforces account match on candidate (admin/accept) while keeping currentAdmin priority on propose (#233)", async () => {
    const acceptOk = await request(appAs(ALICE)).post("/build").send({ candidate: ALICE });
    expect(acceptOk.status).toBe(200);
    const acceptDenied = await request(appAs(BOB)).post("/build").send({ candidate: ALICE });
    expect(acceptDenied.status).toBe(403);

    // On propose, currentAdmin takes precedence over candidate.
    const proposeOk = await request(appAs(ALICE))
      .post("/build")
      .send({ currentAdmin: ALICE, candidate: BOB });
    expect(proposeOk.status).toBe(200);
    const proposeDenied = await request(appAs(BOB))
      .post("/build")
      .send({ currentAdmin: ALICE, candidate: BOB });
    expect(proposeDenied.status).toBe(403);
  });

  it("derives acting account from legacy secret-key fields and rejects cross-account seeds (#233)", async () => {
    const ok = await request(appAs(ALICE)).post("/build").send({ sourceSecretKey: ALICE_KP.secret() });
    expect(ok.status).toBe(200);

    const denied = await request(appAs(BOB)).post("/build").send({ sourceSecretKey: ALICE_KP.secret() });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("ACCOUNT_MISMATCH");

    // Malformed seeds fall through to validation (400) rather than crashing.
    const malformed = await request(appAs(BOB)).post("/build").send({ sourceSecretKey: "S".repeat(56) });
    expect(malformed.status).toBe(200);
  });

  it("checks assertSignedXdrAccountMatch for inner source and fee-bump feeSource (#233)", () => {
    expect(() => assertSignedXdrAccountMatch(ALICE, ALICE)).not.toThrow();
    expect(() => assertSignedXdrAccountMatch(ALICE, BOB, ALICE)).not.toThrow();
    expect(() => assertSignedXdrAccountMatch("api-key-user", BOB)).not.toThrow();
    expect(() => assertSignedXdrAccountMatch(BOB, ALICE)).toThrow(/does not match/);
    expect(() => assertSignedXdrAccountMatch(undefined, ALICE)).toThrow(/Authentication required/);
  });
});
