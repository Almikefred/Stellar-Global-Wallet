# Preferences API — Conflict-safe Updates and Encryption at Rest

Tracking issue: #250. Status: **proposed**.

## Current state

- `GET` / `PUT /api/v1/account/:publicKey/preferences` live in
  [`src/routes/account.ts`](../src/routes/account.ts) (not a separate
  `preferences.ts`).
- Allowed fields (strict zod schema): `currency`, `language`, `hiddenAssets`,
  `notifications.{email,push,payments}`.
- `PUT` replaces the whole document (`insert … onConflict("account").merge`),
  so it's last-write-wins: if phone and laptop both edit, whichever saves
  second silently erases the other's change — including fields it never
  touched.
- Stored as plaintext JSONB.

## Versioning

Add `version INTEGER NOT NULL DEFAULT 0` to `preferences`.

- `GET` returns `ETag: "<version>"` and `version` in the body.
- Writes must send `If-Match: "<version>"`. The update is a compare-and-set:

  ```sql
  UPDATE preferences SET data = $1, version = version + 1, updated_at = NOW()
  WHERE account = $2 AND version = $3
  RETURNING version;
  ```

  Zero rows updated means someone else wrote first → `412`
  `PREFERENCES_VERSION_CONFLICT`, with the current document and version in
  `details`.
- No `If-Match` → `428` `PREFERENCES_PRECONDITION_REQUIRED`. Old clients that
  don't send it keep working for one release behind a warning header, then
  are refused.
- First write for an account uses `If-Match: "0"` (or `If-None-Match: *`).

## Field-level merge: `PATCH`

Add `PATCH /api/v1/account/:publicKey/preferences` taking a JSON Merge Patch
(RFC 7396): only fields present are changed, `null` deletes a field. Clients
should use `PATCH` for edits; `PUT` stays for "replace everything".

Because a `PATCH` names only the fields it changes, a version mismatch doesn't
have to fail. On mismatch the server:

1. Re-reads the current document.
2. If the patch touches no field that changed between the client's version and
   now, applies it on top of the current document and returns `200` with the
   new version.
3. Otherwise returns `412` with the conflicting field paths in `details`.

To know which fields changed since a version, keep a small
`preferences_history (account, version, changed_paths TEXT[])` table, trimmed
to the last 50 versions per account. If the client's version is older than the
retained history, treat every field as changed (step 3).

`hiddenAssets` is merged as a set, not replaced: `PATCH` accepts
`{ "hiddenAssets": { "add": [...], "remove": [...] } }` so hiding an asset on
one device and another asset on a second device doesn't conflict.

## Encrypting sensitive prefs

Of today's fields none are secrets, but notification settings and the hidden
asset list reveal holdings and habits, and future fields (e.g. contact labels)
will be sensitive. Rule: fields listed in `SENSITIVE_PREFERENCE_FIELDS`
(initially `hiddenAssets`, `notifications`) are stored encrypted.

- AES-256-GCM, fresh 96-bit IV per write, account address as associated data
  (so a ciphertext copied to another account's row fails to decrypt).
- Key from new env var `PREFERENCES_ENCRYPTION_KEY` (32 bytes, base64), plus
  `PREFERENCES_ENCRYPTION_KEY_ID`. Each ciphertext stores its key id, so the
  key can be rotated: new writes use the new key, reads accept old ids until a
  re-encryption job has rewritten every row.
- Stored shape: plaintext fields stay in `data`; sensitive ones move to
  `data_enc JSONB` as `{ kid, iv, ct, tag }`. API responses are unchanged —
  encryption is invisible to clients.
- Merge/conflict logic runs on decrypted values; `preferences_history`
  records only field paths, never values.

## Error codes

| Code | Status | When |
|---|---|---|
| `PREFERENCES_PRECONDITION_REQUIRED` | 428 | Write without `If-Match`. |
| `PREFERENCES_VERSION_CONFLICT` | 412 | Version mismatch that can't be auto-merged. |
| `VALIDATION_ERROR` | 400 | Payload fails the schema (unchanged). |

## Test plan

- **Concurrent updates resolved without loss**: device A and B both read
  version 3; A patches `currency`, B patches `language`. Both succeed, final
  document has both changes, version 5.
- Both devices patch `currency` from version 3 → second gets 412 listing
  `currency`.
- `hiddenAssets` add on A and add on B from the same version → union kept.
- `PUT` with a stale version → 412; without `If-Match` → 428.
- Raw DB row contains no plaintext `hiddenAssets`/`notifications`; API returns
  them decrypted.
- Ciphertext moved to another account's row fails to decrypt.
- Rows written under an old key id still read after rotating the key.
