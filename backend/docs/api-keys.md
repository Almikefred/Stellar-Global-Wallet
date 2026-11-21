# API Keys — Hashed Storage, Scopes and Rotation

Tracking issue: #251. Status: **proposed** — this describes the target
behaviour; the "Current state" section describes what ships today.

## Current state

- One shared secret, `API_KEY` in [`src/config.ts`](../src/config.ts), compared
  in constant time by [`src/middleware/apiKeyAuth.ts`](../src/middleware/apiKeyAuth.ts).
- The only route that accepts it is `POST /api/v1/auth/login`
  ([`src/routes/auth.ts`](../src/routes/auth.ts)), which exchanges it for a JWT
  with the fixed subject `api-key-user`. Every caller shares that identity.
- No scopes: whoever holds the key can call every JWT-protected route.
- Rotation means changing `API_KEY` and restarting, which invalidates every
  client at the same moment.
- `keypair_audit_log.api_key_hash` already stores a SHA-256 of the key
  ([`src/services/auditLog.ts`](../src/services/auditLog.ts)), but there is no
  key table.

## Key format

```
sgw_<env>_<prefix>_<secret>
sgw_live_7Fq2LmZ9_Xk3...(43 chars)
```

| Part | Purpose |
|---|---|
| `sgw_` | Lets secret scanners (GitHub, gitleaks) recognise leaked keys. |
| `<env>` | `test` or `live`; a `live` key is rejected by a testnet deployment and vice versa. |
| `<prefix>` | 8 random base62 chars, stored in plaintext, unique. Used for lookup and shown in logs/UI. |
| `<secret>` | 32 random bytes, base64url. Never stored. |

The full key is shown **once**, in the create/rotate response.

## Storage

```sql
CREATE TABLE api_keys (
  id            BIGSERIAL PRIMARY KEY,
  prefix        VARCHAR(16) NOT NULL UNIQUE,
  secret_hash   VARCHAR(64) NOT NULL,          -- HMAC-SHA256(API_KEY_PEPPER, secret), hex
  name          VARCHAR(100) NOT NULL,         -- human label, e.g. "mobile-app-prod"
  scopes        TEXT[] NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,                   -- NULL = no expiry
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  replaced_by   BIGINT REFERENCES api_keys(id) -- set during rotation
);
```

- HMAC with a server-side pepper (`API_KEY_PEPPER`, new required env var)
  rather than bare SHA-256, so a leaked database alone can't be used to verify
  guesses. A slow hash (bcrypt/argon2) is unnecessary: the secret is 256 bits
  of randomness, not a password.
- Verification: parse the key → look up by `prefix` → recompute the HMAC →
  `timingSafeEqual` against `secret_hash` → check `revoked_at`/`expires_at`.
  An unknown prefix still runs one HMAC so timing doesn't reveal which
  prefixes exist.
- `last_used_at` is updated at most once per minute per key to avoid a write
  on every request.

## Scopes

Scopes are copied into the JWT issued by `/auth/login` (`scope` claim, space
separated) and enforced per route by a `requireScope(...)` middleware placed
after `jwtAuth`. The JWT `sub` becomes `apikey:<prefix>` instead of
`api-key-user`, so audit logs identify the caller.

| Scope | Grants |
|---|---|
| `accounts:read` | `GET /account/*`, balances, activity feed, preferences read |
| `accounts:write` | Preferences write, device registration |
| `tx:build` | Unsigned/partial XDR builders, including setOptions |
| `tx:submit` | Submitting and fee-bumping transactions |
| `multisig` | Pending-transaction create/sign/list |
| `keys:admin` | Create, list, rotate and revoke API keys |

A request whose token lacks the scope gets:

```json
{ "error": "Missing required scope: tx:submit", "code": "API_KEY_SCOPE_MISSING" }
```

with status `403` (the caller is authenticated, just not allowed).
Unknown scopes are rejected when a key is created.

## Rotation with overlap

`POST /api/v1/keys/:prefix/rotate` (scope `keys:admin`), body
`{ "overlapSeconds": 86400 }` (default 24 h, max 30 days):

1. Creates a new key with the same name and scopes and returns it once.
2. Sets the old key's `expires_at = NOW() + overlapSeconds` and
   `replaced_by = <new id>`.
3. During the overlap both keys work. Responses authenticated with the old
   key carry `X-Api-Key-Expires: <ISO timestamp>` so clients can alert.
4. After the overlap the old key fails with `API_KEY_EXPIRED`.

`POST /api/v1/keys/:prefix/revoke` sets `revoked_at` immediately, with no
overlap — use it for leaked keys. Rotating an already-rotated key is refused
(`API_KEY_ALREADY_ROTATED`) so you can't build long chains of live keys.

## Error codes

| Code | Status | When |
|---|---|---|
| `API_KEY_UNAUTHORIZED` | 401 | Missing, malformed, unknown or wrong key (one code for all, so callers can't probe). |
| `API_KEY_EXPIRED` | 401 | Past `expires_at`, including after a rotation overlap. |
| `API_KEY_REVOKED` | 401 | Revoked key. |
| `API_KEY_SCOPE_MISSING` | 403 | Valid token without the route's scope. |
| `API_KEY_ALREADY_ROTATED` | 409 | Rotate called on a key that already has `replaced_by`. |

## Migration from `API_KEY`

1. Ship the table and middleware. On boot, if `api_keys` is empty and
   `API_KEY` is set, insert a `legacy` row for it with **all** scopes.
2. Keep accepting the raw `API_KEY` value for one release, logging a
   deprecation warning on each use (the existing `X-Deprecated` header stays).
3. Issue scoped keys to each client, then revoke `legacy` and remove
   `API_KEY` from config.

## Test plan

- Stored row never contains the plaintext secret; only `prefix` + hash.
- Correct key → 200; wrong secret with valid prefix → 401; unknown prefix → 401
  with the same code.
- Token from an `accounts:read` key calling a `tx:submit` route → 403
  `API_KEY_SCOPE_MISSING`; same call with `tx:submit` → passes.
- Rotation: old and new key both work inside the overlap; old key fails after
  it (use fake timers); `X-Api-Key-Expires` present on old-key responses.
- Revoked key fails immediately even inside an overlap window.
- `live` key rejected on a testnet config.
