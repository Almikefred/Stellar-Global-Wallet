import * as StellarSdk from "@stellar/stellar-sdk";

jest.mock("../../src/services/deviceRegistry", () => ({
  getDevicesForAccounts: jest.fn(),
}));
jest.mock("../../src/services/pushSender", () => ({
  sendPushToAll: jest.fn(),
}));

import { getDevicesForAccounts } from "../../src/services/deviceRegistry";
import { sendPushToAll } from "../../src/services/pushSender";
import {
  isAssetUntrackedTopic,
  notifyAssetUntracked,
  parseAssetUntrackedEvent,
} from "../../src/services/assetMigrationNotifier";

const USER = StellarSdk.Keypair.random().publicKey();

describe("assetMigrationNotifier (#178)", () => {
  afterEach(() => jest.clearAllMocks());

  it("parses the (user, code, limit) tuple", () => {
    expect(parseAssetUntrackedEvent({ type: "vec", value: [USER, "USDC", 1000n] })).toEqual({
      user: USER,
      assetCode: "USDC",
      limit: "1000",
    });
  });

  it("rejects malformed values", () => {
    expect(parseAssetUntrackedEvent(null)).toBeNull();
    expect(parseAssetUntrackedEvent([USER, "USDC"])).toBeNull();
    expect(parseAssetUntrackedEvent(["not-an-address", "USDC", 1])).toBeNull();
    expect(parseAssetUntrackedEvent([USER, "", 1])).toBeNull();
    expect(parseAssetUntrackedEvent([USER, "USDC", -1])).toBeNull();
    expect(parseAssetUntrackedEvent([USER, "USDC", "abc"])).toBeNull();
  });

  it("matches only the migration.asset_untracked topic", () => {
    expect(isAssetUntrackedTopic("migration", "asset_untracked")).toBe(true);
    expect(isAssetUntrackedTopic("recovery", "initiated")).toBe(false);
  });

  it("pushes to the user's devices and says the limit still applies", async () => {
    (getDevicesForAccounts as jest.Mock).mockResolvedValue([{ locale: "en" }]);
    const n = await notifyAssetUntracked([USER, "USDC", "500"], { eventId: "e1", contractId: "C1" });
    expect(n).toBe(1);
    expect(getDevicesForAccounts).toHaveBeenCalledWith([USER]);
    const message = (sendPushToAll as jest.Mock).mock.calls[0][1];
    expect(message.body).toContain("USDC");
    expect(message.body).toContain("spend limit is still in force");
    expect(message.data).toMatchObject({ eventId: "e1", assetCode: "USDC", limit: "500" });
  });

  it("does nothing for an unparseable event", async () => {
    const n = await notifyAssetUntracked({ value: 42 }, { eventId: "e2", contractId: "C1" });
    expect(n).toBe(0);
    expect(sendPushToAll).not.toHaveBeenCalled();
  });
});
