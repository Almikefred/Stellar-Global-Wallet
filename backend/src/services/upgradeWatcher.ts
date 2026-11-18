/**
 * Upgrade watcher (#186).
 *
 * `propose_upgrade` only needs the admin key; the 3-day timelock is the
 * users' window to react, which only works if proposals are announced. This
 * worker polls Soroban RPC getEvents for `upgrade_proposed` /
 * `upgrade_executed`, raises an ops alert (log + optional webhook) for each,
 * and keeps an in-memory status served publicly at
 * GET /api/v1/contract/upgrade/status.
 *
 * Failure modes: RPC errors are logged and retried on the next poll; the
 * status reports `lastCheckedLedger` so a stalled watcher is visible. RPC
 * only retains ~7 days of events, comfortably longer than the poll gap.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config";
import { createOpsAlertSink, OpsAlertSink } from "./opsAlerts";

const HISTORY_LIMIT = 20;
const LEDGER_SECONDS = 5;

export interface UpgradeEventRecord {
  kind: "proposed" | "executed";
  eventId: string;
  ledger: number;
  txHash?: string;
  actor: string;
  wasmHash: string;
  /** Only for `proposed`. */
  readyAtLedger?: number;
}

export interface UpgradeStatus {
  contractId: string | null;
  watching: boolean;
  lastCheckedLedger: number | null;
  pending: (UpgradeEventRecord & { estimatedExecutableAt: string | null }) | null;
  history: UpgradeEventRecord[];
}

interface RawEvent {
  id: string;
  ledger: number;
  txHash?: string;
  topic: StellarSdk.xdr.ScVal[];
  value: StellarSdk.xdr.ScVal;
}

function toHex(v: unknown): string {
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  return String(v);
}

/** Decodes an `upgrade_proposed` / `upgrade_executed` event; null for anything else. */
export function parseUpgradeEvent(ev: RawEvent): UpgradeEventRecord | null {
  if (ev.topic.length === 0) return null;
  let name: unknown;
  try {
    name = StellarSdk.scValToNative(ev.topic[0]);
  } catch {
    return null;
  }
  if (name !== "upgrade_proposed" && name !== "upgrade_executed") return null;
  const body = StellarSdk.scValToNative(ev.value) as unknown[];
  if (!Array.isArray(body) || body.length < 2) return null;
  const base = {
    eventId: ev.id,
    ledger: ev.ledger,
    txHash: ev.txHash,
    actor: String(body[0]),
    wasmHash: toHex(body[1]),
  };
  if (name === "upgrade_proposed") {
    return { kind: "proposed", ...base, readyAtLedger: Number(body[2]) };
  }
  return { kind: "executed", ...base };
}

export interface UpgradeWatcherDeps {
  contractId: string;
  fetchEvents(startLedger: number | undefined): Promise<{ events: RawEvent[]; latestLedger: number }>;
  alert: OpsAlertSink;
}

export class UpgradeWatcher {
  private seen = new Set<string>();
  private history: UpgradeEventRecord[] = [];
  private pending: UpgradeEventRecord | null = null;
  private lastCheckedLedger: number | null = null;

  constructor(private readonly deps: UpgradeWatcherDeps) {}

  async handle(record: UpgradeEventRecord): Promise<void> {
    if (this.seen.has(record.eventId)) return;
    this.seen.add(record.eventId);
    this.history = [record, ...this.history].slice(0, HISTORY_LIMIT);
    if (record.kind === "proposed") {
      this.pending = record;
      await this.deps.alert({
        kind: "upgrade_proposed",
        message: `Contract upgrade proposed to wasm ${record.wasmHash}, executable from ledger ${record.readyAtLedger}`,
        details: { contractId: this.deps.contractId, ...record },
      });
    } else {
      if (this.pending && this.pending.wasmHash === record.wasmHash) this.pending = null;
      await this.deps.alert({
        kind: "upgrade_executed",
        message: `Contract upgraded to wasm ${record.wasmHash}`,
        details: { contractId: this.deps.contractId, ...record },
      });
    }
  }

  async pollOnce(): Promise<void> {
    // Re-reading the last ledger is harmless (events are de-duplicated by
    // id) and avoids asking RPC for a start ledger that does not exist yet.
    const start = this.lastCheckedLedger ?? undefined;
    const { events, latestLedger } = await this.deps.fetchEvents(start);
    for (const ev of events) {
      const record = parseUpgradeEvent(ev);
      if (record) await this.handle(record);
    }
    this.lastCheckedLedger = latestLedger;
  }

  getStatus(): UpgradeStatus {
    const pending = this.pending
      ? {
          ...this.pending,
          estimatedExecutableAt:
            this.lastCheckedLedger !== null && this.pending.readyAtLedger !== undefined
              ? new Date(
                  Date.now() +
                    Math.max(0, this.pending.readyAtLedger - this.lastCheckedLedger) * LEDGER_SECONDS * 1000
                ).toISOString()
              : null,
        }
      : null;
    return {
      contractId: this.deps.contractId,
      watching: true,
      lastCheckedLedger: this.lastCheckedLedger,
      pending,
      history: [...this.history],
    };
  }
}

let active: UpgradeWatcher | null = null;

/** Status for the public endpoint; `watching: false` when the worker is not running. */
export function getUpgradeWatcherStatus(): UpgradeStatus {
  if (active) return active.getStatus();
  return {
    contractId: config.GLOBE_WALLET_CONTRACT_ID ?? null,
    watching: false,
    lastCheckedLedger: null,
    pending: null,
    history: [],
  };
}

/** Test hook. */
export function setActiveUpgradeWatcher(w: UpgradeWatcher | null): void {
  active = w;
}

/** Starts the poll loop when GLOBE_WALLET_CONTRACT_ID is set. Returns a stop function. */
export function startUpgradeWatcher(): () => void {
  const contractId = config.GLOBE_WALLET_CONTRACT_ID;
  if (!contractId) {
    console.warn("[upgrade-watcher] GLOBE_WALLET_CONTRACT_ID not set, watcher disabled");
    return () => undefined;
  }
  const server = new StellarSdk.rpc.Server(config.SOROBAN_RPC_URL);
  const watcher = new UpgradeWatcher({
    contractId,
    alert: createOpsAlertSink(),
    fetchEvents: async (startLedger) => {
      const from = startLedger ?? Math.max(1, (await server.getLatestLedger()).sequence - 17_280 * 6);
      const res = await server.getEvents({
        startLedger: from,
        filters: [
          {
            type: "contract",
            contractIds: [contractId],
            topics: [
              [StellarSdk.xdr.ScVal.scvSymbol("upgrade_proposed").toXDR("base64")],
              [StellarSdk.xdr.ScVal.scvSymbol("upgrade_executed").toXDR("base64")],
            ],
          },
        ],
        limit: 100,
      });
      return {
        latestLedger: res.latestLedger,
        events: res.events.map((e) => ({
          id: e.id,
          ledger: e.ledger,
          txHash: e.txHash,
          topic: e.topic,
          value: e.value,
        })),
      };
    },
  });
  active = watcher;
  const tick = () =>
    watcher.pollOnce().catch((err: Error) => console.error("[upgrade-watcher] poll failed", err.message));
  void tick();
  const timer = setInterval(tick, config.UPGRADE_WATCHER_POLL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    active = null;
  };
}
