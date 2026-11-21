# Mainnet Launch Checklist and Staged Rollout Plan

**GitHub issue:** [#239](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/239)

## Overview

Only a testnet deployment exists today. Mainnet launch requires audits, risk
limits, monitoring, and a tested rollback plan. This document is the canonical
checklist; every item must be checked off and linked to evidence (PR, audit
report, or runbook) before launch proceeds.

---

## Pre-launch checklist

### Security

- [ ] System-wide threat model reviewed and signed off by two maintainers (see [threat-model.md](threat-model.md), #238).
- [ ] Exhaustive route authorization matrix passing in CI with zero unclassified routes (see [backend/docs/security/authz-matrix.md](../backend/docs/security/authz-matrix.md), #233).
- [ ] Nightly Toxiproxy chaos suite passing across Horizon, Soroban RPC, Postgres, and Redis (see [backend/docs/chaos-testing.md](../backend/docs/chaos-testing.md), #234).
- [ ] Independent smart-contract audit completed; all critical and high findings
      resolved or accepted with documented rationale.
- [ ] Bug bounty program live for at least 4 weeks on testnet before mainnet
      deploy; scope, rewards, and contact published at `/security.txt`.
- [ ] Dependency audit: `cargo audit` and `npm audit` clean; no unpatched CVEs
      in direct or transitive deps.
- [ ] Secrets rotation: all testnet keys, API tokens, and seed phrases rotated;
      new mainnet credentials in the secrets manager, not in `.env` or VCS.
- [ ] Admin multisig configured; no single key can upgrade or pause the contract
      unilaterally.
- [ ] Recovery guardian set reviewed; guardians are independent and distributed.

### Contract readiness

- [ ] Reproducible build verified (see [reproducible-contract-builds.md](reproducible-contract-builds.md)):
      on-chain WASM hash matches signed release manifest.
- [ ] Global value-at-risk caps configured for guarded launch (see
      [global-value-at-risk-caps.md](global-value-at-risk-caps.md)).
- [ ] Recovery proposal expiry deployed and tested (see
      [recovery-proposal-expiry.md](recovery-proposal-expiry.md)).
- [ ] All contract state changes emit events.
- [ ] Contract deployed with `--wasm-hash` verified against CI artifact.
- [ ] `contract/deployments/mainnet.json` committed with contract ID, WASM hash,
      and deploy ledger.

### Infrastructure

- [ ] Mainnet environment variables set in deployment platform (Render /
      `render.yaml` mainnet service); no testnet passphrase or horizon URL.
- [ ] `assertNetworkConfigurationMatches()` passes on mainnet boot (see
      [network-safety.md](network-safety.md)).
- [ ] Redis and Postgres provisioned for mainnet; network-scoped key prefixes
      confirmed (`orbit-wal:mainnet:...`).
- [ ] Database migrations applied to mainnet schema; rollback migration tested
      in staging.
- [ ] TLS and CORS configured for production domain; no wildcard origins.
- [ ] Rate limiting and DDoS protection in place upstream.

### Observability

- [ ] Alerting on `global_cap_exceeded` event (page on-call immediately).
- [ ] Alerting on anomalous send volume (> 2× 7-day rolling average in any hour).
- [ ] Alerting on backend error rate > 1 % (5-minute window).
- [ ] Dashboards for TVL, daily send volume, active accounts, and error rates
      deployed and accessible to on-call.
- [ ] Log retention ≥ 90 days on mainnet; logs do not contain private keys or
      full seed phrases.
- [ ] On-call rotation documented and staffed for the first 30 days post-launch.

### Operational readiness

- [ ] Incident runbooks written and reviewed (see [Runbooks](#runbooks) below).
- [ ] Rollback plan rehearsed (see [Rollback procedure](#rollback-procedure) below).
- [ ] Futurenet dry run completed (see [Staged rollout](#staged-rollout) below).
- [ ] Comms plan agreed: who announces, on which channels, at what time.

---

## Staged rollout

### Stage 1 — Futurenet dry run

Deploy the full mainnet configuration to Futurenet. Run the end-to-end test
suite against it. Confirm:

- Deployment script succeeds without manual intervention.
- `verify-deployment.sh` passes.
- Monitoring and alerting fire correctly on synthetic load.
- At least one full incident runbook is exercised (simulated contract pause).

**Gate:** dry run completed with no blocking issues; sign-off from at least two
engineers.

### Stage 2 — Guarded mainnet (soft launch)

Deploy to mainnet with conservative global caps:

| Token | Daily global cap | Notes |
|---|---|---|
| XLM | 100 000 XLM | Raise in 2× increments post-audit |
| USDC | 50 000 USDC | Same |

Invite a closed group of beta users (internal team + community volunteers).
Monitor for 2 weeks before moving to stage 3.

**Gate:** no critical incidents in 2 weeks; cap utilisation consistently below
50 %; all P0/P1 bugs resolved.

### Stage 3 — Public launch

Remove invitation gate. Raise global caps per the schedule agreed with the
security team. Publish the audit report and bug bounty results.

---

## Runbooks

### RB-01 — Pause the contract

Use when: active exploit, anomalous drain, or unrecoverable on-chain state.

```bash
# 1. Page on-call and open an incident channel.
# 2. Pause sends via admin multisig:
soroban contract invoke \
  --id $CONTRACT_ID \
  --network mainnet \
  -- pause_sends

# 3. Confirm pause event emitted on-chain.
# 4. Update status page within 5 minutes.
# 5. Do NOT resume without a post-mortem and sign-off from two engineers.
```

### RB-02 — Lower global cap urgently

Use when: suspicious send volume approaching the cap but no confirmed exploit.

```bash
soroban contract invoke \
  --id $CONTRACT_ID \
  --network mainnet \
  -- propose_global_cap \
  --asset-code XLM \
  --cap 10000000000   # 1 000 XLM — cap reductions take effect immediately
```

Confirm `global_cap_applied` event and that `GET /api/v1/contract/global-caps`
reflects the new value.

### RB-03 — Backend rollback

```bash
# Roll back to previous Docker image tag in Render:
# 1. Open the Render dashboard for the mainnet service.
# 2. Navigate to Deploys → select the last green deploy → "Re-deploy".
# 3. Confirm health check passes on /api/v1/health.
# 4. If Postgres migration must also be rolled back, run:
npm run db:rollback --env=mainnet
# (always test rollback migration in staging first)
```

### RB-04 — Rogue recovery proposal

If a guardian opens a rogue recovery proposal:

1. Alert all other guardians immediately.
2. Gather votes against using `vote_against_recovery` until `blocking_threshold`
   is reached (proposal auto-cancels).
3. If quorum for the rogue proposal is reached before guardians can act, the
   proposal still cannot execute until `RECOVERY_DELAY_LEDGERS` have elapsed —
   use that window to coordinate.
4. After cancellation, open an honest proposal and collect quorum.

---

## Rollback procedure

If a critical issue is found within the first 48 hours of public launch:

1. Pause sends (RB-01).
2. Roll back the backend service (RB-03).
3. Assess whether the contract itself needs to be replaced. Contract upgrades
   require the admin multisig and a new audit of the patch.
4. Communicate on status page and community channels within 15 minutes of the
   decision to roll back.
5. Write a post-mortem within 72 hours; publish a sanitised version publicly.

---

## References

- Deployment manifest: [`contract/deployments/testnet.json`](../contract/deployments/testnet.json)
- Render config: [`render.yaml`](../render.yaml)
- [Network safety](network-safety.md)
- [Reproducible contract builds](reproducible-contract-builds.md)
- [Global value-at-risk caps](global-value-at-risk-caps.md)
- [Recovery proposal expiry](recovery-proposal-expiry.md)
- [Observability and tracing](observability-tracing.md)
- [SLIs and SLOs](slis-and-slos.md)
