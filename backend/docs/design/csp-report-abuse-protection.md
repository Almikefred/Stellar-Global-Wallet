# CSP report endpoint: abuse protection and aggregation (issue #252)

**Status:** Proposed. Nothing in this document is implemented yet. It
describes the target design for `src/routes/cspReport.ts`. Update the status
line and the "Current state" section in the same PR that ships the change.

Related: [`docs/security/csp.md`](../security/csp.md) (the policy that makes
browsers send these reports) and [`docs/rate-limits.md`](../rate-limits.md).

## Current state

`cspReportRouter` is mounted twice in `src/app.ts`: at `/csp-report` and at
`/api/v1/csp-report`. Both mounts use the same router instance, so they also
share one limiter. A request goes through these steps:

1. The global limiter: 100 requests per 15 minutes per IP.
2. `cspReportLimiter`: 60 requests per minute per IP, using an in-memory
   store, with error code `CSP_REPORT_RATE_LIMITED`.
3. `express.json` with a 64 kb limit. It accepts `application/json`,
   `application/csp-report` and `application/reports+json`.
4. `extractViolations()` normalises the legacy `report-uri` shape and the
   Reporting API array shape.
5. **Each violation is passed in full to `console.warn("[csp-report]", JSON.stringify(violation))`.**
6. The handler returns `204`.

### Gaps

| # | Gap | Effect |
|---|---|---|
| G1 | The number of entries per request has no limit. A 64 kb Reporting API array can hold hundreds of small `csp-violation` entries. | One request can write hundreds of log lines. At 60 req/min/IP that is tens of thousands of lines per minute from a single IP. |
| G2 | The size of each field has no limit. `script-sample`, `blocked-uri` and similar fields are logged as they arrive. | A few requests can produce very large log lines, which raises disk and ingest costs. |
| G3 | The logged fields are not restricted. Every key the client sends is logged. | An attacker can write any JSON they like into our logs. The JSON is escaped, so this cannot inject extra lines, but it still pollutes searches and alerts. |
| G4 | URLs are logged in full. `document-uri`, `referrer` and `blocked-uri` can contain query strings and fragments. | The code comment says reports never contain user input or secrets. That is not true: magic-link tokens, OAuth `code`/`state` values or deep-link parameters in the page URL would be written to logs. |
| G5 | Reports are not aggregated. Every violation becomes its own log line. | A single bad policy on a popular page drowns everything else in the logs. Nobody can easily answer "which directive is firing, and how often?" |
| G6 | The rate limiter keeps its counts in each process's memory. | With N instances, the real limit is N × 60 per IP. This is the same issue as the other in-memory limiters described in [`concurrency.md`](../concurrency.md). |
| G7 | No metrics are recorded for this route. | When reports are dropped or limited, nothing shows it. |

## Threat model

**Attacker:** anyone on the internet. The endpoint is unauthenticated by
design, because browsers send reports without credentials. We cannot tell a
real browser from a script, so the design does not try to. It only limits
how much any one sender can cost us.

**Assets:**

- Log storage and ingest budget.
- How useful the logs are. Real errors must not be buried.
- Privacy of URLs that may carry tokens.
- Process memory and CPU.

**Out of scope:** stopping a distributed flood from many IPs. That belongs
at the edge (CDN or WAF). The design here only guarantees that each report
costs a fixed, small amount, so a distributed flood degrades predictably.

| Attack | Mitigation |
|---|---|
| A single IP floods requests | Per-IP rate limit (exists today), backed by a shared store where one is available |
| One request packed with many entries | Body limit lowered to 16 kb, plus a cap on violations per request |
| Very large fields | Only allowlisted fields are kept, and each string is truncated |
| Junk keys and values | Only allowlisted fields are kept, and unknown `effective-directive` values are grouped together |
| Many distinct values sent to blow up aggregation memory | The aggregation map has a size limit, plus an overflow bucket |
| Tokens leaking through URLs | Query strings and fragments are removed before logging or aggregation |

## Proposed design

### 1. Limits on size and count

| Limit | Value (default) | Env var |
|---|---|---|
| Body size | 16 kb (down from 64 kb). A real legacy report is under 2 kb. | `CSP_REPORT_MAX_BODY` |
| Violations processed per request | 20. Any extra entries are dropped and counted. | `CSP_REPORT_MAX_VIOLATIONS` |
| Length of each string field | 256 characters, with a `…` suffix when cut | n/a (constant) |
| Per-IP rate | 60 per minute (unchanged) | `CSP_REPORT_RATE_MAX` |

The limiter uses the Redis store when `LOCK_BACKEND=redis` (the same switch
as `RedisAccountLock`), which closes G6. Otherwise it falls back to the
in-memory store and logs a warning once at startup.

A body over the size limit gets `413` with code `CSP_REPORT_TOO_LARGE` in
the shared error envelope. Browsers ignore the response either way. The
status code is there for curl and tests. A well-formed body that has no
usable violations still returns `204`. We don't return `400` for that,
because browsers batch other report types such as `deprecation` and
`intervention` through the same endpoint.

### 2. Normalisation (input validation at the edge)

A new `normalizeViolation(raw): CspViolation | null` function maps both
input shapes onto a single fixed type:

```ts
interface CspViolation {
  directive: string;     // effective-directive ?? violated-directive, lower-cased, first token only
  blockedOrigin: string; // origin of blocked-uri, or the keyword ("inline", "eval", "data", ...)
  documentPath: string;  // path of document-uri: no query string, no fragment
  disposition: "enforce" | "report" | "unknown";
  sourceFile?: string;   // origin + path only
  line?: number;
  column?: number;
  sample?: string;       // script-sample, truncated to 40 characters
}
```

