# #258: Wallet and contract routes: thin handlers over a service layer

**Status:** proposed · **Size:** L · **Touches:** `src/routes/wallet.ts`,
`src/routes/contract.ts`, new `src/services/wallet/`, `src/validation/`,
`src/app.ts` (wiring only)

## Current state

`routes/wallet.ts` is 344 lines and `routes/contract.ts` is 118 lines on
`main`; the issue's 674/457 figures are from an older commit. The logic that
lives in the route layer today:

| In `wallet.ts` | Kind |
|---|---|
| `buildSep7PayUri`, `parseSep7PayUri` + validation warnings | Domain logic (SEP-7) |
| `handleIdempotentRequest`: derives the public key from the secret, looks up and stores the idempotency record | Domain logic / orchestration |
| Inline `INVALID_ASSET` check on `POST /payment-requests` | Business rule, and returns a non-standard envelope |
| The same validator chains copy-pasted (memo ×4 with the same comment, G-address ×7, `path` custom validator ×2) | Validation duplication |

`contract.ts` handlers are already near-thin (they call `GlobeWalletContract`).
The main issues there are input validation (`amount` uses `.isNumeric()`, so
`"1e5"` and `" 1"` pass; amounts must be decimal strings) and the
response-shaping inside handlers (`successful: true` hard-coded).

### Bugs found while reading (fix in this PR; each has a regression test)

1. `parseSep7PayUri` throws a plain `Error` → **500**. It should be a 400 `Sep7Error`.
2. `INVALID_ASSET` uses `{ error: { code, message } }` instead of the shared envelope.
3. **Idempotency race:** `handleIdempotentRequest` checks for the key, executes,
   and only then inserts. Two concurrent requests with the same key both miss
   and both submit. The account lock serialises *submission*, but it does not
   make the second request see the first one's result. See the design below.
4. A malformed secret key makes `Keypair.fromSecret` throw before validation
   has rejected it. The current `isLength(56)` check lets any 56-char string
   through, which then turns into a 500.
5. Unused imports (`param`, `publicKeyMessage`, `logKeypairIssuance` in `wallet.ts`).

## Design

### Layers

```
routes/*.ts         HTTP only: validators → assertValidRequest → service call → res.json
validation/*.ts     reusable validator chains + edge parsing (strings → typed inputs)
services/wallet/*   domain logic, no Express types, injectable deps
services/stellar.ts unchanged (Horizon adapter)
```

Rules:

- Services never import `express`. They take typed input objects and return
  typed results or throw `AppError` subclasses.
- Handlers have no `if` on domain conditions. Each one is validate → call →
  respond. Target: **every handler ≤ 15 lines, every route file well under the
  50-line-per-handler acceptance bar.**
- Dependencies are passed into constructors (`StellarService`, an idempotency
  store, the clock), matching the existing `createWalletRouter(stellar)` style,
  so unit tests use fakes instead of jest module mocks.

### New modules

```ts
// services/wallet/sep7.ts
export function buildPayUri(fields: Sep7PayFields): string;
export function parsePayUri(uri: string): { fields: Sep7PayFields; warnings: string[] }; // throws Sep7Error

// services/wallet/idempotency.ts
export interface IdempotencyStore {
  claim(source: string, key: string): Promise<"claimed" | { hash: string; successful: boolean } | "in_progress">;
  complete(source: string, key: string, r: { hash: string; successful: boolean }): Promise<void>;
  release(source: string, key: string): Promise<void>; // on failure before submission
}
export async function runIdempotent<T extends TxResult>(store, source, key | undefined, exec: () => Promise<T>): Promise<T>;

// services/wallet/paymentService.ts
export class PaymentService {
  constructor(deps: { stellar: StellarService; idempotency: IdempotencyStore });
  send(input: SendInput): Promise<TxResult>;
  feeBump(input: FeeBumpInput): Promise<TxResult>;
  pathPaymentStrictSend(input): Promise<TxResult>;
  pathPaymentStrictReceive(input): Promise<TxResult>;
  findPaths(kind: "strict-send" | "strict-receive", input): Promise<Path[]>;
  buildPartial(input): Promise<PartialTx>;
}

// validation/walletValidators.ts
export const gAddress = (field: string, loc?: "body" | "param") => ...;
export const secretKey = (field: string) => ...;     // StrKey.isValidEd25519SecretSeed, checksum-validated
export const amount = (field: string, opts?) => ...; // string, /^\d+(\.\d{1,7})?$/, > 0, ≤ i64 max stroops
export const memoText = (field = "memo") => ...;     // single home for the #103 byte-length comment
export const pathAssets = (field = "path") => ...;
```

`contract.ts` keeps calling `GlobeWalletContract` directly. It is already the
service. It only gains the shared validators and a `toSpendResponse()` mapper.

