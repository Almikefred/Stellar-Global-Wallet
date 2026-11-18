/**
 * Minimal in-process metrics registry: labelled counters and histograms,
 * rendered in the Prometheus text format at GET /api/v1/health/metrics.
 *
 * Deliberately dependency-free. Values are per process; a scraper sums
 * them across instances.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
}

export class Counter {
  private readonly values = new Map<string, number>();

  constructor(readonly name: string, readonly help: string) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key ? `{${key}}` : ""} ${value}`);
    }
    return lines;
  }
}

interface HistogramSeries {
  buckets: number[];
  sum: number;
  count: number;
}

export class Histogram {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly bounds: number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000]
  ) {}

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.bounds.forEach((bound, i) => {
      if (value <= bound) s!.buckets[i] += 1;
    });
    s.sum += value;
    s.count += 1;
  }

  count(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.count ?? 0;
  }

  reset(): void {
    this.series.clear();
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, s] of this.series) {
      const prefix = key ? `${key},` : "";
      this.bounds.forEach((bound, i) => {
        lines.push(`${this.name}_bucket{${prefix}le="${bound}"} ${s.buckets[i]}`);
      });
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${key ? `{${key}}` : ""} ${s.sum}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ""} ${s.count}`);
    }
    return lines;
  }
}

const registry: Array<Counter | Histogram> = [];

function register<T extends Counter | Histogram>(metric: T): T {
  registry.push(metric);
  return metric;
}

export const metrics = {
  /** #194 — signed envelopes refused at /wallet/submit, by reason. */
  submitRejected: register(
    new Counter("wallet_submit_rejected_total", "Signed envelopes refused before relay, by reason")
  ),
  /** #197 — time spent waiting for an account lock, by backend. */
  lockWaitMs: register(new Histogram("account_lock_wait_ms", "Milliseconds spent waiting to acquire an account lock")),
  /** #197 — acquisitions that found the lock already held at least once. */
  lockContended: register(new Counter("account_lock_contended_total", "Lock acquisitions that had to wait")),
  /** #197 — acquisitions that gave up (timeout) or could not reach the backend. */
  lockFailures: register(new Counter("account_lock_failures_total", "Lock acquisitions that failed, by reason")),
  /** #197 — leases that could not be extended because they had already expired or were taken over. */
  lockLeaseLost: register(new Counter("account_lock_lease_lost_total", "Lease extensions refused by the lock backend")),
  /** #196 — sponsored-reserve onboarding and reclamation. */
  sponsorships: register(new Counter("sponsored_reserves_total", "Sponsored reserve events, by event and kind")),
};

export function renderMetrics(): string {
  return registry.flatMap((m) => m.render()).join("\n") + "\n";
}

/** Test helper: zero every metric. */
export function resetMetrics(): void {
  registry.forEach((m) => m.reset());
}