Rules:

- `directive` must belong to a fixed set of CSP directive names
  (`script-src`, `script-src-elem`, `style-src`, `img-src`, `connect-src`,
  `frame-src`, `font-src`, `object-src`, `base-uri`, `form-action`,
  `frame-ancestors`, `worker-src`, `manifest-src`, `media-src`,
  `default-src`, `require-trusted-types-for`, `trusted-types`). Anything
  else becomes `"other"`.
- URLs go through `new URL()`. If parsing fails, the value becomes
  `"invalid"`. Query strings and fragments are always removed.
- Every field not in the type above is dropped.
- If there is no directive, the entry is dropped and counted as `malformed`.

### 3. Aggregation by directive

A `CspReportAggregator` keeps an in-process map with entries of the form
`key → { count, firstSeen, lastSeen, example }`, where:

```
key = `${directive}|${blockedOrigin}|${documentPath}`
```

- **Flush:** every `CSP_REPORT_FLUSH_MS` (default 60 s), the aggregator logs
  one line per key, then clears the map:
  `{"level":"warn","event":"csp_violation_summary","directive":…,"blockedOrigin":…,"documentPath":…,"count":…,"windowMs":…}`.
  The flush timer is `unref()`'d. It is also flushed during graceful
  shutdown (#220), so counts are not lost on deploy.
- **Size limit:** at most `CSP_REPORT_MAX_KEYS` keys (default 500). Once the
  map is full, new keys are counted under `directive|__overflow__|__overflow__`.
  That way, high-cardinality junk costs constant memory and still shows up
  in the logs.
- **Metrics:** these counters are added to `services/metrics.ts`:
  - `csp_reports_total{outcome}`, where `outcome` is one of `accepted`,
    `rate_limited`, `too_large`, `truncated`, `malformed` or `sampled_out`.
  - `csp_violations_total{directive}`. The label only takes values from the
    fixed directive set, so cardinality stays bounded.

### 4. Sampling

Aggregation already caps the number of summary lines. Sampling caps the
number of detailed lines:

- The **first** occurrence of each key in a flush window is logged in full,
  with event name `csp_violation_example`. This gives one example to debug
  from.
- Later occurrences are only counted, unless a random draw falls below
  `CSP_REPORT_SAMPLE_RATE` (default `0`, range `0`–`1`). Setting `1` brings
  back today's log-everything behaviour while you debug a policy rollout.
- Counters always count every report, including ones that sampling did not
  log, so metrics stay exact.

### Data model

There is no database table. Reports are still logged only, as
[`csp.md`](../security/csp.md) already decides. The only new state is the
aggregation map in each process, and it is lost when the process restarts.
That is fine, because the data is diagnostic and the metrics counters are
the long-term record.

### Failure modes

| Failure | Behaviour |
|---|---|
| Redis is down while the Redis store is in use | Fail open: in-memory limiting takes over and a warning is logged. CSP reporting is diagnostic, so it must never take down the API. |
| The aggregator throws | The error is caught in the handler, `csp_reports_total{outcome="malformed"}` goes up, and the response is still `204` |
| The process crashes before a flush | Up to one window of summary lines is lost. Counters already scraped are kept. |
| A real policy regression produces huge real traffic | Summary lines grow with the number of distinct keys, not with traffic. The overflow bucket caps that too. |
| The flood is spread across many IPs | Each request still costs a bounded amount. Blocking it belongs at the edge (out of scope). |

## Test plan

Add these to `src/__tests__/cspReport.test.ts`:

- [ ] **Flood is rate-limited.** Request number 61 from the same IP within a
      minute returns `429` with `CSP_REPORT_RATE_LIMITED` and `RateLimit-*`
      headers.
- [ ] A body over 16 kb returns `413` with `CSP_REPORT_TOO_LARGE`.
- [ ] An array of 100 violations: only 20 are processed and
      `csp_reports_total{outcome="truncated"}` goes up.
- [ ] Query strings and fragments are removed from `document-uri` and
      `blocked-uri`. The test asserts that a `?token=secret` never appears
      in the captured log output.
- [ ] Unknown keys are dropped, and a long `script-sample` is truncated.
- [ ] An unknown directive is recorded as `other`.
- [ ] 1,000 identical violations give 1 example line and 1 summary line
      with `count: 1000` after a flush (use Jest fake timers).
- [ ] Distinct keys beyond `CSP_REPORT_MAX_KEYS` go into `__overflow__`.
- [ ] With `CSP_REPORT_SAMPLE_RATE=0`, only first occurrences are logged.
      With `1`, everything is logged.
- [ ] Non-CSP Reporting API entries return `204` and are not logged.
- [ ] Both mounts (`/csp-report` and `/api/v1/csp-report`) share the same
      limits.

## Rollout and docs checklist

- [ ] Add the new env vars to `src/config.ts` (zod-validated) and to
      `.env.example`.
- [ ] Update the "Reporting" section of [`csp.md`](../security/csp.md). It
      should cover the limits, the summary and example log events, and the
      URL redaction. Also remove the "no user input" claim.
- [ ] Add `CSP_REPORT_TOO_LARGE` to `openapi-errors.yaml` and document the
      `413` on both CSP report paths in `openapi.yaml`.
- [ ] Add a row for the CSP limiter to [`rate-limits.md`](../rate-limits.md).
- [ ] No SDK change: the SDK never calls this endpoint.
