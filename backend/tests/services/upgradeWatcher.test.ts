import * as StellarSdk from "@stellar/stellar-sdk";
import { parseUpgradeEvent, UpgradeWatcher } from "../../src/services/upgradeWatcher";

const CONTRACT_ID = "CBGLPMNSM4FWMIZ6FFBSRN7FNVCHCI2SLZNODA27LEOXFPLWNYEAEP3K";
const ADMIN = StellarSdk.Keypair.random().publicKey();
const HASH = Buffer.alloc(32, 0xab);

function proposed(id = "1") {
  return {
    id,
    ledger: 500,
    txHash: "tx1",
    topic: [StellarSdk.xdr.ScVal.scvSymbol("upgrade_proposed")],
    value: StellarSdk.xdr.ScVal.scvVec([
      new StellarSdk.Address(ADMIN).toScVal(),
      StellarSdk.xdr.ScVal.scvBytes(HASH),
      StellarSdk.nativeToScVal(52_340, { type: "u32" }),
    ]),
  };
}

function executed(id = "2") {
  return {
    id,
    ledger: 60_000,
    topic: [StellarSdk.xdr.ScVal.scvSymbol("upgrade_executed")],
    value: StellarSdk.xdr.ScVal.scvVec([
      new StellarSdk.Address(ADMIN).toScVal(),
      StellarSdk.xdr.ScVal.scvBytes(HASH),
    ]),
  };
}

describe("parseUpgradeEvent", () => {
  it("decodes upgrade_proposed", () => {
    expect(parseUpgradeEvent(proposed())).toEqual({
      kind: "proposed",
      eventId: "1",
      ledger: 500,
      txHash: "tx1",
      actor: ADMIN,
      wasmHash: HASH.toString("hex"),
      readyAtLedger: 52_340,
    });
  });

  it("ignores unrelated events", () => {
    expect(
      parseUpgradeEvent({ ...proposed(), topic: [StellarSdk.xdr.ScVal.scvSymbol("asset_added")] })
    ).toBeNull();
  });
});

describe("UpgradeWatcher", () => {
  it("announces a proposal once, then clears it on execution", async () => {
    const alert = jest.fn().mockResolvedValue(undefined);
    const fetchEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [proposed()], latestLedger: 600 })
      .mockResolvedValueOnce({ events: [proposed()], latestLedger: 700 })
      .mockResolvedValueOnce({ events: [executed()], latestLedger: 60_001 });
    const watcher = new UpgradeWatcher({ contractId: CONTRACT_ID, fetchEvents, alert });

    await watcher.pollOnce();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ kind: "upgrade_proposed" }));
    expect(watcher.getStatus().pending?.readyAtLedger).toBe(52_340);
    expect(watcher.getStatus().pending?.estimatedExecutableAt).not.toBeNull();

    await watcher.pollOnce(); // duplicate event id → no second alert
    expect(alert).toHaveBeenCalledTimes(1);
    expect(fetchEvents).toHaveBeenLastCalledWith(600);

    await watcher.pollOnce();
    expect(alert).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "upgrade_executed" }));
    const status = watcher.getStatus();
    expect(status.pending).toBeNull();
    expect(status.history.map((h) => h.kind)).toEqual(["executed", "proposed"]);
    expect(status.lastCheckedLedger).toBe(60_001);
  });
});
