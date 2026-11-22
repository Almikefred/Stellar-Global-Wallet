/**
 * Asymmetric JWT key management (#199).
 *
 * Access tokens are now signed with RS256 (RSA-SHA256) using a private key
 * that never leaves this service. External services verify tokens using the
 * public key published at GET /.well-known/jwks.json — they never need the
 * shared secret.
 *
 * Key rotation:
 *   - Up to two keypairs are live simultaneously: `current` (signs new tokens)
 *     and `previous` (verifies tokens issued before the last rotation).
 *   - Keys are persisted to the `jwt_signing_keys` table so rotations survive
 *     restarts and work across multiple instances.
 *   - `rotatePrimaryKey()` demotes `current` → `previous` and generates a new
 *     `current`, then deletes any older retired keys.
 *   - On startup `initKeys()` loads existing keys or generates a fresh pair.
 *
 * JWKS:
 *   The `getJwks()` function returns a RFC 7517 JSON Web Key Set containing
 *   the public halves of all currently-valid keys. Any verifier that caches
 *   the JWKS and re-fetches on unknown `kid` will handle rotation seamlessly.
 */

import { generateKeyPairSync, createPublicKey, KeyObject } from "crypto";
import { randomUUID } from "crypto";
import { pool } from "../db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// In-memory key store (populated from DB at startup)
// ---------------------------------------------------------------------------

let currentKey: SigningKey | null = null;
let previousKey: SigningKey | null = null;

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

export async function ensureJwtKeysTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jwt_signing_keys (
      kid TEXT PRIMARY KEY,
      -- PEM-encoded PKCS#8 private key (RSA 2048).
      private_key_pem TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('current', 'previous')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

function generateRsaKeyPair(): { kid: string; privateKey: KeyObject; publicKey: KeyObject } {
  const kid = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, publicKey };
}

function keyFromPem(pem: string): SigningKey {
  const privKey = (
    require("crypto") as typeof import("crypto")
  ).createPrivateKey(pem);
  const pubKey = createPublicKey(privKey);
  // kid is recovered from the DB row by the caller.
  return { kid: "", privateKey: privKey, publicKey: pubKey, createdAt: new Date() };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistKey(kid: string, privateKey: KeyObject, role: "current" | "previous"): Promise<void> {
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  await pool.query(
    `INSERT INTO jwt_signing_keys (kid, private_key_pem, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (kid) DO UPDATE SET role = EXCLUDED.role`,
    [kid, pem, role]
  );
}

async function loadKeys(): Promise<{ current: SigningKey | null; previous: SigningKey | null }> {
  const { rows } = await pool.query<{
    kid: string;
    private_key_pem: string;
    role: string;
    created_at: Date;
  }>(`SELECT kid, private_key_pem, role, created_at FROM jwt_signing_keys WHERE role IN ('current','previous')`);

  let cur: SigningKey | null = null;
  let prev: SigningKey | null = null;

  for (const row of rows) {
    const k = keyFromPem(row.private_key_pem);
    k.kid = row.kid;
    k.createdAt = row.created_at;
    if (row.role === "current") cur = k;
    else prev = k;
  }

  return { current: cur, previous: prev };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load existing keys from the DB, or generate a fresh pair on first boot.
 * Must be called once at startup before any token is signed or verified.
 */
export async function initKeys(): Promise<void> {
  await ensureJwtKeysTable();
  const { current, previous } = await loadKeys();

  if (current) {
    currentKey = current;
    previousKey = previous;
    return;
  }

  // First boot — generate a keypair.
  const kp = generateRsaKeyPair();
  await persistKey(kp.kid, kp.privateKey, "current");
  currentKey = { ...kp, createdAt: new Date() };
  previousKey = null;
}

/**
 * Rotate the primary signing key: the current key becomes `previous` and a
 * freshly-generated keypair becomes `current`. Tokens issued before rotation
 * remain verifiable until they expire (they carry the old `kid`).
 *
 * Any key previously in the `previous` slot is deleted from the DB.
 */
export async function rotatePrimaryKey(): Promise<void> {
  if (!currentKey) throw new Error("Keys not initialised; call initKeys() first");

  // Retire the old previous key.
  if (previousKey) {
    await pool.query(`DELETE FROM jwt_signing_keys WHERE kid = $1`, [previousKey.kid]);
  }

  // Demote current → previous.
  await pool.query(`UPDATE jwt_signing_keys SET role = 'previous' WHERE kid = $1`, [currentKey.kid]);
  previousKey = currentKey;

  // Generate and persist a new current key.
  const kp = generateRsaKeyPair();
  await persistKey(kp.kid, kp.privateKey, "current");
  currentKey = { ...kp, createdAt: new Date() };
}

/**
 * Lazily ensures an ephemeral in-memory keypair exists when running under
 * automated tests (NODE_ENV=test / Jest) without booting `index.ts:main()`.
 * Production and development always fail closed until `initKeys()` runs.
 */
function ensureTestKeyIfApplicable(): void {
  if (currentKey) return;
  if (process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined) {
    const kp = generateRsaKeyPair();
    currentKey = { ...kp, createdAt: new Date() };
  }
}

/** Returns the active signing key (used by generateAccessToken). */
export function getCurrentKey(): SigningKey {
  ensureTestKeyIfApplicable();
  if (!currentKey) throw new Error("JWT keys not initialised; call initKeys() first");
  return currentKey;
}

/**
 * Finds a key by kid from the in-memory set (current + previous).
 * Returns null for unknown kids (token signed by a retired key).
 */
export function findKeyByKid(kid: string): SigningKey | null {
  ensureTestKeyIfApplicable();
  if (currentKey?.kid === kid) return currentKey;
  if (previousKey?.kid === kid) return previousKey;
  return null;
}

// ---------------------------------------------------------------------------
// JWKS
// ---------------------------------------------------------------------------

interface JwkPublicKey {
  kty: string;
  use: string;
  alg: string;
  kid: string;
  n: string;
  e: string;
}

/**
 * Returns a RFC 7517 JWKS object containing the public halves of all
 * currently-valid signing keys. Safe to publish at /.well-known/jwks.json.
 */
export function getJwks(): { keys: JwkPublicKey[] } {
  ensureTestKeyIfApplicable();
  const keys: JwkPublicKey[] = [];
  for (const key of [currentKey, previousKey]) {
    if (!key) continue;
    const jwk = key.publicKey.export({ format: "jwk" }) as {
      kty?: string;
      n?: string;
      e?: string;
    };
    keys.push({
      kty: jwk.kty ?? "RSA",
      use: "sig",
      alg: "RS256",
      kid: key.kid,
      n: jwk.n ?? "",
      e: jwk.e ?? "",
    });
  }
  return { keys };
}
