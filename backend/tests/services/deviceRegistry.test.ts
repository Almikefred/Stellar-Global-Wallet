import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { Pool } from "pg";
import { setupTestDB, dropTestDB } from "../../env.setup";
import {
  ensureDevicesTable,
  upsertDevice,
  deleteDevice,
  listDevices,
  pruneInvalidTokens,
  Platform,
} from "../../../src/services/deviceRegistry";
import { pool } from "../../../src/db";

describe("deviceRegistry", () => {
  let db: Pool;

  beforeAll(async () => {
    db = await setupTestDB();
    await ensureDevicesTable(db);
  });

  afterAll(async () => {
    await dropTestDB();
  });

  const testAccount = "GTESTACCOUNTID1234567890123456789012345678901234";
  const testAccount2 = "GTESTACCOUNTID2234567890123456789012345678901234";

  describe("upsertDevice", () => {
    it("creates a new device", async () => {
      const device = await upsertDevice(
        testAccount,
        "expo",
        "ExponentPushToken[abcdef123456]",
        "en"
      );
      expect(device.id).toBeDefined();
      expect(device.account).toBe(testAccount);
      expect(device.platform).toBe("expo");
      expect(device.token).toBe("ExponentPushToken[abcdef123456]");
      expect(device.locale).toBe("en");
      expect(device.expiresAt).toBeDefined();
    });

    it("updates last_seen_at when same token is registered again", async () => {
      const device1 = await upsertDevice(
        testAccount,
        "expo",
        "ExponentPushToken[abcdef123456]",
        "en"
      );
      const createdAt = device1.createdAt;

      // Wait a bit and re-register
      await new Promise((resolve) => setTimeout(resolve, 100));
      const device2 = await upsertDevice(
        testAccount,
        "expo",
        "ExponentPushToken[abcdef123456]",
        "en-US"
      );

      expect(device2.id).toBe(device1.id);
      expect(device2.lastSeenAt).toBeGreaterThan(device1.lastSeenAt);
      expect(device2.locale).toBe("en-US");
      expect(device2.createdAt).toBe(createdAt);
    });
  });

  describe("deleteDevice", () => {
    it("deletes a device", async () => {
      const device = await upsertDevice(
        testAccount,
        "web",
        JSON.stringify({
          endpoint: "https://push.example.com/abc",
          keys: { p256dh: "key123", auth: "auth456" },
        }),
        "en"
      );

      const deleted = await deleteDevice(testAccount, device.id);
      expect(deleted).toBe(true);

      // Verify deletion
      const remaining = await listDevices(testAccount);
      expect(remaining).toHaveLength(0);
    });

    it("returns false when device not found", async () => {
      const deleted = await deleteDevice(testAccount, "999999");
      expect(deleted).toBe(false);
    });

    it("prevents deleting another user's device", async () => {
      const device = await upsertDevice(
        testAccount,
        "expo",
        "ExponentPushToken[xyz789]",
        "en"
      );

      const deleted = await deleteDevice(testAccount2, device.id);
      expect(deleted).toBe(false);
    });
  });

  describe("listDevices", () => {
    it("returns all devices for an account", async () => {
      await upsertDevice(
        testAccount,
        "expo",
        "ExponentPushToken[aaa111]",
        "en"
      );
      await upsertDevice(
        testAccount,
        "web",
        JSON.stringify({
          endpoint: "https://push.example.com/bbb",
          keys: { p256dh: "key222", auth: "auth333" },
        }),
        "en"
      );

      const devices = await listDevices(testAccount);
      expect(devices).toHaveLength(2);
      expect(devices[0].platform).toBe("web");
      expect(devices[1].platform).toBe("expo");
    });

    it("returns empty array when no devices", async () => {
      const devices = await listDevices(testAccount2);
      expect(devices).toHaveLength(0);
    });
  });

  describe("pruneInvalidTokens", () => {
    it("removes specified tokens", async () => {
      await upsertDevice(
        testAccount,
        "expo",
        "ExponentPushToken[prune1]",
        "en"
      );
      await upsertDevice(
        testAccount,
        "expo",
        "ExponentPushToken[prune2]",
        "en"
      );
      await upsertDevice(
        testAccount,
        "web",
        JSON.stringify({
          endpoint: "https://push.example.com/keep",
          keys: { p256dh: "key444", auth: "auth555" },
        }),
        "en"
      );

      const pruned = await pruneInvalidTokens(testAccount, [
        "ExponentPushToken[prune1]",
        "ExponentPushToken[prune2]",
      ]);
      expect(pruned).toBe(2);

      const remaining = await listDevices(testAccount);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].token).toContain("keep");
    });
  });
});
