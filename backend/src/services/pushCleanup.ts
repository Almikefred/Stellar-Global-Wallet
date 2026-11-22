/**
 * Push notification cleanup worker (#124).
 *
 * Runs periodically to:
 *   - Prune expired Expo tokens (based on expires_at)
 *   - Process Expo receipts for invalid tokens (optional integration)
 *
 * Start this worker in index.ts alongside startPaymentNotifier().
 */

import { pool } from "../db";
import { getValidDevicesForAccount, pruneInvalidTokens } from "./deviceRegistry";
import { sendPush } from "./pushSender";
import { metrics } from "./metrics";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Every hour
const BATCH_SIZE = 100;

/**
 * Starts the push notification cleanup worker. This function never returns
 * (it loops forever, sleeping between runs). Call it once at startup
 * from index.ts.
 */
export async function startPushCleanupWorker(): Promise<void> {
  console.log("[push-cleanup] starting");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runCleanup();
    } catch (err) {
      console.error("[push-cleanup] error during cleanup", (err as Error).message);
    }
    await sleep(CLEANUP_INTERVAL_MS);
  }
}

async function runCleanup(): Promise<void> {
  // Prune expired tokens
  const expired = await pruneExpiredTokens();
  console.log(`[push-cleanup] pruned ${expired} expired token(s)`);

  // TODO: Integrate with Expo receipts if needed
  // This would require storing receipts from push delivery and processing them
}

/**
 * Prunes tokens that have expired (expires_at < NOW).
 * Returns count of pruned tokens.
 */
async function pruneExpiredTokens(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM devices WHERE expires_at IS NOT NULL AND expires_at < NOW()`
  );
  const count = (rowCount ?? 0);
  if (count > 0) {
    metrics.pushTokensExpired.inc({ platform: "expo" }, count);
  }
  return count;
}

/**
 * Process a batch of devices to check for invalid tokens.
 * This would integrate with Expo's receipt system if we stored them.
 */
export async function processReceiptsForDevices(
  devices: Array<{ id: string; account: string; token: string; platform: string }>
): Promise<{ pruned: string[]; failed: string[] }> {
  const pruned: string[] = [];
  const failed: string[] = [];

  for (const device of devices) {
    if (device.platform !== "expo") continue;

    // Simulate a delivery check
    try {
      const deviceObj = {
        id: device.id,
        account: device.account,
        platform: device.platform as "expo",
        token: device.token,
        locale: "en",
        createdAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: null,
      };

      // Send a minimal "ping" notification
      const result = await sendPush(deviceObj, {
        title: "Ping",
        body: "Verify this device still receives notifications",
      });

      if (!result.success) {
        failed.push(device.token);
        if (result.pruned) pruned.push(...result.pruned);
      }
    } catch (err) {
      console.error(`[push-cleanup] error checking device ${device.id}`, (err as Error).message);
      failed.push(device.token);
    }
  }

  return { pruned, failed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
