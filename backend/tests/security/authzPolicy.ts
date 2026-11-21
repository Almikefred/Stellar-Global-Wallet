import * as StellarSdk from "@stellar/stellar-sdk";
import type { HttpMethod } from "./routeEnumerator";

/**
 * Authorization classification for every route mounted in `src/app.ts` (#233).
 *
 * - `public`: Intentionally unauthenticated (public on-chain reads, health,
 *   config, JWKS, CSP telemetry, SEP-10 challenge/token/refresh/logout).
 * - `login-api-key`: Exchanges the shared `x-api-key` for a JWT pair.
 * - `admin-api-key`: Operator-only endpoint gated by `requireLoginApiKey`.
 * - `authenticated-account-scoped`: Requires a valid Bearer JWT and enforces
 *   `req.user.sub === targetAccount` (for Ed25519 `G...` subjects).
 *   Cross-account access MUST return 403 `ACCOUNT_MISMATCH`.
 * - `authenticated-signer-scoped`: Requires a valid Bearer JWT and verifies
 *   `req.user.sub` is a registered on-chain signer of the target account
 *   (and creator for destructive cancel). Non-signers and `api-key-user`
 *   MUST receive 403 `FORBIDDEN`.
 * - `authenticated-self`: Requires a valid Bearer JWT and scopes all reads
 *   and writes solely to `req.user.sub` (`/api/v1/me/*`). Another user cannot
 *   mutate or read the owner's resources.
 * - `authenticated-unscoped`: Requires a valid Bearer JWT (`anon` and raw
 *   `x-api-key` MUST receive 401), but operates on stateless utilities with
 *   no per-account ownership (e.g. path quote discovery, federation resolve).
 */
export type AuthzClass =
  | "public"
  | "login-api-key"
  | "admin-api-key"
  | "authenticated-account-scoped"
  | "authenticated-signer-scoped"
  | "authenticated-self"
  | "authenticated-unscoped";

