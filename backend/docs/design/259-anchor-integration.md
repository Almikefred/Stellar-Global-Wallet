# #259: SEP-24 / SEP-6 anchor integration for deposits and withdrawals

**Status:** proposed, design to be agreed on the issue before code · **Size:** XL (stacked PRs) ·
**Touches:** new `src/services/anchors/`, new `src/routes/anchors.ts`, `src/db.ts`,
`src/config.ts`, OpenAPI, `packages/sdk`

## Context

There is no on/off-ramp today. The API can move assets on-chain but cannot
turn fiat into a Stellar asset or back. Anchors provide that through
standard SEPs:

- **SEP-1** (`stellar.toml`): discovery of an anchor's endpoints, signing key and assets.
- **SEP-10**: the wallet proves control of a Stellar account and receives an anchor JWT.
- **SEP-24**: interactive (anchor-hosted web UI) deposit and withdraw. **This is the acceptance criterion.**
- **SEP-6**: programmatic (non-interactive) deposit and withdraw. It shares discovery, auth and status tracking, so the design covers it, but it ships after SEP-24.

## Key decision: who signs the SEP-10 challenge?

The SEP-10 challenge must be signed by the user's account key (or enough of its
signers to meet the account's threshold).

| Option | Pros | Cons |
|---|---|---|
| **A. Client signs (recommended).** The backend fetches and **verifies** the challenge, returns its XDR, the client signs locally, and the backend forwards it and stores the anchor JWT. | The user's secret never reaches the server. Matches the contract admin routes, which already return unsigned XDR. Supports multisig and hardware wallets. | One extra round-trip. |
| B. Server signs with a `sourceSecretKey` in the body, like `/wallet/send` | No client crypto | Spreads secret-in-body handling to a new surface, so the server holds a credential that unlocks a third party's KYC data. |

**Recommendation: A.** Option B can be added later for parity if the product
needs it, but it should not be the default.

## Architecture

```
routes/anchors.ts          thin handlers (per #258)
services/anchors/
  allowlist.ts             configured anchors (home_domain → policy)
  toml.ts                  SEP-1 fetch + parse + cache (#257 cache, ttl 1h, stale 24h)
  sep10.ts                 challenge fetch, verification, token exchange
  sep24.ts                 /info, /transactions/deposit|withdraw/interactive, /transaction(s)
  sep6.ts                  (stage 5)
  transfers.ts             persistence + status state machine
  poller.ts                background status refresh
  httpClient.ts            outbound fetch with timeouts, size limits, no redirects off-domain
```

## API (new, under `/api/v1/anchors`, all behind `jwtAuth`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List allowlisted anchors with their supported assets (from SEP-1 + SEP-24 `/info`) |
| POST | `/:domain/auth/challenge` | `{ account }` → `{ challengeXdr, networkPassphrase }` (verified server-side first) |
| POST | `/:domain/auth/token` | `{ account, signedChallengeXdr }` → `{ expiresAt }` (the anchor JWT is stored server-side, **never returned**) |
| POST | `/:domain/sep24/deposit` | `{ account, assetCode, amount?, lang? }` → `{ transferId, interactiveUrl, anchorTransactionId }` |
| POST | `/:domain/sep24/withdraw` | same shape |
| GET | `/transfers/:transferId` | Current status, amounts and fees, plus the withdraw payment instructions when `pending_user_transfer_start` |
| GET | `/transfers?account=G…&status=…&cursor=…` | List transfers |

Notes:

- `account` is validated as a checksummed G-address. Muxed (M…) accounts are
  supported via SEP-10 `memo` / muxed handling only in a later stage.
- `amount` is a decimal string, as everywhere else in the API.
- **Withdraw completion:** when the transfer reaches
  `pending_user_transfer_start`, the client sends the on-chain payment using
  the existing `/wallet/send` (or a client-signed transaction) with the
  anchor-provided `withdraw_anchor_account` and `memo`/`memo_type`. The
  backend returns those values and does not submit the payment itself.
- Every route has an OpenAPI entry and an SDK method in the same PR.

## Threat model

