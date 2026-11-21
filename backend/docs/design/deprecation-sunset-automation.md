# Deprecated route cleanup and API sunset automation (issue #254)

**Status:** Proposed. Nothing in this document is implemented yet. It
describes the target design for `src/middleware/deprecated.ts` and the
routes that use it. Update the status line in the PR that ships it.

Related: [`versioning.md`](../versioning.md), which defines the 6-month
deprecation window. This document makes that policy enforceable.

## Current state

`src/middleware/deprecated.ts`:

- Sets one hard-coded `SUNSET = 2027-01-01T00:00:00Z` for **every** route.
- Emits `Deprecation: @<epoch>` (RFC 9745), `Sunset: <HTTP-date>` (RFC 8594)
  and `Link: </docs/client-signing>; rel="deprecation"`.
- Logs one `deprecated_route_called` JSON line **per request**.

These are the current call sites:

| Route | Where | Replacement |
|---|---|---|
| `POST /api/v1/wallet/send` | `src/routes/wallet.ts` | client-side signing ([`client-signing.md`](../client-signing.md)) |
| `POST /api/v1/wallet/fee-bump` | same | same |
| `POST /api/v1/wallet/path-payment-strict-send` | same | same |
| `POST /api/v1/wallet/path-payment-strict-receive` | same | same |
| `POST /api/v1/wallet/partial-transaction` | same | same |
| `POST /api/v1/wallet/keypair` | same | same |
| `POST /api/v1/contract/wallet/spend` | `src/routes/contract.ts` | same |
| `apiKeyAuth` on `POST /api/v1/auth/login` | `src/middleware/apiKeyAuth.ts` | JWT / Bearer ([`auth.md`](../auth.md)) |

### Gaps

| # | Gap | Effect |
|---|---|---|
| G1 | All routes share one sunset date. | Routes can't be retired on separate schedules, and the date sits in code rather than next to the route. |
| G2 | The `Deprecation` date is the *sunset* date. RFC 9745 says it should be the date the deprecation *took effect*. | Clients see wrong metadata. |
| G3 | `apiKeyAuth` uses its own non-standard `X-Deprecated` header and its own log line. | There are two deprecation mechanisms. `apiKeyAuth` is invisible to any tooling built on `deprecated()`. |
| G4 | Usage is recorded in per-request log lines only, with no metrics. | Nobody can tell whether traffic on a route has dropped to zero, which is the signal that it is safe to remove. The logs also grow with traffic, which is the same flooding problem as #252. |
| G5 | Nothing happens when the sunset date passes. | Deprecated paths linger forever, which adds attack surface. These particular paths handle **server-side signing**. |
| G6 | Nothing ties the code to the OpenAPI spec. | `openapi.yaml` may disagree with the code about which routes are deprecated. |

## Threat model

Deprecated routes are attack surface we no longer test or improve. The
server-side signing routes listed above are especially sensitive, because
they handle secret keys. The risks:

1. **Lingering routes.** A deprecated route is never removed and drifts out
   of security review.
2. **Silent breakage.** A route is removed while clients still depend on it.
3. **Metadata drift.** Headers, docs and the spec disagree, so integrators
   don't migrate.

The design makes removal *the default outcome* (CI forces a decision when
the sunset date arrives) and makes it *safe* (usage metrics show who is
still calling).

## Proposed design

### 1. A single deprecation registry

Add a new file, `src/deprecations.ts`. It is the only source of truth for
deprecations:

```ts
export interface Deprecation {
  id: string;              // stable id, e.g. "wallet-send-server-signing"
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
  path: string;            // Express path, e.g. "/api/v1/wallet/send"
  deprecatedAt: string;    // ISO date: the date the Deprecation header reports
  sunsetAt: string;        // ISO date: the date it must be gone; at least deprecatedAt + 6 months
  replacement: string;     // human-readable or a path
  link: string;            // migration doc, e.g. "/docs/client-signing"
  issue: string;           // tracking issue, e.g. "#254"
}

export const DEPRECATIONS: readonly Deprecation[] = [ /* the 8 rows above */ ];
```

- `deprecated(id)` replaces `deprecated(route, link)`. It looks up the
  entry, which is a startup error if the id is unknown, and emits the
  following headers:
  - `Deprecation: @<deprecatedAt epoch>`
  - `Sunset: <sunsetAt HTTP-date>`
  - `Link: <link>; rel="deprecation", <link>; rel="sunset"`
- `apiKeyAuth` calls `deprecated("api-key-login")` instead of setting
  `X-Deprecated`. `X-Deprecated` is still sent during the window, because
  removing it would itself be a breaking change. It is listed for removal
  together with `apiKeyAuth`.

### 2. Usage metrics for each deprecated route

Add these to `services/metrics.ts`:

