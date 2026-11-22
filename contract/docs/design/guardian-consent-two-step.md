# Guardian Consent: Two-Step Invitation Flow

**Issue:** [#241](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/241)  
**Status:** Proposed  
**Difficulty:** Hard  
**Estimated size:** L — roughly 1–2 weeks

---

## Problem

`add_guardian` currently requires only admin authorisation. The guardian address itself never signs or acknowledges the action. This creates two practical risks:

1. **Typos.** A mistyped address adds an unreachable guardian silently, degrading recovery quorum with no warning.
2. **Attacker-controlled addresses.** An attacker who compromises the admin key can add addresses they control as guardians without any on-chain visibility to the legitimate guardian set.

---

## Proposed Design

Replace the single-step `add_guardian` call with a two-step invitation/acceptance protocol.

### Step 1 — Admin invites

The admin calls `invite_guardian(candidate: Address, expiry: u64)`.

- Stores a `PendingInvitation { invited_by, expires_at }` keyed by the candidate address.
- Emits `guardian_invited { wallet, candidate, expires_at }`.
- Does **not** add the address to the active guardian set.

### Step 2 — Guardian accepts

The candidate calls `accept_guardian_invitation()`.

- Requires `candidate.require_auth()` — the candidate must sign the transaction.
- Checks that an unexpired invitation exists for the signer.
- Removes the pending invitation and adds the signer to the active guardian set.
- Emits `guardian_accepted { wallet, guardian }`.

### Expiry

Invitations expire after a configurable window (suggested default: 7 days / ~604 800 ledger seconds). Expired invitations are cleaned up lazily on the next `invite_guardian` or `accept_guardian_invitation` call for that address, or by an explicit `prune_expired_invitations()` admin call.

Emits `guardian_invitation_expired { wallet, candidate }` when pruned.

---

## Data Model

```rust
// Stored under DataKey::PendingInvitation(candidate)
pub struct PendingInvitation {
    pub invited_by: Address,
    pub expires_at: u64,   // ledger timestamp
}
```

The existing `GuardianSet` storage is unchanged until `accept_guardian_invitation` succeeds.

---

## Failure Modes

| Scenario | Behaviour |
|---|---|
| Admin invites a typo address | Address never calls `accept`; invitation expires and is pruned |
| Attacker adds their own address as guardian | Requires the attacker to also control the admin key — no change in that threat surface |
| Guardian invitation expires before acceptance | Invitation removed; admin must re-invite |
| Double-accept (replay) | Second call finds no pending invitation; returns `NoInvitationFound` error |
| Invite while one is already pending | Overwrites with new expiry (admin can refresh) |

---

## Events

All events use the standard envelope: `{ contract, fn_name, topics: [...], data: {...} }`.

| Event | Topics | Data |
|---|---|---|
| `guardian_invited` | `["guardian_invited", wallet, candidate]` | `{ invited_by, expires_at }` |
| `guardian_accepted` | `["guardian_accepted", wallet, guardian]` | `{ invited_by }` |
| `guardian_invitation_expired` | `["guardian_invitation_expired", wallet, candidate]` | `{ expires_at }` |

---

## Security Considerations

- **require_auth placement:** `candidate.require_auth()` must be called before any state reads to prevent auth-bypass via re-entrancy (see `wiring-reentrancy-threat-model.md`).
- **Expiry clock:** Use `env.ledger().timestamp()`, not sequence numbers, so the window is human-readable and predictable.
- **Quorum invariant:** The minimum guardian threshold check (if any) must still be enforced after acceptance, not at invitation time.

---

## Test Plan

| Test | Expected |
|---|---|
| `accept_guardian_invitation` with valid unexpired invite | Guardian added, event emitted |
| `accept_guardian_invitation` without prior invite | `NoInvitationFound` |
| `accept_guardian_invitation` with expired invite | `InvitationExpired` |
| `accept_guardian_invitation` signed by wrong address | Auth failure |
| Guardian does **not** appear in active set after invite but before accept | Assert not in `get_guardians` |
| `invite_guardian` without admin auth | Auth failure |
| Duplicate `accept_guardian_invitation` (replay) | `NoInvitationFound` on second call |

---

## Tasks

- [ ] Add `PendingInvitation` storage key and struct
- [ ] Implement `invite_guardian(candidate, expiry)` with admin auth
- [ ] Implement `accept_guardian_invitation()` with candidate `require_auth`
- [ ] Implement `prune_expired_invitations()` admin utility
- [ ] Emit all three events
- [ ] Write all tests listed above
- [ ] Update OpenAPI spec and SDK for any new backend endpoints that surface invitation state
- [ ] Update README / docs where `add_guardian` behaviour is described

---

## Definition of Done

- [ ] Code merged to `main` with all tests passing
- [ ] All acceptance criteria checked (`guardian consent required`, CI green, no unlinked TODOs)
- [ ] PR description links this issue (`Closes #241`) and lists any deferred work
- [ ] Docs updated where integrator-facing behaviour changed