| Threat | Mitigation |
|---|---|
| **Malicious or spoofed anchor** (phishing interactive URL, fake toml) | **Allowlist only.** `ANCHOR_ALLOWLIST` lists home domains, and `:domain` must match an entry exactly. The TOML is fetched only from `https://{domain}/.well-known/stellar.toml`, with no redirects to another host. `interactiveUrl` must be https and its host must match the allowlist entry's permitted hosts (the domain itself plus explicit extras). |
| **SSRF through anchor-provided URLs** (`TRANSFER_SERVER_SEP0024`, `WEB_AUTH_ENDPOINT` pointing at internal IPs) | The outbound client resolves DNS and rejects private, loopback and link-local addresses (including after redirects; redirects off the TOML's host are refused). https only, with a 5 s timeout and a 256 KB response cap. |
| **SEP-10 challenge abuse.** A malicious anchor sends a "challenge" that is really a payment or `set_options` the user is tricked into signing. | Full server-side verification per SEP-10 before returning XDR, preferably with `WebAuth.readChallengeTx` from `@stellar/stellar-sdk`: source = TOML `SIGNING_KEY`, sequence 0, all ops are `manage_data`, first op source = the user's account, `home_domain` key matches, `web_auth_domain` matches the endpoint host, timebounds are valid and short, the network passphrase matches, and the anchor's signature is present. Anything else → 502 `ANCHOR_CHALLENGE_INVALID`, and nothing is returned for the client to sign. |
| **Anchor JWT theft** | Stored encrypted at rest (AES-GCM, key from `ANCHOR_TOKEN_KEY`), keyed by `(domain, account)`, never returned to clients, never logged. Deleted on expiry. |
| **Cross-user access to transfers.** Today every caller shares the JWT `sub` `"api-key-user"`, so `sub` cannot be used as the ownership boundary. | Transfers are scoped by **Stellar account**. Reads require a valid stored anchor token for that `(domain, account)`, which proves that someone holding the account key authenticated. Revisit when real per-user identity lands. |
| **Status spoofing / tampering** (trusting client-reported status) | Status only ever comes from the anchor's `/transaction` endpoint, called by the backend with the stored token. Any `stellar_transaction_id` the anchor reports is cross-checked against Horizon before it is shown as `completed` (deposit: a payment to the account for the asset exists). |
| **Amount and fee confusion** | All amounts are stored as decimal strings exactly as the anchor sent them, and never parsed to float. Display rounding is the client's job. |
| **Interactive URL leakage.** It contains a short-lived token. | Returned once, never logged, not stored after creation. |

## Data model

```sql
CREATE TABLE IF NOT EXISTS anchor_tokens (
  home_domain   text        NOT NULL,
  account       text        NOT NULL,          -- G… address
  token_enc     bytea       NOT NULL,          -- AES-GCM ciphertext
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (home_domain, account)
);

CREATE TABLE IF NOT EXISTS anchor_transfers (
  id                     uuid        PRIMARY KEY,
  home_domain            text        NOT NULL,
  account                text        NOT NULL,
  protocol               text        NOT NULL CHECK (protocol IN ('sep24','sep6')),
  kind                   text        NOT NULL CHECK (kind IN ('deposit','withdrawal')),
  asset_code             text        NOT NULL,
  asset_issuer           text,
  anchor_transaction_id  text        NOT NULL,
  status                 text        NOT NULL,   -- SEP-24 status vocabulary verbatim
  amount_in              text,                   -- decimal strings
  amount_out             text,
  amount_fee             text,
  stellar_transaction_id text,
  withdraw_anchor_account text,
  withdraw_memo          text,
  withdraw_memo_type     text,
  message                text,                   -- anchor-provided, shown to user, length-capped
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  next_poll_at           timestamptz,
  poll_failures          int         NOT NULL DEFAULT 0,
  UNIQUE (home_domain, anchor_transaction_id)
);
CREATE INDEX IF NOT EXISTS anchor_transfers_account_idx ON anchor_transfers (account, created_at DESC);
CREATE INDEX IF NOT EXISTS anchor_transfers_poll_idx    ON anchor_transfers (next_poll_at) WHERE next_poll_at IS NOT NULL;
```

### Status state machine

Status values are SEP-24's own (`incomplete`, `pending_user_transfer_start`,
`pending_anchor`, `pending_stellar`, `pending_external`, `pending_trust`,
`pending_user`, `completed`, `refunded`, `expired`, `error`, `no_market`,
`too_small`, `too_large`). The backend stores them verbatim and treats
`completed`, `refunded`, `expired`, `error`, `no_market`, `too_small` and
`too_large` as **terminal**. A terminal status is never overwritten by a
non-terminal one; if an anchor tries, log it and alert. Every status change is
written to the existing audit log, and a push or email notification hooks in
via `paymentNotifier`.

### Polling

