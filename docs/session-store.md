# Redis-Backed Session Store with Revocation and Device Binding

## Summary

`sessionStore` replaces in-process stubs with a shared, scalable Redis-backed session management architecture. Sessions support device tracking, instant revocation across all backend instances, and refresh token rotation with cryptographic reuse detection.

## Threat Model & Guarantees

### Token Thefts & Replays (Reuse Detection)
- **Vulnerability**: If an attacker steals a client's refresh token and exchanges it for an access token, the legitimate user will eventually attempt to use their own copy of the same refresh token.
- **Defense**: Every refresh token belongs to a cryptographic token family. When a refresh token is exchanged, it is flagged as `used = true` in Redis. If a token marked `used` is submitted again, the system detects a replay attack, immediately revokes the entire session and token family, and returns `TOKEN_REUSE_DETECTED`.

### Instant Session Revocation
- **Requirement**: "Revocation checked on every request; revoked session rejected on all instances within 1s."
- **Implementation**: Access tokens embed the `session_id`. On every authenticated request, `jwtAuth` queries `sessionStore.isSessionRevoked(sub, sessionId)`. Results are cached in memory for at most 1 second, guaranteeing that a `revokeSession` or `revokeAllSessions` (e.g. after contract recovery or password reset) takes effect across all instances within 1000ms without overwhelming Redis.

### Device Binding
- Session records associate the user with optional `deviceId` and `deviceLabel`, alongside non-PII `ipHash` and `userAgent`.
- Users can inspect and selectively revoke foreign sessions via `GET /auth/sessions` and `DELETE /auth/sessions/:id`.