- `deprecated_route_requests_total{id}`: incremented on every call.
  Cardinality is bounded by the registry size.
- `deprecated_route_last_called_seconds{id}`: a gauge holding the Unix time
  of the most recent call.

The log line becomes **sampled**. The first call per `id` per process per
hour is logged at `warn` with `requestId` and `User-Agent`. That is enough
to identify which client is still calling, without logging every request.

### 3. Automated removal checklist

Add `npm run deprecations:check`, implemented in
`scripts/deprecations-check.ts`. It runs in CI and prints a table with each
entry's id, sunset date, days left and status. It fails or warns according
to these rules:

| Condition | CI result |
|---|---|
| `sunsetAt` is less than 6 months after `deprecatedAt` | **fail** (breaks [`versioning.md`](../versioning.md)) |
| `sunsetAt` is within 30 days | **warn**, and print the removal checklist below |
| `sunsetAt` has passed and the route is still mounted | **fail** |
| A registry entry has no matching `deprecated: true` operation in `openapi.yaml` | **fail** |
| An operation is `deprecated: true` in `openapi.yaml` with no registry entry | **fail** |
| The `x-sunset` value in OpenAPI differs from `sunsetAt` | **fail** |

The "still mounted" check walks `createApp()`'s router stack. It needs no
network access and no database.

Failing after the sunset date *is* the automation. CI goes red on `main`
until someone either removes the route or deliberately moves `sunsetAt` in
a reviewed PR. Moving the date must update `versioning.md`'s window
reasoning in the PR description.

**The removal checklist printed for each expiring route:**

1. Check that `deprecated_route_requests_total{id}` has been flat for 14 days
   in production.
2. Delete the handler, its validation schema, and its call to
   `deprecated(id)`.
3. Delete the registry entry.
4. Delete the operation from `openapi.yaml`, and the method from
   `packages/sdk`, then bump the SDK's major version if it was public.
5. Add a `410 Gone` stub only if a migration grace period is needed (see
   below). Otherwise the route falls through to `404`.
6. Add a changelog entry that links the tracking issue.

### 4. Behaviour after sunset (optional grace stub)

For 30 days after a route is removed, the registry entry can stay with
`removed: true`. It then serves `410 Gone` with code `ROUTE_SUNSET` in the
shared error envelope, with a body that links `replacement`. This gives old
clients a clear error instead of a confusing `404`. `deprecations:check`
fails once `removed: true` entries are older than 30 days.

### Data model

The registry is static and lives in code. There is no database. Metrics are
kept in each process, and the Prometheus scraper sums them across
instances.

### Failure modes

| Failure | Result |
|---|---|
| A new deprecation is added without a registry entry | `deprecated(id)` throws at startup, and CI fails |
| A sunset date is set too early | CI fails on the 6-month rule |
| A sunset date passes on a quiet week | CI goes red on `main`, which forces a decision |
| A route is removed while clients still call it | Should not happen if checklist step 1 is followed. The `410` stub is the safety net. |
| A client clock or proxy strips the headers | Only informational loss. Enforcement happens on the server. |
| The metrics endpoint is unavailable | The sampled warn logs are the fallback signal |

## Test plan

- [ ] **The sunset headers are present.** For every registry entry, a
      supertest calls the route and asserts `Deprecation`, `Sunset` and both
      `Link` relations with the dates from the registry.
- [ ] `Deprecation` reports `deprecatedAt`, not `sunsetAt` (regression test
      for G2).
- [ ] `apiKeyAuth` emits the standard headers, with `X-Deprecated` still
      present.
- [ ] Non-deprecated routes have none of these headers (negative test).
- [ ] `deprecated_route_requests_total{id}` goes up once per call.
- [ ] Log sampling: 100 calls in an hour produce one log line.
- [ ] `deprecations:check` unit tests use a fake clock and fixture
      registries, with one test per row of the CI rules table.
- [ ] `deprecated("unknown-id")` throws.
- [ ] A `removed: true` entry returns `410 ROUTE_SUNSET`.

## Rollout and docs checklist

- [ ] Fill in the registry with real `deprecatedAt` dates, taken from the
      git history of each `deprecated()` call. Keep `2027-01-01` as the
      sunset, unless that breaks the 6-month rule.
- [ ] Update [`versioning.md`](../versioning.md): "Deprecated endpoints
      **must** return `Deprecation` and `Sunset` headers … see
      `src/deprecations.ts`".
- [ ] In `openapi.yaml`, add `deprecated: true` and `x-sunset` to each
      operation, and add `ROUTE_SUNSET` to `openapi-errors.yaml`.
- [ ] In `packages/sdk`, mark the matching methods with `@deprecated` and
      the sunset date in the JSDoc.
- [ ] Add `deprecations:check` to the CI workflow.