export interface RouteRequestSpec {
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface RouteAuthzEntry {
  method: HttpMethod;
  path: string;
  authzClass: AuthzClass;
  rationale: string;
  /**
   * Builds a syntactically valid request targeting `target` (ALICE in matrix
   * tests). When the caller is `otherAccount` (BOB), `target` is STILL ALICE
   * so cross-account rejection is exercised against ALICE's resource.
   */
  buildRequest: (ctx: AuthzTestContext) => RouteRequestSpec;
  /**
   * Optional explicit status/code expectations for `otherAccount` on
   * `authenticated-self` routes where the resource ID / token belongs to ALICE
   * (e.g. 404 DEVICE_NOT_FOUND or 403 ACCOUNT_MISMATCH).
   */
  otherAccountExpectedStatuses?: number[];
}

export interface AuthzTestContext {
  alice: StellarSdk.Keypair;
  bob: StellarSdk.Keypair;
  issuer: StellarSdk.Keypair;
  aliceSignedPaymentXdr: string;
  aliceSignedSorobanXdr: string;
  alicePendingTxId: string;
  aliceDeviceId: string;
  aliceEmailToken: string;
  sampleTxHash: string;
}

const VALID_ISSUER_CODE = "USDC";

/**
 * Exhaustive authorization policy table covering EVERY mounted Express route.
 * CI FAILS if any route mounted in `createApp()` is missing from this table
 * or if any table entry does not correspond to a mounted route (#233).
 */
export const ROUTE_AUTHZ_POLICY: readonly RouteAuthzEntry[] = [
  // ── Root / Infrastructure / Docs (Public) ────────────────────────────────
  {
    method: "GET",
    path: "/health",
    authzClass: "public",
    rationale: "Liveness probe for orchestrators and load balancers; returns static { status: 'ok' }.",
    buildRequest: () => ({ path: "/health" }),
  },
  {
    method: "GET",
    path: "/metrics",
    authzClass: "public",
    rationale: "Prometheus operational metrics counters (no PII or account secrets).",
    buildRequest: () => ({ path: "/metrics" }),
  },
  {
    method: "GET",
    path: "/.well-known/jwks.json",
    authzClass: "public",
    rationale: "RFC 7517 public signing keys for external RS256 JWT verification.",
    buildRequest: () => ({ path: "/.well-known/jwks.json" }),
  },
  {
    method: "GET",
    path: "/auth/csrf",
    authzClass: "public",
    rationale: "Issues double-submit CSRF token cookie for browser sessions.",
    buildRequest: () => ({ path: "/auth/csrf" }),
  },
  {
    method: "POST",
    path: "/csp-report",
    authzClass: "public",
    rationale: "Unauthenticated browser Content-Security-Policy violation telemetry.",
    buildRequest: () => ({ path: "/csp-report", body: { "csp-report": { "violated-directive": "script-src" } } }),
  },
  {
    method: "GET",
    path: "/config",
    authzClass: "public",
    rationale: "Public runtime network/contract discovery alias for /api/v1/config.",
    buildRequest: () => ({ path: "/config" }),
  },
  {
    method: "GET",
    path: "/api/openapi.json",
    authzClass: "public",
    rationale: "Raw OpenAPI spec (enabled outside production unless ENABLE_API_DOCS=true).",
    buildRequest: () => ({ path: "/api/openapi.json" }),
  },

  // ── Health / Config / Flags / Network / Price / Assets / CSP (Public) ────
  {
    method: "GET",
    path: "/api/v1/health/details",
    authzClass: "public",
    rationale: "Readiness diagnostics across Horizon, RPC, Postgres, and Redis.",
    buildRequest: () => ({ path: "/api/v1/health/details" }),
  },
  {
    method: "GET",
    path: "/api/v1/health/metrics",
    authzClass: "public",
    rationale: "Versioned alias for Prometheus operational metrics.",
    buildRequest: () => ({ path: "/api/v1/health/metrics" }),
  },
  {
    method: "POST",
    path: "/api/v1/csp-report",
    authzClass: "public",
    rationale: "Versioned browser CSP violation reporting endpoint.",
    buildRequest: () => ({
      path: "/api/v1/csp-report",
      body: { "csp-report": { "violated-directive": "default-src" } },
    }),
  },
  {
    method: "GET",
    path: "/api/v1/config",
    authzClass: "public",
    rationale: "Public runtime configuration (network passphrase, URLs, contract IDs; no secrets).",
    buildRequest: () => ({ path: "/api/v1/config" }),
  },
  {
    method: "GET",
    path: "/api/v1/flags",
    authzClass: "public",
    rationale: "Public feature flags evaluated before login.",
    buildRequest: () => ({ path: "/api/v1/flags" }),
  },
  {
    method: "GET",
    path: "/api/v1/network/fees",
    authzClass: "public",
    rationale: "Public Horizon fee-stats estimates.",
    buildRequest: () => ({ path: "/api/v1/network/fees" }),
  },
  {
    method: "GET",
    path: "/api/v1/network/info",
    authzClass: "public",
    rationale: "Public network identity and passphrase introspection.",
    buildRequest: () => ({ path: "/api/v1/network/info" }),
  },
  {
    method: "GET",
    path: "/api/v1/price",
    authzClass: "public",
    rationale: "Public batch asset USD spot prices.",
    buildRequest: () => ({ path: "/api/v1/price", query: { assets: "XLM" } }),
  },
  {
    method: "GET",
    path: "/api/v1/price/:asset",
    authzClass: "public",
    rationale: "Public single-asset USD spot price.",
    buildRequest: () => ({ path: "/api/v1/price/XLM" }),
  },
  {
    method: "GET",
    path: "/api/v1/price/:asset/history",
    authzClass: "public",
    rationale: "Public historical price series.",
    buildRequest: () => ({ path: "/api/v1/price/XLM/history", query: { range: "7d" } }),
  },
  {
    method: "GET",
    path: "/api/v1/assets/verified",
    authzClass: "public",
    rationale: "Public reviewed verified-asset allowlist.",
    buildRequest: () => ({ path: "/api/v1/assets/verified" }),
  },
  {
    method: "GET",
    path: "/api/v1/assets/search",
    authzClass: "public",
    rationale: "Public Horizon / stellar.toml asset discovery.",
    buildRequest: () => ({ path: "/api/v1/assets/search", query: { code: VALID_ISSUER_CODE } }),
  },
  {
    method: "GET",
    path: "/api/v1/assets/:code/:issuer",
    authzClass: "public",
    rationale: "Public issuer stellar.toml asset metadata.",
    buildRequest: (ctx) => ({ path: `/api/v1/assets/${VALID_ISSUER_CODE}/${ctx.issuer.publicKey()}` }),
  },

  // ── Dev (Testnet-only, Public) ───────────────────────────────────────────
  {
    method: "POST",
    path: "/api/v1/dev/fund",
    authzClass: "public",
    rationale: "Testnet-only Friendbot funding helper (excluded when STELLAR_NETWORK=mainnet).",
    buildRequest: (ctx) => ({ path: "/api/v1/dev/fund", body: { account: ctx.alice.publicKey() } }),
  },

  // ── Auth & Operator Admin ────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/v1/auth/login",
    authzClass: "login-api-key",
    rationale: "Exchanges shared x-api-key for a legacy Bearer JWT pair.",
    buildRequest: () => ({ path: "/api/v1/auth/login", body: {} }),
  },
  {
    method: "GET",
    path: "/api/v1/auth/challenge",
    authzClass: "public",
    rationale: "SEP-10 challenge generation for unauthenticated wallet sign-in.",
    buildRequest: (ctx) => ({
      path: "/api/v1/auth/challenge",
      query: { account: ctx.alice.publicKey() },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/auth/token",
    authzClass: "public",
    rationale: "SEP-10 signed-challenge verification; cryptographic signature is the credential.",
    buildRequest: () => ({ path: "/api/v1/auth/token", body: { transaction: "AAAA" } }),
  },
  {
    method: "POST",
    path: "/api/v1/auth/refresh",
    authzClass: "public",
    rationale: "Refresh-token rotation; opaque refresh token in body is the credential.",
    buildRequest: () => ({ path: "/api/v1/auth/refresh", body: { refreshToken: "nonexistent" } }),
  },
  {
    method: "POST",
    path: "/api/v1/auth/logout",
    authzClass: "public",
    rationale: "Revokes the presented refresh token.",
    buildRequest: () => ({ path: "/api/v1/auth/logout", body: { refreshToken: "nonexistent" } }),
  },
  {
    method: "POST",
    path: "/api/v1/admin/rotate-jwt-keys",
    authzClass: "admin-api-key",
    rationale: "Operator-only RS256 key rotation gated by requireLoginApiKey.",
    buildRequest: () => ({ path: "/api/v1/admin/rotate-jwt-keys", body: {} }),
  },

  // ── Account Routes (Public ledger reads + Account-scoped CSV export) ─────
  {
    method: "GET",
    path: "/api/v1/account/:publicKey",
    authzClass: "public",
    rationale: "Public on-ledger Stellar account snapshot from Horizon.",
    buildRequest: (ctx) => ({ path: `/api/v1/account/${ctx.alice.publicKey()}` }),
  },
  {
    method: "GET",
    path: "/api/v1/account/:publicKey/balances",
    authzClass: "public",
    rationale: "Public on-ledger balances from Horizon.",
    buildRequest: (ctx) => ({ path: `/api/v1/account/${ctx.alice.publicKey()}/balances` }),
  },
  {
    method: "GET",
    path: "/api/v1/account/:publicKey/signers",
    authzClass: "public",
    rationale: "Public on-ledger multisig signers and thresholds.",
    buildRequest: (ctx) => ({ path: `/api/v1/account/${ctx.alice.publicKey()}/signers` }),
  },
  {
    method: "GET",
    path: "/api/v1/account/:publicKey/reserves",
    authzClass: "public",
    rationale: "Public on-ledger reserve breakdown.",
    buildRequest: (ctx) => ({ path: `/api/v1/account/${ctx.alice.publicKey()}/reserves` }),
  },
  {
    method: "POST",
    path: "/api/v1/account/:publicKey/muxed",
    authzClass: "public",
    rationale: "Deterministic pure M-address derivation from public G-address + uint64 id.",
    buildRequest: (ctx) => ({
      path: `/api/v1/account/${ctx.alice.publicKey()}/muxed`,
      body: { id: "42" },
    }),
  },
  {
    method: "GET",
    path: "/api/v1/account/:publicKey/transactions",
    authzClass: "public",
    rationale: "Public on-ledger transaction history.",
    buildRequest: (ctx) => ({ path: `/api/v1/account/${ctx.alice.publicKey()}/transactions` }),
  },
  {
    method: "GET",
    path: "/api/v1/account/:publicKey/transactions/export.csv",
    authzClass: "authenticated-account-scoped",
    rationale: "Authenticated CSV tax/accounting statement download; strictly scoped to :publicKey (#233 fix).",
    buildRequest: (ctx) => ({
      path: `/api/v1/account/${ctx.alice.publicKey()}/transactions/export.csv`,
    }),
  },
  {
    method: "GET",
    path: "/api/v1/account/:publicKey/payments",
    authzClass: "public",
    rationale: "Public on-ledger payment history with spam heuristics.",
    buildRequest: (ctx) => ({ path: `/api/v1/account/${ctx.alice.publicKey()}/payments` }),
  },
  {
    method: "GET",
    path: "/api/v1/account/:publicKey/activity",
    authzClass: "public",
    rationale: "Public unified Horizon + Soroban contract activity feed.",
    buildRequest: (ctx) => ({ path: `/api/v1/account/${ctx.alice.publicKey()}/activity` }),
  },

  // ── Transactions Routes ──────────────────────────────────────────────────
  {
    method: "GET",
    path: "/api/v1/transactions/:hash",
    authzClass: "public",
    rationale: "Public on-ledger transaction detail lookup by hash.",
    buildRequest: (ctx) => ({ path: `/api/v1/transactions/${ctx.sampleTxHash}` }),
  },
  {
    method: "GET",
    path: "/api/v1/transactions/status/:hash",
    authzClass: "public",
    rationale: "Public transaction status lookup by opaque 64-hex hash.",
    buildRequest: (ctx) => ({ path: `/api/v1/transactions/status/${ctx.sampleTxHash}` }),
  },
  {
    method: "GET",
    path: "/api/v1/transactions/account/:accountId/statuses",
    authzClass: "authenticated-account-scoped",
    rationale: "Per-account submission status feed; strictly scoped to :accountId (#233 fix).",
    buildRequest: (ctx) => ({
      path: `/api/v1/transactions/account/${ctx.alice.publicKey()}/statuses`,
    }),
  },

  // ── Resolve (Authenticated, Unscoped utility) ────────────────────────────
  {
    method: "GET",
    path: "/api/v1/resolve",
    authzClass: "authenticated-unscoped",
    rationale: "Authenticated address/federation lookup; no per-account resource ownership.",
    buildRequest: (ctx) => ({
      path: "/api/v1/resolve",
      query: { q: ctx.alice.publicKey() },
    }),
  },

  // ── Self-Scoped User Resource Routes (/api/v1/me/*) ──────────────────────
  {
    method: "GET",
    path: "/api/v1/me/devices",
    authzClass: "authenticated-self",
    rationale: "Lists push devices strictly for req.user.sub.",
    buildRequest: () => ({ path: "/api/v1/me/devices" }),
  },
  {
    method: "POST",
    path: "/api/v1/me/devices",
    authzClass: "authenticated-self",
    rationale: "Registers push device strictly for req.user.sub.",
    buildRequest: () => ({
      path: "/api/v1/me/devices",
      body: { platform: "expo", token: "ExponentPushToken[test-device-123]" },
    }),
  },
  {
    method: "DELETE",
    path: "/api/v1/me/devices/:id",
    authzClass: "authenticated-self",
    rationale: "Deletes push device only when owned by req.user.sub (other account receives 404).",
    buildRequest: (ctx) => ({ path: `/api/v1/me/devices/${ctx.aliceDeviceId}` }),
    otherAccountExpectedStatuses: [404],
  },
  {
    method: "GET",
    path: "/api/v1/me/email",
    authzClass: "authenticated-self",
    rationale: "Reads verified email strictly for req.user.sub.",
    buildRequest: () => ({ path: "/api/v1/me/email" }),
  },
  {
    method: "POST",
    path: "/api/v1/me/email",
    authzClass: "authenticated-self",
    rationale: "Initiates email verification strictly for req.user.sub.",
    buildRequest: () => ({
      path: "/api/v1/me/email",
      body: { email: "alice@example.com" },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/me/email/verify",
    authzClass: "authenticated-self",
    rationale: "Verifies email token only when token's account matches req.user.sub (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/me/email/verify",
      body: { token: ctx.aliceEmailToken },
    }),
    otherAccountExpectedStatuses: [403],
  },
  {
    method: "GET",
    path: "/api/v1/me/preferences",
    authzClass: "authenticated-self",
    rationale: "Reads UI/notification preferences strictly for req.user.sub.",
    buildRequest: () => ({ path: "/api/v1/me/preferences" }),
  },
  {
    method: "PUT",
    path: "/api/v1/me/preferences",
    authzClass: "authenticated-self",
    rationale: "Merges UI/notification preferences strictly for req.user.sub.",
    buildRequest: () => ({
      path: "/api/v1/me/preferences",
      body: { currency: "USD" },
    }),
  },

  // ── Pending Multisig Transactions (Signer-scoped) ────────────────────────
  {
    method: "POST",
    path: "/api/v1/pending-txs",
    authzClass: "authenticated-signer-scoped",
    rationale: "Only on-chain signers of the transaction source account may create a pending tx.",
    buildRequest: (ctx) => ({
      path: "/api/v1/pending-txs",
      body: { xdr: ctx.aliceSignedPaymentXdr },
    }),
  },
  {
    method: "GET",
    path: "/api/v1/pending-txs",
    authzClass: "authenticated-signer-scoped",
    rationale: "Only on-chain signers of `account` may list its pending multisig txs.",
    buildRequest: (ctx) => ({
      path: "/api/v1/pending-txs",
      query: { account: ctx.alice.publicKey() },
    }),
  },
  {
    method: "GET",
    path: "/api/v1/pending-txs/:id",
    authzClass: "authenticated-signer-scoped",
    rationale: "Only on-chain signers of the pending tx's account may inspect it.",
    buildRequest: (ctx) => ({ path: `/api/v1/pending-txs/${ctx.alicePendingTxId}` }),
  },
  {
    method: "POST",
    path: "/api/v1/pending-txs/:id/signatures",
    authzClass: "authenticated-signer-scoped",
    rationale: "Only on-chain signers of the pending tx's account may attach signatures.",
    buildRequest: (ctx) => ({
      path: `/api/v1/pending-txs/${ctx.alicePendingTxId}/signatures`,
      body: { xdr: ctx.aliceSignedPaymentXdr },
    }),
  },
  {
    method: "DELETE",
    path: "/api/v1/pending-txs/:id",
    authzClass: "authenticated-signer-scoped",
    rationale: "Only an on-chain signer who created the pending tx may cancel it.",
    buildRequest: (ctx) => ({ path: `/api/v1/pending-txs/${ctx.alicePendingTxId}` }),
  },

  // ── Wallet Routes (Client-signing + Account-scoped + Utilities) ──────────
  {
    method: "POST",
    path: "/api/v1/wallet/send/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned payment XDR; scoped to sourcePublicKey.",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/send/build",
      body: {
        sourcePublicKey: ctx.alice.publicKey(),
        destinationPublicKey: ctx.bob.publicKey(),
        amount: "1",
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/path-payment-strict-send/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned strict-send path payment XDR; scoped to sourcePublicKey.",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/path-payment-strict-send/build",
      body: {
        sourcePublicKey: ctx.alice.publicKey(),
        destinationPublicKey: ctx.bob.publicKey(),
        sendAmount: "10",
        destAsset: "XLM",
        quotedDestAmount: "10",
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/path-payment-strict-receive/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned strict-receive path payment XDR; scoped to sourcePublicKey.",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/path-payment-strict-receive/build",
      body: {
        sourcePublicKey: ctx.alice.publicKey(),
        destinationPublicKey: ctx.bob.publicKey(),
        destAmount: "10",
        destAsset: "XLM",
        quotedSendAmount: "10",
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/submit",
    authzClass: "authenticated-account-scoped",
    rationale: "Submits client-signed envelope; scoped to envelope inner source / fee source (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/submit",
      body: { signedXdr: ctx.aliceSignedPaymentXdr },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/trustline/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned changeTrust XDR; scoped to body.account.",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/trustline/build",
      body: {
        account: ctx.alice.publicKey(),
        asset: { code: VALID_ISSUER_CODE, issuer: ctx.issuer.publicKey() },
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/payment-requests",
    authzClass: "authenticated-unscoped",
    rationale: "Stateless SEP-7 URI builder (any destination may be encoded into a payment link).",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/payment-requests",
      body: { destination: ctx.alice.publicKey(), amount: "10" },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/payment-requests/parse",
    authzClass: "authenticated-unscoped",
    rationale: "Stateless SEP-7 URI parser.",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/payment-requests/parse",
      body: { uri: `web+stellar:pay?destination=${ctx.alice.publicKey()}&amount=5` },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/send",
    authzClass: "authenticated-account-scoped",
    rationale: "Legacy custodial send; derives public key from sourceSecretKey and enforces account match (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/send",
      body: {
        sourceSecretKey: ctx.alice.secret(),
        destinationPublicKey: ctx.bob.publicKey(),
        amount: "1",
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/send/precheck",
    authzClass: "authenticated-account-scoped",
    rationale: "Pre-signing send checks; scoped to sourcePublicKey.",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/send/precheck",
      body: {
        sourcePublicKey: ctx.alice.publicKey(),
        destinationPublicKey: ctx.bob.publicKey(),
        amount: "1",
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/fee-bump",
    authzClass: "authenticated-account-scoped",
    rationale: "Legacy custodial fee-bump; derives public key from feeSecretKey and enforces account match (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/fee-bump",
      body: {
        transactionXdr: ctx.aliceSignedPaymentXdr,
        feeSecretKey: ctx.alice.secret(),
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/sponsor-fee",
    authzClass: "authenticated-account-scoped",
    rationale: "Server-sponsored fee-bump; scoped to body.innerAccount AND innerTx.source (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/sponsor-fee",
      body: {
        transactionXdr: ctx.aliceSignedPaymentXdr,
        innerAccount: ctx.alice.publicKey(),
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/path-payment-strict-send",
    authzClass: "authenticated-account-scoped",
    rationale: "Legacy custodial strict-send path payment; scoped via sourceSecretKey (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/path-payment-strict-send",
      body: {
        sourceSecretKey: ctx.alice.secret(),
        destinationPublicKey: ctx.bob.publicKey(),
        sendAmount: "5",
        destAsset: "XLM",
        destMin: "4",
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/path-payment-strict-receive",
    authzClass: "authenticated-account-scoped",
    rationale: "Legacy custodial strict-receive path payment; scoped via sourceSecretKey (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/path-payment-strict-receive",
      body: {
        sourceSecretKey: ctx.alice.secret(),
        destinationPublicKey: ctx.bob.publicKey(),
        destAmount: "5",
        destAsset: "XLM",
        sendMax: "6",
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/:publicKey/muxed",
    authzClass: "authenticated-account-scoped",
    rationale: "Authenticated wallet muxed-address generator; scoped to :publicKey (#233 fix).",
    buildRequest: (ctx) => ({
      path: `/api/v1/wallet/${ctx.alice.publicKey()}/muxed`,
      body: { id: "42" },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/set-options/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned setOptions multisig XDR; scoped to sourcePublicKey.",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/set-options/build",
      body: {
        sourcePublicKey: ctx.alice.publicKey(),
        masterWeight: 1,
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/partial-transaction",
    authzClass: "authenticated-account-scoped",
    rationale: "Legacy partial transaction builder; scoped via sourceSecretKey (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/partial-transaction",
      body: {
        sourceSecretKey: ctx.alice.secret(),
        destinationPublicKey: ctx.bob.publicKey(),
        amount: "1",
      },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/paths/strict-send",
    authzClass: "authenticated-unscoped",
    rationale: "Authenticated Horizon DEX path quote lookup (asset-pair only, no account ownership).",
    buildRequest: () => ({
      path: "/api/v1/wallet/paths/strict-send",
      body: { sourceAmount: "10", destinationAsset: "XLM" },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/paths/strict-receive",
    authzClass: "authenticated-unscoped",
    rationale: "Authenticated Horizon DEX path quote lookup (asset-pair only, no account ownership).",
    buildRequest: () => ({
      path: "/api/v1/wallet/paths/strict-receive",
      body: { destinationAmount: "10", destinationAsset: "XLM" },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/submit-multisig",
    authzClass: "authenticated-account-scoped",
    rationale: "Legacy multisig submission; scoped via derived signerSecretKeys (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/wallet/submit-multisig",
      body: {
        xdr: ctx.aliceSignedPaymentXdr,
        signerSecretKeys: [ctx.alice.secret()],
      },
    }),
  },
  {
    method: "GET",
    path: "/api/v1/wallet/:publicKey/thresholds",
    authzClass: "authenticated-account-scoped",
    rationale: "Authenticated wallet thresholds read; scoped to :publicKey (#233 fix).",
    buildRequest: (ctx) => ({
      path: `/api/v1/wallet/${ctx.alice.publicKey()}/thresholds`,
    }),
  },
  {
    method: "POST",
    path: "/api/v1/wallet/keypair",
    authzClass: "authenticated-unscoped",
    rationale: "Legacy keypair generator audited against req.user.sub; generates a fresh unowned keypair.",
    buildRequest: () => ({ path: "/api/v1/wallet/keypair", body: {} }),
  },

  // ── Contract Routes (Public reads + Account-scoped builders/submit) ──────
  {
    method: "GET",
    path: "/api/v1/contract/wallet/:publicKey/assets",
    authzClass: "public",
    rationale: "Public Soroban contract read for user's whitelisted assets.",
    buildRequest: (ctx) => ({ path: `/api/v1/contract/wallet/${ctx.alice.publicKey()}/assets` }),
  },
  {
    method: "GET",
    path: "/api/v1/contract/wallet/:publicKey/spend-allowance",
    authzClass: "public",
    rationale: "Public Soroban contract read for spend allowances.",
    buildRequest: (ctx) => ({
      path: `/api/v1/contract/wallet/${ctx.alice.publicKey()}/spend-allowance`,
    }),
  },
  {
    method: "GET",
    path: "/api/v1/contract/wallet/:publicKey/spend-allowance/:assetCode",
    authzClass: "public",
    rationale: "Public Soroban contract read for single-asset spend allowance.",
    buildRequest: (ctx) => ({
      path: `/api/v1/contract/wallet/${ctx.alice.publicKey()}/spend-allowance/XLM`,
    }),
  },
  {
    method: "GET",
    path: "/api/v1/contract/wallet/guardians",
    authzClass: "public",
    rationale: "Public on-chain guardian list.",
    buildRequest: () => ({ path: "/api/v1/contract/wallet/guardians" }),
  },
  {
    method: "GET",
    path: "/api/v1/contract/wallet/recovery/config",
    authzClass: "public",
    rationale: "Public on-chain recovery threshold and timelock.",
    buildRequest: () => ({ path: "/api/v1/contract/wallet/recovery/config" }),
  },
  {
    method: "GET",
    path: "/api/v1/contract/wallet/recovery/proposal",
    authzClass: "public",
    rationale: "Public on-chain active recovery proposal transparency.",
    buildRequest: () => ({ path: "/api/v1/contract/wallet/recovery/proposal" }),
  },
  {
    method: "GET",
    path: "/api/v1/contract/wallet/recovery",
    authzClass: "public",
    rationale: "Public combined on-chain recovery state.",
    buildRequest: () => ({ path: "/api/v1/contract/wallet/recovery" }),
  },
  {
    method: "GET",
    path: "/api/v1/contract/status",
    authzClass: "public",
    rationale: "Public emergency send-pause status.",
    buildRequest: () => ({ path: "/api/v1/contract/status" }),
  },
  {
    method: "GET",
    path: "/api/v1/contract/admin",
    authzClass: "public",
    rationale: "Public current and pending contract admin addresses.",
    buildRequest: () => ({ path: "/api/v1/contract/admin" }),
  },
  {
    method: "GET",
    path: "/api/v1/contract/upgrade",
    authzClass: "public",
    rationale: "Public contract upgrade timelock transparency.",
    buildRequest: () => ({ path: "/api/v1/contract/upgrade" }),
  },
  {
    method: "GET",
    path: "/api/v1/contract/upgrade/status",
    authzClass: "public",
    rationale: "Public upgrade watcher status.",
    buildRequest: () => ({ path: "/api/v1/contract/upgrade/status" }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/assets/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned add_asset contract tx; scoped to body.user.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/assets/build",
      body: { user: ctx.alice.publicKey(), asset: { code: "XLM", issuer: null } },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/assets/remove/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned remove_asset contract tx; scoped to body.user.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/assets/remove/build",
      body: { user: ctx.alice.publicKey(), assetCode: "XLM" },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/guardians/add/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned add_guardian tx; scoped to body.admin.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/guardians/add/build",
      body: { admin: ctx.alice.publicKey(), guardian: ctx.issuer.publicKey() },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/guardians/remove/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned remove_guardian tx; scoped to body.admin.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/guardians/remove/build",
      body: { admin: ctx.alice.publicKey(), guardian: ctx.issuer.publicKey() },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/recovery/initiate/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned initiate_recovery tx; scoped to body.guardian.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/recovery/initiate/build",
      body: { guardian: ctx.alice.publicKey(), newAdmin: ctx.issuer.publicKey() },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/recovery/approve/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned approve_recovery tx; scoped to body.guardian.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/recovery/approve/build",
      body: { guardian: ctx.alice.publicKey() },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/recovery/revoke-approval/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned revoke_recovery_approval tx; scoped to body.guardian.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/recovery/revoke-approval/build",
      body: { guardian: ctx.alice.publicKey() },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/recovery/execute/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned execute_recovery tx; scoped to body.sourcePublicKey.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/recovery/execute/build",
      body: { sourcePublicKey: ctx.alice.publicKey() },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/recovery/cancel/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned cancel_recovery tx; scoped to body.admin.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/recovery/cancel/build",
      body: { admin: ctx.alice.publicKey() },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/spend-limit/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned set_spend_limit tx; scoped to body.user.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/spend-limit/build",
      body: { user: ctx.alice.publicKey(), assetCode: "XLM", limit: "100" },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/admin/propose",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned propose_admin tx; scoped to body.currentAdmin.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/admin/propose",
      body: { currentAdmin: ctx.alice.publicKey(), candidate: ctx.issuer.publicKey() },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/admin/accept",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned accept_admin tx; scoped to body.candidate (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/admin/accept",
      body: { candidate: ctx.alice.publicKey() },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/admin/cancel",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned cancel_admin_transfer tx; scoped to body.currentAdmin.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/admin/cancel",
      body: { currentAdmin: ctx.alice.publicKey() },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/spend",
    authzClass: "authenticated-account-scoped",
    rationale: "Legacy custodial record_spend; derives public key from userSecretKey and enforces account match (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/spend",
      body: { userSecretKey: ctx.alice.secret(), assetCode: "XLM", amount: "1000" },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/spend/build",
    authzClass: "authenticated-account-scoped",
    rationale: "Builds unsigned record_spend tx; scoped to body.userPublicKey.",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/spend/build",
      body: { userPublicKey: ctx.alice.publicKey(), assetCode: "XLM", amount: "1000" },
    }),
  },
  {
    method: "POST",
    path: "/api/v1/contract/wallet/submit",
    authzClass: "authenticated-account-scoped",
    rationale: "Submits signed Soroban envelope; scoped to envelope source / fee source (#233 fix).",
    buildRequest: (ctx) => ({
      path: "/api/v1/contract/wallet/submit",
      body: { signedXdr: ctx.aliceSignedSorobanXdr },
    }),
  },
];

export const ROUTE_AUTHZ_MAP = new Map<string, RouteAuthzEntry>(
  ROUTE_AUTHZ_POLICY.map((entry) => [`${entry.method} ${entry.path}`, entry])
);
