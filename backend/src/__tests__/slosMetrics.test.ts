import { Gauge, metrics, renderMetrics, resetMetrics } from "../services/metrics";

describe("SLO Metrics & Gauge (#222)", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("sets, increments, and decrements gauge values", () => {
    const gauge = new Gauge("test_gauge", "Test gauge description");
    expect(gauge.get()).toBe(0);

    gauge.set(42);
    expect(gauge.get()).toBe(42);

    gauge.inc({}, 8);
    expect(gauge.get()).toBe(50);

    gauge.dec({}, 20);
    expect(gauge.get()).toBe(30);

    const rendered = gauge.render();
    expect(rendered).toContain("# TYPE test_gauge gauge");
    expect(rendered).toContain("test_gauge 30");
  });

  it("renders registered SLO metrics in Prometheus text format", () => {
    metrics.submissionsTotal.inc({ status: "success", route: "wallet_submit" }, 10);
    metrics.submissionsTotal.inc({ status: "failed", route: "wallet_submit" }, 1);
    metrics.submissionDurationMs.observe(150);
    metrics.indexerLagLedgers.set(4, { contract: "CBGLPMNS" });
    metrics.indexerCurrentLedger.set(500000, { contract: "CBGLPMNS" });

    const output = renderMetrics();

    expect(output).toContain("wallet_submissions_total");
    expect(output).toContain('status="success"');
    expect(output).toContain('status="failed"');
    expect(output).toContain("wallet_submission_duration_ms_bucket");
    expect(output).toContain("activity_feed_indexer_lag_ledgers");
    expect(output).toContain("activity_feed_indexer_current_ledger");
  });
});
