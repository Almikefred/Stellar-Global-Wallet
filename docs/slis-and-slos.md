# Service Level Indicators (SLIs) & Service Level Objectives (SLOs)

## Objectives & Targets

GlobeWallet defines three critical SLIs and SLOs measured over rolling 30-day windows:

### 1. Transaction Submission Availability SLO
- **Target**: **>= 99.5%** of valid transaction submissions succeed or land on-chain.
- **Specification**:
  $$\text{SLI} = \frac{\sum \text{rate}(wallet\_submissions\_total\{status="success"\})}{\sum \text{rate}(wallet\_submissions\_total)}$$
- **Error Budget**: 0.5% (0.005) of requests may fail over 30 days.

### 2. Transaction Submission Latency SLO
- **Target**: **95%** of submissions complete in **< 3000ms**; **99%** complete in **< 8000ms**.
- **Specification**:
  $$\text{SLI}_{p95} = \text{histogram\_quantile}(0.95, \sum \text{rate}(wallet\_submission\_duration\_ms\_bucket[5m]) \text{ by } (le))$$

### 3. Activity Feed Indexer Freshness SLO
- **Target**: Indexer lag behind the Stellar ledger tip must remain **<= 10 ledgers** for **>= 99%** of time.
- **Specification**:
  $$\text{SLI} = activity\_feed\_indexer\_lag\_ledgers \le 10$$

---

## Multi-Window Multi-Burn-Rate Alerting

Following Google SRE best practices, alerts are configured using multi-window multi-burn rates to balance detection speed and reset precision:

| Severity | Burn Rate | Short Window | Long Window | Budget Consumed | Notification |
|---|---|---|---|---|---|
| **Critical** | **14.4x** | 5m | 1h | 2% in 1 hour | PagerDuty / On-call Page |
| **Warning** | **6.0x** | 30m | 6h | 5% in 6 hours | Slack / Ops Ticket |
| **Warning** | **3.0x** | 2h | 1d | 10% in 1 day | Ops Ticket |

Prometheus alert definitions are located in `monitoring/prometheus/alerts/slos.yaml`.
Promtool validation test suite is located in `monitoring/prometheus/alerts/test_slos.yaml`.
Grafana dashboard is located in `monitoring/grafana/dashboards/slos-overview.json`.
