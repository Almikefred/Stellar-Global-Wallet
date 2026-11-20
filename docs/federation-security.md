# Federation (SEP-2): Caching, Validation & Spoofing Protection

## Security Design

Federation lookups (`name*domain.com`) resolve human-readable aliases to on-chain Stellar account addresses and transaction memos. Because arbitrary domains can be queried, resolution is protected against spoofing, SSRF attacks, and malformed inputs.

### 1. Strict Schema & Bounds Validation
- **Account Address**: Must strictly conform to an ed25519 public key (`G[A-Z2-7]{55}`) or Med25519 muxed address (`M[A-Z2-7]{68}`).
- **Memos**:
  - `id`: Must be a valid unsigned 64-bit integer string ($0 \le \text{value} \le 18446744073709551615$).
  - `hash`: Must be exactly 32 bytes (64 hex characters or 44 base64 characters).
  - `text`: UTF-8 string bounded at $\le 28$ bytes.
- Any malformed field triggers `FEDERATION_INVALID_RESPONSE`.

### 2. SSRF Hardening & Protocol Pinning
- **Domain Verification**: Domains resolving to localhost, loopback (`127.0.0.1`), metadata IP (`169.254.169.254`), private IP ranges, or raw IP literals are blocked.
- **HTTPS Only**: Federation servers and `stellar.toml` endpoints must strictly use TLS (`https://`).

### 3. Caching & Negative Caching
- **Positive Cache**: Successful resolutions are cached with a 5-minute TTL.
- **Negative Cache**: Failed domains (404s, unresolvable domains) are cached for 60 seconds to prevent DoS amplification attacks.

### 4. Client Confirmation Payload
The API returns both the original `query` and the resolved `accountId`:
```json
{
  "query": "alice*example.com",
  "type": "federation",
  "accountId": "GBEXAMPLE...",
  "memo": "123456",
  "memoType": "id"
}
```
Clients must display the resolved destination address to the user before signing.
