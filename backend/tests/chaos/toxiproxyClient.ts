/**
 * Zero-dependency client for Shopify's Toxiproxy Admin HTTP API (#234).
 *
 * Used by `toxiproxyChaos.test.ts` to inject real network faults (latency,
 * TCP peer resets, silent timeouts, bandwidth limits, and full partitions)
 * against Horizon, Soroban RPC, Postgres, and Redis proxies defined in
 * `chaos/toxiproxy.json`.
 */

export type ToxicStream = "upstream" | "downstream";

export interface ToxicSpec {
  name?: string;
  type:
    | "latency"
    | "down"
    | "bandwidth"
    | "slow_close"
    | "timeout"
    | "reset_peer"
    | "slicer"
    | "limit_data";
  stream?: ToxicStream;
  toxicity?: number;
  attributes: Record<string, number>;
}

export interface ProxyInfo {
  name: string;
  listen: string;
  upstream: string;
  enabled: boolean;
  toxics: Array<ToxicSpec & { name: string }>;
}

export class ToxiproxyClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = process.env.CHAOS_TOXIPROXY_URL ?? "http://localhost:8474") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Toxiproxy ${method} ${path} failed (${res.status}): ${text}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  async version(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/version`);
    if (!res.ok) throw new Error(`Toxiproxy /version returned ${res.status}`);
    return (await res.text()).trim();
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.version();
      return true;
    } catch {
      return false;
    }
  }

  async listProxies(): Promise<Record<string, ProxyInfo>> {
    return this.request<Record<string, ProxyInfo>>("GET", "/proxies");
  }

  async getProxy(name: string): Promise<ProxyInfo> {
    return this.request<ProxyInfo>("GET", `/proxies/${encodeURIComponent(name)}`);
  }

  async setEnabled(name: string, enabled: boolean): Promise<ProxyInfo> {
    return this.request<ProxyInfo>("POST", `/proxies/${encodeURIComponent(name)}`, { enabled });
  }

  /** Simulates a full network partition (connections refused immediately). */
  async partition(name: string): Promise<ProxyInfo> {
    return this.setEnabled(name, false);
  }

  /** Restores connectivity to a partitioned proxy. */
  async heal(name: string): Promise<ProxyInfo> {
    return this.setEnabled(name, true);
  }

  async addToxic(proxyName: string, toxic: ToxicSpec): Promise<ToxicSpec & { name: string }> {
    return this.request<ToxicSpec & { name: string }>(
      "POST",
      `/proxies/${encodeURIComponent(proxyName)}/toxics`,
      {
        stream: "downstream",
        toxicity: 1.0,
        ...toxic,
      }
    );
  }

  async removeToxic(proxyName: string, toxicName: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/proxies/${encodeURIComponent(proxyName)}/toxics/${encodeURIComponent(toxicName)}`
    );
  }

  async addLatency(
    proxyName: string,
    latencyMs: number,
    jitterMs = 0,
    stream: ToxicStream = "downstream"
  ) {
    return this.addToxic(proxyName, {
      name: `latency_${stream}`,
      type: "latency",
      stream,
      attributes: { latency: latencyMs, jitter: jitterMs },
    });
  }

  async addResetPeer(proxyName: string, timeoutMs = 0, stream: ToxicStream = "downstream") {
    return this.addToxic(proxyName, {
      name: `reset_peer_${stream}`,
      type: "reset_peer",
      stream,
      attributes: { timeout: timeoutMs },
    });
  }

  async addTimeout(proxyName: string, timeoutMs = 0, stream: ToxicStream = "downstream") {
    return this.addToxic(proxyName, {
      name: `timeout_${stream}`,
      type: "timeout",
      stream,
      attributes: { timeout: timeoutMs },
    });
  }

  /** Enables all proxies and removes all toxics across the entire Toxiproxy instance. */
  async resetAll(): Promise<void> {
    await this.request<void>("POST", "/reset");
  }

  /** Runs `fn` while a toxic is active and guarantees cleanup in `finally`. */
  async withToxic<T>(proxyName: string, toxic: ToxicSpec, fn: () => Promise<T>): Promise<T> {
    const added = await this.addToxic(proxyName, toxic);
    try {
      return await fn();
    } finally {
      await this.removeToxic(proxyName, added.name).catch(() => undefined);
    }
  }

  /** Runs `fn` while a proxy is partitioned (disabled) and guarantees healing in `finally`. */
  async withPartition<T>(proxyName: string, fn: () => Promise<T>): Promise<T> {
    await this.partition(proxyName);
    try {
      return await fn();
    } finally {
      await this.heal(proxyName).catch(() => undefined);
    }
  }
}
