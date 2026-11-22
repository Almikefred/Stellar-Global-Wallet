# Guardian Liveness Checks and Stale Guardian Replacement

**Issue:** [#242](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/242)  
**Status:** Proposed  
**Difficulty:** Hard  
**Estimated size:** L — roughly 1–2 weeks

---

## Problem

Guardians can lose their keys or become permanently unreachable with no observable signal on-chain. This goes unnoticed until the moment a recovery is initiated — at which point the quorum may already be broken and recovery fails.

---

## Proposed Design

### Guardian heartbeat

Introduce a lightweight `guardian_heartbeat()` contract function that a guardian calls to record their liveness. The call requires `guardian.require_auth()` and writes a single timestamp to storage.

```rust
// DataKey::GuardianLastSeen(guardian: Address)
pub struct GuardianLastSeen {
    pub timestamp: u64,   // env.ledger().timestamp()
}
```

The function emits `guardian_heartbeat { wallet, guardian, timestamp }` and returns nothing. Its resource cost must be minimal — it writes one storage entry and emits one event.

Off-chain attestation (a signed message submitted by a backend service on behalf of a guardian) is a viable alternative for guardians who cannot transact frequently, but is not in scope for this issue. The on-chain path is implemented first; off-chain attestation can be layered on top.

### Stale guardian detection

A guardian is considered **stale** when:

```
env.ledger().timestamp() - last_seen > GUARDIAN_STALE_THRESHOLD
```

`GUARDIAN_STALE_THRESHOLD` is a contract-level config parameter (suggested default: 90 days). It can be updated by the admin and must be greater than zero.

The backend exposes a `GET /wallet/:id/guardians` response that includes a `liveness` field per guardian:

```json
{
  "address": "G...",
  "last_seen": 1718000000,
  "stale": true
}
```

Guardians with no recorded heartbeat are treated as stale unconditionally.

### Stale guardian replacement

An admin can replace a stale guardian by calling `replace_stale_guardian(old: Address, new: Address)`.

- Verifies that `old` is in the active guardian set.
- Verifies that `old` is stale (last seen older than threshold).
- Requires `new` to have an accepted invitation (see issue #241) **or** accepts inline consent from `new` via `new.require_auth()` in the same transaction.
- Removes `old`, adds `new`, and resets the last-seen timestamp for `new` to `now`.
- Emits `guardian_replaced { wallet, old_guardian, new_guardian, reason: "stale" }`.

The admin cannot replace a guardian that is **not** stale through this path — use the standard remove/invite flow instead.

---

## Failure Modes

| Scenario | Behaviour |
|---|---|
| Guardian never calls heartbeat | Treated as stale from day 0; `last_seen` is `None` |
| Threshold set to 0 | Contract rejects update; `InvalidThreshold` error |
| `replace_stale_guardian` on a live guardian | `GuardianNotStale` error |
| `replace_stale_guardian` without admin auth | Auth failure |
| Quorum drops below minimum after replacement | Replacement blocked; `QuorumViolation` error |

---

## Events

| Event | Topics | Data |
|---|---|---|
| `guardian_heartbeat` | `["guardian_heartbeat", wallet, guardian]` | `{ timestamp }` |
| `guardian_replaced` | `["guardian_replaced", wallet, old, new]` | `{ reason, timestamp }` |
| `stale_threshold_updated` | `["stale_threshold_updated", wallet]` | `{ old_threshold, new_threshold }` |

---

## API Changes

`GET /wallet/:id/guardians` — add `last_seen` (Unix timestamp or `null`) and `stale` (boolean) to each guardian object in the response.

Update the OpenAPI spec and `packages/sdk` in the same PR.

---

## Security Considerations

- The heartbeat function must require auth from the guardian themselves; a third party must not be able to reset a guardian's liveness clock on their behalf (would suppress stale detection).
- Stale threshold changes are admin-only and emit an event so they appear in audit logs.
- Replacement requires the new guardian's consent (via the two-step flow from #241) to prevent an admin from silently substituting an attacker-controlled address.

---

## Test Plan

| Test | Expected |
|---|---|
| Heartbeat with valid guardian auth | `last_seen` updated, event emitted |
| Heartbeat signed by non-guardian | Auth failure |
| Guardian with no heartbeat is stale | `stale: true` in API response |
| Guardian heartbeat within threshold | `stale: false` |
| `replace_stale_guardian` on a stale guardian | Guardian replaced, event emitted |
| `replace_stale_guardian` on a live guardian | `GuardianNotStale` error |
| Replacement that would break quorum | `QuorumViolation` error |
| `GET /guardians` returns `last_seen` and `stale` fields | Schema validates |

---

## Tasks

- [ ] Add `GuardianLastSeen` storage key and struct
- [ ] Add `GUARDIAN_STALE_THRESHOLD` config entry and admin setter
- [ ] Implement `guardian_heartbeat()` with guardian `require_auth`
- [ ] Implement `replace_stale_guardian(old, new)` with admin auth and new-guardian consent
- [ ] Emit all events
- [ ] Extend `GET /wallet/:id/guardians` with liveness fields
- [ ] Update OpenAPI spec and SDK
- [ ] Write all tests listed above
- [ ] Update README / docs

---

## Definition of Done

- [ ] Code merged to `main` with all tests passing
- [ ] All acceptance criteria checked (guardian liveness visible, CI green, no unlinked TODOs)
- [ ] PR description links this issue (`Closes #242`) and lists any deferred work
- [ ] Docs updated where integrator-facing behaviour changed
