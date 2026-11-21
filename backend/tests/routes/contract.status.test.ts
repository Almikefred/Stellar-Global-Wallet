import request from "supertest";
import { createApp } from "../../src/app";
import { StellarService } from "../../src/services/stellar";
import { GlobeWalletContract } from "../../src/services/contracts/globeWallet";
import { SorobanNotConfiguredError } from "../../src/services/sorobanErrors";

function buildApp(globeWallet: Partial<GlobeWalletContract>) {
  const stellar = { generateKeypair: jest.fn() } as unknown as StellarService;
  return createApp(stellar, globeWallet as GlobeWalletContract);
}

describe("GET /api/v1/contract/status (issue #191)", () => {
  it("reports the emergency pause flag without authentication", async () => {
    const getContractStatus = jest.fn().mockResolvedValue({ sendsPaused: true, pauser: "GPAUSER" });
    const res = await request(buildApp({ getContractStatus })).get("/api/v1/contract/status").expect(200);

    expect(res.body).toEqual({ sendsPaused: true, pauser: "GPAUSER" });
  });

  it("reports an unpaused contract", async () => {
    const getContractStatus = jest.fn().mockResolvedValue({ sendsPaused: false, pauser: null });
    const res = await request(buildApp({ getContractStatus })).get("/api/v1/contract/status").expect(200);

    expect(res.body.sendsPaused).toBe(false);
  });

  it("maps a missing contract ID to 503", async () => {
    const getContractStatus = jest.fn().mockRejectedValue(new SorobanNotConfiguredError());
    const res = await request(buildApp({ getContractStatus })).get("/api/v1/contract/status").expect(503);

    expect(res.body.error.code).toBe("SOROBAN_NOT_CONFIGURED");
  });
});