`poller.ts` runs in-process on an interval. It picks rows with
`next_poll_at <= now()` using `FOR UPDATE SKIP LOCKED`, so several instances
are safe. Backoff: 5 s for the first minute, then 30 s, then 5 min, and
stopping at a terminal status. `poll_failures` drives exponential backoff up
to 1 h. A `GET /transfers/:id` also triggers a refresh if the row is older
than 10 s, single-flighted through the #257 cache. SEP-24 callbacks
(`on_change_callback`) are deferred because they need a public signed webhook
endpoint.

## Failure modes

| Failure | Behaviour |
|---|---|
| TOML unreachable | Serve the cached TOML within its stale window (24 h). Otherwise 503 `ANCHOR_UNAVAILABLE`, `retryable: true`. |
| TOML changes `SIGNING_KEY` | The next challenge verifies against the new key. Existing tokens stay valid until they expire. Logged. |
| Anchor JWT expired | 401 `ANCHOR_AUTH_REQUIRED`. The client repeats the challenge/token flow. Polling for that account pauses until re-auth. |
| Anchor `/transaction` 404 | Mark the transfer `error` after N consecutive 404s (an anchor can lag right after creation). |
| Anchor returns a malformed body | Validate with zod and count it as a poll failure. Never write unvalidated fields. |
| User abandons the interactive flow | The status stays `incomplete` and polling backs off to 5 min. Mark it `expired` locally after 24 h of `incomplete`, and record that the expiry was local. |
| Duplicate create (client retry) | `UNIQUE (home_domain, anchor_transaction_id)`, plus an optional `idempotencyKey` on the create routes, reusing the #258 store. |
| Deposit needs a trustline (`pending_trust`) | Surface the status with a `requiredTrustline: { code, issuer }` hint. The client adds the trustline with the existing flows. |
| Server restart mid-poll | The `SKIP LOCKED` transaction rolls back and another poll picks the row up. |

## Configuration

```
ANCHOR_ALLOWLIST=testanchor.stellar.org            # comma-separated home domains
ANCHOR_ALLOWLIST_EXTRA_HOSTS=testanchor.stellar.org:demo-wallet.stellar.org   # optional, permitted interactive URL hosts
ANCHOR_TOKEN_KEY=<32-byte base64>                  # required when the allowlist is non-empty
ANCHOR_POLL_ENABLED=true
```

`.env.example` defaults to the SDF test anchor (`testanchor.stellar.org`) on
testnet. Startup fails validation if a mainnet passphrase is used with the
test anchor.

## Test plan

- **Unit:** challenge verification with one fixture per rejection rule (wrong
  signing key, non-zero sequence, extra payment op, wrong home domain, expired
  timebounds, wrong network, missing anchor signature). Plus allowlist and host
  matching, SSRF IP rejection, state machine transitions (terminal is
  immutable), and token encryption round-trip.
- **Integration (CI, no network):** a local fake anchor (express) that serves
  `stellar.toml`, SEP-10 and SEP-24 endpoints, with scripted status
  progressions. It covers the full deposit and withdraw flows, token expiry,
  malformed responses and poller backoff.
- **Integration (optional, nightly):** the same flows against
  `testanchor.stellar.org` using the SDF
  [anchor-tests](https://github.com/stellar/stellar-anchor-tests) server or
  the test anchor directly, gated by `ANCHOR_E2E=1` so the PR CI stays
  hermetic. This meets the "anchor test server flows pass" test plan item.
- The existing route test suites are unchanged.

## Stacked PR plan

1. **Design** (this note): agreed on the issue.
2. **Foundation:** outbound HTTP client (SSRF guard), allowlist config, SEP-1 TOML fetch + cache, `GET /anchors`.
3. **SEP-10:** challenge verification, token exchange, encrypted token store, auth routes.
4. **SEP-24:** `/info`, interactive deposit and withdraw, `anchor_transfers` table, `GET /transfers*`.
5. **Status tracking:** poller, Horizon cross-check, notifications, audit log.
6. **SEP-6:** non-interactive deposit and withdraw on the same tables (`protocol = 'sep6'`), KYC via SEP-12 deferred.
7. **Docs and SDK polish:** integrator guide in `docs/anchors.md`, SDK helpers.

Each PR updates the OpenAPI spec and `packages/sdk` for the routes it adds.

## Out of scope / deferred

- SEP-12 KYC (needed for most production SEP-6 anchors).
- SEP-38 quotes / cross-asset deposits.
- SEP-24 `on_change_callback` webhooks.
- Muxed-account (M…) and memo-based shared-account SEP-10.
- Any UI. The interactive flow runs in the anchor's own web page, and the wallet UI is built separately from the design.
