/**
 * Tells a user when `migrate_user_assets` trims an asset from their list (#178).
 *
 * The contract keeps the spend limit of a trimmed asset (the token can still
 * be sent, so the limit must still apply) and emits one event per trimmed asset:
 *
 *   topics = ("migration", "asset_untracked")
 *   value  = (user: Address, asset_code: String, limit: i128)
 *
 * `recoveryNotifier` already polls this contract's events, so it passes these
 * on to `notifyAssetUntracked`. Dedup happens there, before this is called.
 */

import { getDevicesForAccounts } from "./deviceRegistry";
import { sendPushToAll } from "./pushSender";
import { tNotification } from "./i18nHelper";

export interface AssetUntrackedEvent {
  user: string;
  assetCode: string;
  /** Stroops as a string; "0" means the asset had no limit. */
  limit: string;
}

interface EventValue {
  type?: string;
  value?: unknown;
}

function unwrap(v: unknown): unknown {
  if (v && typeof v === "object" && "value" in (v as object)) {
    return (v as EventValue).value;
  }
  return v;
}

/** Parses the event value; returns null for any shape we don't recognise. */
export function parseAssetUntrackedEvent(value: unknown): AssetUntrackedEvent | null {
  const raw = unwrap(value);
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const [userRaw, codeRaw, limitRaw] = raw.map(unwrap);
  if (typeof userRaw !== "string" || !/^[GC][A-Z2-7]{55}$/.test(userRaw)) return null;
  if (typeof codeRaw !== "string" || codeRaw.length === 0 || codeRaw.length > 12) return null;
  let limit: bigint;
  try {
    if (typeof limitRaw !== "bigint" && typeof limitRaw !== "number" && typeof limitRaw !== "string") {
      return null;
    }
    limit = BigInt(limitRaw);
  } catch {
    return null;
  }
  if (limit < 0n) return null;
  return { user: userRaw, assetCode: codeRaw, limit: limit.toString() };
}

export function isAssetUntrackedTopic(topic0: string | null, topic1: string | null): boolean {
  return topic0 === "migration" && topic1 === "asset_untracked";
}

/** Push to every device of the user. Returns the number of devices notified. */
export async function notifyAssetUntracked(
  value: unknown,
  meta: { eventId: string; contractId: string }
): Promise<number> {
  const parsed = parseAssetUntrackedEvent(value);
  if (!parsed) {
    console.warn("[asset-migration-notifier] unrecognised event value", meta.eventId);
    return 0;
  }
  const devices = await getDevicesForAccounts([parsed.user]);
  if (devices.length === 0) return 0;
  const locale = devices[0]?.locale ?? "en";
  const limited = parsed.limit !== "0";
  const bodyKey = limited ? "migration.asset_untracked.body_limited" : "migration.asset_untracked.body";
  await sendPushToAll(devices, {
    title: tNotification("migration.asset_untracked.title", locale),
    body: tNotification(bodyKey, locale, { asset: parsed.assetCode }),
    data: {
      eventId: meta.eventId,
      contractId: meta.contractId,
      assetCode: parsed.assetCode,
      limit: parsed.limit,
    },
  });
  return devices.length;
}
