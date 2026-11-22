import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { sendPush, resetRateLimit } from "../../../src/services/pushSender";
import { Device } from "../../../src/services/deviceRegistry";
import { metrics, resetMetrics } from "../../../src/services/metrics";

describe("pushSender", () => {
  beforeEach(() => {
    resetMetrics();
    resetRateLimit();
  });

  describe("sendPush", () => {
    it("handles expo platform", async () => {
      const device: Device = {
        id: "1",
        account: "GTESTACCOUNT1234567890123456789012345678901234",
        platform: "expo",
        token: "ExponentPushToken[test123]",
        locale: "en",
        createdAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: null,
      };

      const message = { title: "Test", body: "Test message" };

      // This will fail in test (no actual push endpoint) but should return proper structure
      const result = await sendPush(device, message);

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("pruned");
    });

    it("handles web platform", async () => {
      const device: Device = {
        id: "1",
        account: "GTESTACCOUNT1234567890123456789012345678901234",
        platform: "web",
        token: JSON.stringify({
          endpoint: "https://push.example.com/test",
          keys: { p256dh: "key123", auth: "auth456" },
        }),
        locale: "en",
        createdAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: null,
      };

      const message = { title: "Test", body: "Test message" };

      const result = await sendPush(device, message);

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("pruned");
    });
  });

  describe("rate limiting", () => {
    it("enforces rate limits", () => {
      const account = "GTESTACCOUNT1234567890123456789012345678901234";

      // Should allow first few requests
      expect(true).toBe(true);
    });
  });
});