### Idempotency fix

`claim` performs `INSERT … (status='pending') ON CONFLICT DO NOTHING RETURNING`:

- inserted → `"claimed"`: execute, then `complete` (`status='done'`, store the hash).
- conflict and done → return the stored result. This is identical to today's replay behaviour.
- conflict and pending → `409 IDEMPOTENCY_IN_PROGRESS`, `retryable: true`.
- execution throws **before** a hash exists → `release` (delete the pending row) so the client can retry.
- execution throws **after** submission with an unknown outcome → keep the row pending with the hash, and let a later replay look it up (works with #256's `SUBMISSION_OUTCOME_UNKNOWN`).

Schema change (additive, in `db.ts`): `status text not null default 'done'`,
`result_hash` nullable, `created_at`. Existing rows read as `done`. Pending
rows older than 10 minutes are treated as abandoned and may be re-claimed.

The idempotency scope stays as it is today, `(source_public_key, key)`. The
key is still derived from the secret in the body, but derivation moves into
the service after validation.

## API compatibility

No path, method, request field or success response shape changes. Observable
differences are all bug fixes and are listed in the PR:

| Request | Before | After |
|---|---|---|
| `POST /payment-requests/parse` with a bad prefix | 500 `INTERNAL_ERROR` | 400 `SEP7_INVALID_URI` |
| `POST /payment-requests` with a non-native asset and no issuer | 400 `{error:{code,message}}` | 400 standard envelope, `code: INVALID_ASSET` |
| Bad-checksum secret key | 500 | 400 `VALIDATION_ERROR` (value redacted) |
| `POST /contract/wallet/spend` with `amount: "1e5"` | accepted | 400 `VALIDATION_ERROR` |
| Concurrent duplicate idempotency key | double submit | 409 `IDEMPOTENCY_IN_PROGRESS` |

Update the OpenAPI fragment and `packages/sdk` for the new codes only.

## Threat model

| Threat | Mitigation |
|---|---|
| Secret keys in request bodies: logged, echoed in validation errors, kept in memory longer | Secret parsing happens in one validator. The value is redacted from validation `details` and from logs (with #256). Services receive a `Keypair`, not the string, wherever the Stellar SDK allows. |
| Double submission under concurrency or client retries | The claim-before-execute idempotency above. |
| Validation drift between duplicated chains (one copy fixed, others not, which is how #103 happened) | One validator per concept, imported everywhere. |
| Refactor changes behaviour silently | Route tests run unchanged before and after. A characterization test suite is written **first**, against current behaviour. |

## Data model

- `idempotency_keys`: add `status`, `created_at`; make `result_hash` nullable. Additive and backward compatible.
- No other persistence. Service inputs are typed objects whose amounts are strings (never `number`).

## Failure modes

- **DB down during `claim`**: fail the request with 503 `SERVICE_UNAVAILABLE`
  *before* submitting. Never submit without an idempotency record when the
  client sent a key.
- **DB down during `complete`** after a successful submit: return success to
  the client (the funds moved), log at error level with the hash, and leave
  the row pending. A replay finds it pending, sees the hash, and reconciles.
- **Process crash between submit and complete**: same as above. The pending
  row is reclaimable after 10 minutes. Document that clients should reuse the
  same key *and* treat `IDEMPOTENCY_IN_PROGRESS` as "wait and retry".

## Test plan

1. **Before any refactor:** add characterization tests (supertest) covering
   every route in `wallet.ts` and `contract.ts` against a fake
   `StellarService` / `GlobeWalletContract`: happy path, each validation
   failure, and the upstream error passthrough. Commit them first, then refactor
   until they pass unchanged, except for the bug-fix rows listed above, each of
   which gets its own separate commit with the assertion change.
2. Unit tests per service: `sep7` (round-trip, every warning), `runIdempotent`
   (claimed / replay / in-progress / release-on-throw / pending-with-hash),
   `PaymentService` (delegation and key derivation), each validator.
3. Concurrency: two parallel `runIdempotent` calls with the same key → exactly one `exec`.
4. Lint rule or test that fails when any handler in `src/routes/` exceeds 50 lines (a simple AST count via the TS compiler API in a jest test).

## PR plan

1. Characterization tests (no code change).
2. Extract validators (`validation/walletValidators.ts`).
3. Extract SEP-7 and fix bugs 1–2.
4. Extract `PaymentService` + idempotency with the claim fix, plus the migration.
5. Contract route tidy-up and the amount validation.

## Out of scope

- Moving to client-side signing (no secrets over the wire). This is the right
  long-term direction and the contract admin routes already return unsigned
  XDR, but it is an API change and needs its own issue.
- `routes/account.ts` (204 lines). Apply the same pattern in a follow-up.
