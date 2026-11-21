# #256: Error handler: never leak internals; correlation ids; retryable classification

**Status:** proposed · **Size:** L · **Touches:** `src/middleware/errorHandler.ts`,
`src/errors/appError.ts`, `src/services/stellarErrors.ts`,
`src/services/sorobanErrors.ts`, `src/services/stellar.ts`,
`docs/error-examples.md`, `docs/openapi-errors.yaml`, `packages/sdk`

## Problem

The error envelope (`{ code, error, details?, retryable? }`) is already shared
by every route, but what goes *into* it is not controlled.

### Leaks found on `main`

| Where | What leaks |
|---|---|
| `errorHandler.ts` `toAppError`: `new InternalServerError(error.message)` | Any unexpected `Error` returns its raw message with a 500. That includes pg errors (SQL fragments, constraint names), Redis connection strings, Node `ECONNREFUSED 10.x.x.x:6379`, and stack-adjacent text. |
| `errorHandler.ts` `clientErrorStatus` branch | A library 4xx is passed through with `error.message` verbatim and a `code` derived from the library's `type` field, so the code set is unstable and depends on the library. |
| `stellar.ts` `translateSubmissionError` | Non-`BadResponseError` errors (network failures, timeouts, SDK bugs) are returned unchanged and end up in the 500 leak above. |
| `stellarErrors.ts` `NonRetryableHorizonError` | The message embeds the source public key and Horizon's raw message. The key is the caller's own, so this is low risk, but it is still unnecessary. |
| `sorobanErrors.ts` `SorobanSimulationError` | `details.raw` is the raw RPC simulation error string, which can contain host diagnostic events. |
| `routes/wallet.ts` `parseSep7PayUri` | Throws a plain `Error("URI must start with web+stellar:pay?")`, which comes back as a **500** instead of a 400 `Sep7Error`. |
| `routes/wallet.ts` `POST /payment-requests` | Writes `{ error: { code, message } }` directly, a **different envelope** from everything else. |
| `errorHandler.ts` `console.error(err)` | Logs the whole error object with no request context, so a log line cannot be tied back to a request. |

### Retryable is inconsistent

`retryable` is only set on some classes, and `docs/error-examples.md`
documents that its absence means "not evaluated". Clients therefore have to
special-case status codes. In particular:

- Every `BadResponseError` other than `tx_bad_seq` is classified as
  `HORIZON_REJECTED` / 400 / non-retryable. That includes Horizon 5xx, 504
  timeouts and 429 rate limits, which *are* retryable.
- A Horizon 504 on submit means **"outcome unknown"**, not "failed". Telling
  the client "not retryable" is wrong, and telling it "retry blindly" risks a
  double spend unless the retry uses the same signed envelope or idempotency
  key.

## Goals

1. No unknown error ever puts its message, stack, or upstream payload in a response.
2. Every response carries a correlation id, and so does every log line about it.
3. Every error in the envelope has an explicit `retryable: boolean`.
4. Every upstream failure (Horizon, Soroban RPC, Postgres, Redis, outbound HTTP) maps to a stable code.
5. The envelope stays backward compatible: fields are only added.

## Design

### Correlation id

- New middleware `requestId` at the top of `createApp`. It accepts an incoming
  `X-Request-Id` only if it matches `^[A-Za-z0-9._-]{8,128}$`; otherwise it
  generates `crypto.randomUUID()`. It stores the id on `req.id` and echoes it
  as the `X-Request-Id` response header.
- The error envelope gains `requestId`. morgan's format gains `:req[id]`, so
  access logs and error logs can be joined.

### Envelope

```json
{
  "code": "INTERNAL_ERROR",
  "error": "An unexpected error occurred. Quote the request id when contacting support.",
  "retryable": false,
  "requestId": "6f1c0e2a-…"
}
```

`retryable` becomes always present. This changes the documented meaning
("absent = not evaluated"), so `error-examples.md` and the SDK type change in
the same PR. Old clients that ignore the field are unaffected.

### Public vs internal message

`AppError` gains an `expose: boolean` flag (default `true` for 4xx, `false`
for 5xx) and an optional `cause`. The handler:

- `expose === true`: sends `error.message`.
- `expose === false`: sends the generic text above for the code. It logs the
  real message, the `cause` chain and the stack at `error` level, together with
  `requestId`, method, route pattern (`req.route?.path`, not the raw URL) and
  status.

Unknown errors that are not `AppError` always become `INTERNAL_ERROR` with
`expose: false`. Library 4xx pass-through is limited to an **allowlist** of
known body-parser types (`entity.parse.failed` → `MALFORMED_JSON`,
`entity.too.large` → `PAYLOAD_TOO_LARGE`, `encoding.unsupported` →
`UNSUPPORTED_ENCODING`), each with a fixed message. Anything else becomes a
generic `BAD_REQUEST`.

### Upstream classification

A single `classifyUpstreamError(err, source)` lives in
`src/errors/upstream.ts`. The Horizon, Soroban and db/redis call sites call it
instead of each building errors their own way.

