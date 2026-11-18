# globe-wallet storage layout v2 (issue #184)

## Problem

Instance storage is loaded on **every** invocation. In v1 it held, besides the
hot config, the guardian `Vec`, the `GuardianMembership` map and the whole
`RecoveryProposal` (with its approvals `Vec`). `send` and `record_spend` paid
to load up to 15 guardians, a 15-entry map and a proposal they never read.

## Layout

| Data | v1 | v2 |
|---|---|---|
| `Admin`, `PendingAdmin`, `PendingUpgrade`, `RecoveryConfig`, `TokenWrapperId`, `AllowedTokens` | instance | instance (hot / tiny config) |
| guardian list | instance `Guardians` | persistent `GuardianSet` |
| guardian membership | instance `GuardianMembership` map | persistent `GuardianFlag(addr)`, one entry per guardian |
| recovery proposal | instance `RecoveryProposal` | persistent `PendingRecovery` |
| layout version | absent | instance `StorageLayout = 2` |

Membership checks (`require_guardian`, `add_guardian`) now read a single
small entry instead of deserialising a map. The guardian list and the
approvals vector stay vectors because they are the enumeration API, but both
are bounded by `MAX_GUARDIANS = 15` and only touched on guardian/recovery
calls.

## Migration

* New deployments write `StorageLayout = 2` in `initialize`.
* Upgraded v1 contracts keep working: reads fall back to the v1 instance keys.
* Every guardian/recovery write migrates lazily (`ensure_storage_layout`).
* `migrate_storage_layout(admin)` migrates on demand right after an upgrade;
  it is idempotent (returns `false` when already on v2) and emits
  `storage_migrated(version, guardians_moved, proposal_moved)`.

## TTL policy

Every v2 persistent write extends the entry to ~30 days
(`PERSISTENT_TTL_EXTEND_TO`) once it is below ~7 days, same as `UserAssets`
and `SpendLimit`. Instance TTL is still bumped on every write.

## Measuring

`bench_record_spend_footprint_with_full_guardian_set` sets up 15 guardians
plus a pending recovery, asserts none of it sits in instance storage, and
prints `record_spend` CPU and memory (`cargo test -p globe-wallet bench_ --
--nocapture`). On v1 the same instance load included roughly 15 × 2 addresses
plus the proposal on every call. On v2 that cost is zero for `send` and
`record_spend`.
