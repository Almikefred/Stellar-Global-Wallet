# Distributed Tracing with OpenTelemetry

## Overview

GlobeWallet instruments inbound HTTP requests, database transactions, Redis cache interactions, Horizon submissions, and Soroban RPC calls with OpenTelemetry-compatible distributed traces.

Distributed tracing ensures that latency bottlenecks, remote RPC failures, and submission errors can be investigated across the complete service graph with unified `traceId` correlation.

## Trace Context Propagation

Traces conform to the W3C TraceContext Level 1 specification:

- **Header**: `traceparent: 00-{traceId}-{spanId}-{flags}`
- **Response Headers**: `X-Trace-Id` and `traceparent` are returned on every HTTP response.
- **Error Envelope**: When any API error occurs, `traceId` is included directly in the shared error payload:

```json
{
  "error": {
    "code": "TRANSACTION_FAILED",
    "message": "Transaction failed on Horizon",
    "requestId": "req_01HQK9V5XZYA3B7PNMT6GWD2J1",
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
  }
}
```

## Instrumented Spans

| Span Name | Kind | Attributes |
|---|---|---|
| `HTTP {METHOD} {ROUTE}` | `SERVER` | `http.method`, `http.url`, `http.status_code`, `http.client_ip` |
| `horizon.load_account` | `CLIENT` | `rpc.system: stellar_horizon`, `stellar.account` |
| `horizon.submit_transaction` | `CLIENT` | `rpc.system: stellar_horizon`, `stellar.tx_hash`, `stellar.network` |
| `soroban_rpc.send_transaction` | `CLIENT` | `rpc.system: soroban_rpc`, `stellar.tx_hash`, `stellar.network` |
| `soroban_rpc.simulate_transaction` | `CLIENT` | `rpc.system: soroban_rpc` |
| `soroban_rpc.get_transaction` | `CLIENT` | `rpc.system: soroban_rpc` |

## OpenTelemetry Collector Setup

Run the OpenTelemetry collector with `otel-collector-config.yaml`:

```bash
docker run --rm -v $(pwd)/otel-collector-config.yaml:/etc/otelcol/config.yaml \
  -p 4317:4317 -p 4318:4318 -p 8889:8889 \
  otel/opentelemetry-collector:latest
```