| Source / condition | Code | Status | Retryable |
|---|---|---|---|
| Horizon `tx_bad_seq` | `SEQUENCE_CONFLICT` | 409 | true |
| Horizon 400 `tx_failed` / op codes (`op_underfunded`, `op_no_trust`, …) | `HORIZON_REJECTED` (+ `details.resultCodes`) | 400 | false |
| Horizon `tx_insufficient_fee` | `FEE_TOO_LOW` | 400 | true (with a higher fee) |
| Horizon 404 account | `ACCOUNT_NOT_FOUND` | 404 | false |
| Horizon 429 | `UPSTREAM_RATE_LIMITED` | 503 | true (+ `Retry-After` if Horizon sent one) |
| Horizon 5xx / network / timeout on **read** | `UPSTREAM_UNAVAILABLE` | 503 | true |
| Horizon 504 / timeout on **submit** | `SUBMISSION_OUTCOME_UNKNOWN` (+ `details.hash`) | 504 | true, *same envelope only*; see below |
| Soroban simulation error | `SOROBAN_SIMULATION_FAILED` (+ parsed contract error code, no raw string) | 422 | false |
| Soroban tx failed | `SOROBAN_TX_FAILED` (+ `hash`) | 502 | false |
| Soroban RPC 5xx / network | `UPSTREAM_UNAVAILABLE` | 503 | true |
| Lock timeout | `LOCK_TIMEOUT` | 503 | true |
| Postgres / Redis unavailable | `SERVICE_UNAVAILABLE` | 503 | true |
| Anything else | `INTERNAL_ERROR` | 500 | false |

For `SUBMISSION_OUTCOME_UNKNOWN`, the message tells the client to look up
`details.hash` before resubmitting, or to resubmit the identical signed XDR.
Stellar rejects a duplicate of an already-applied envelope with `tx_bad_seq`,
so resubmitting the same XDR is safe. Building a new transaction is not.

The full code list lives in `src/errors/codes.ts` as a `const` map, so the
SDK can import the union type and the OpenAPI enum can be generated or checked
against it.

## Threat model

| Threat | Mitigation |
|---|---|
| Internal disclosure (SQL, hostnames, keys, stack) to an attacker probing with malformed input | `expose: false` for every non-allowlisted error, plus a test that injects errors carrying sentinel strings and asserts they never appear in the body. |
| Secret keys in errors. Several routes take `sourceSecretKey` / `feeSecretKey` / `userSecretKey` in the body, and express-validator's `details[].value` echoes the input back. | `ValidationError` redacts `value` for any field matching `/secret/i`. The log redactor does the same for `req.body`. Test: an invalid `sourceSecretKey` never appears in the response or the logs. |
| Log injection through a client-supplied `X-Request-Id` | Strict charset and length regex; anything else is replaced. |
| Retry storms caused by wrong `retryable: true` | Only transient classes are retryable, and 503s carry `Retry-After`. |
| Double spend caused by retrying an "unknown outcome" submit with a fresh transaction | A distinct code and message, and the idempotency key path (`handleIdempotentRequest`) documented as the safe retry route. |

## Data model

No persistence changes. Additions to types:

- `AppError { code, status, retryable: boolean, expose: boolean, details?, cause? }`
- Envelope `{ code, error, retryable, requestId, details?, hash? }`
- `ErrorCode` union exported from `packages/sdk`.

## Failure modes

- **The handler itself throws** (e.g. a `details` value that cannot be
  serialised): wrap the serialisation in try/catch and fall back to a minimal
  `{ code: "INTERNAL_ERROR", ... }` built from literals.
- **Headers already sent** (streaming response): delegate to Express's default
  handler (`if (res.headersSent) return next(err)`). This is missing today.
- **Rate limiter responses** (`express-rate-limit` `message:` options in
  `auth.ts` and `app.ts`) bypass the handler. Move them to a `handler` that
  calls `next(new RateLimitedError())`, so they get the envelope and a
  `requestId`.

## Test plan

- Unit: `classifyUpstreamError` table-driven over each row above, using
  constructed `BadResponseError`s, `NetworkError`s and pg/redis errors.
- Unit: `toAppError` with a plain `Error("SECRET_SENTINEL")`, a string, `null`,
  an object with a `status: 418`, and a body-parser error of each allowlisted
  type.
- Integration (supertest): a route stub that throws each kind. Assert status,
  `code`, `retryable` is a boolean, `requestId` matches the header, and the
  body contains no sentinel.
- Regression: `POST /payment-requests/parse` with a bad prefix returns 400
  `SEP7_INVALID_URI`; `POST /payment-requests` with a missing issuer returns
  the standard envelope.
- Existing `errorResponses.test.ts` and `bodyLimit.test.ts` keep passing, with
  only additive assertion changes.

## Docs and SDK

- `docs/error-examples.md`: new `requestId` and always-present `retryable`
  fields, the code table, and retry guidance for `SUBMISSION_OUTCOME_UNKNOWN`.
- `docs/openapi-errors.yaml`: schema gains `requestId` and the `code` enum;
  add a 504 example.
- `packages/sdk`: an `ApiError` type, the `ErrorCode` union, and an
  `isRetryable()` helper.

## Out of scope

- Structured logging library migration (pino etc.); this note only adds context fields.
- Localised error messages (the `locale` middleware exists; translating messages is a separate issue).
