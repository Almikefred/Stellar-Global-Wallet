//! Model-based fuzzing of globe-wallet invariants (issue #187).
//!
//! A plain-Rust reference model of the admin / guardian / recovery /
//! spend-limit state machine is driven side by side with the real contract
//! by random call sequences from random callers. After every call we assert:
//!
//! * the call succeeded on the contract iff the model says it should;
//! * the full observable state matches (admin, guardian list, recovery
//!   config + proposal, per-user limit and spent-today);
//! * the invariants listed in `contract/docs/invariants.md` hold.
//!
//! Case count comes from `PROPTEST_CASES` (CI: small and time-boxed; the
//! nightly job runs many more). Failing seeds are persisted by proptest in
//! `tests/model_fuzz.proptest-regressions` — commit that file so the seed is
//! replayed forever.

use globe_wallet::{AssetInfo, GlobeWallet, GlobeWalletClient};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, String,
};

const ACTORS: usize = 6;
const LEDGERS_PER_DAY: u32 = 17_280;
const SECONDS_PER_DAY: u64 = 86_400;
const MAX_GUARDIANS: usize = 15;

#[derive(Clone, Debug)]
enum Op {
    AddGuardian { caller: usize, guardian: usize },
    RemoveGuardian { caller: usize, guardian: usize },
    SetRecoveryConfig { caller: usize, threshold: u32, extra_delay: u32 },
    InitiateRecovery { guardian: usize, new_admin: usize },
    ApproveRecovery { guardian: usize },
    RevokeApproval { guardian: usize },
    ExecuteRecovery,
    CancelRecovery { caller: usize },
    SetSpendLimit { user: usize, limit: i128 },
    RecordSpend { user: usize, amount: i128 },
    AdvanceLedgers(u32),
    AdvanceTime(u64),
}

fn op_strategy() -> impl Strategy<Value = Op> {
    let a = 0..ACTORS;
    prop_oneof![
        (a.clone(), a.clone()).prop_map(|(caller, guardian)| Op::AddGuardian { caller, guardian }),
        (a.clone(), a.clone()).prop_map(|(caller, guardian)| Op::RemoveGuardian { caller, guardian }),
        (a.clone(), 0u32..6, prop_oneof![Just(0u32), 0u32..1_000])
            .prop_map(|(caller, threshold, extra_delay)| Op::SetRecoveryConfig { caller, threshold, extra_delay }),
        (a.clone(), a.clone()).prop_map(|(guardian, new_admin)| Op::InitiateRecovery { guardian, new_admin }),
        a.clone().prop_map(|guardian| Op::ApproveRecovery { guardian }),
        a.clone().prop_map(|guardian| Op::RevokeApproval { guardian }),
        Just(Op::ExecuteRecovery),
        a.clone().prop_map(|caller| Op::CancelRecovery { caller }),
        (a.clone(), prop_oneof![Just(0i128), -5i128..2_000]).prop_map(|(user, limit)| Op::SetSpendLimit { user, limit }),
        (a.clone(), -5i128..800).prop_map(|(user, amount)| Op::RecordSpend { user, amount }),
        // Kept below half a day so the keeper call made after every step
        // (`extend_user_ttl`) always catches entries before they archive.
        (1u32..LEDGERS_PER_DAY / 2).prop_map(Op::AdvanceLedgers),
        (1u64..SECONDS_PER_DAY).prop_map(Op::AdvanceTime),
    ]
}

#[derive(Clone, Debug, PartialEq)]
struct Proposal {
    new_admin: usize,
    approvals: std::vec::Vec<usize>,
    ready_at: Option<u32>,
}

/// Reference model. `bug` lets the self-test inject a deliberate defect to
/// prove the harness notices divergence.
#[derive(Clone, Debug, Default)]
struct Model {
    admin: usize,
    guardians: std::vec::Vec<usize>,
    config: Option<(u32, u32)>,
    proposal: Option<Proposal>,
    limits: [i128; ACTORS],
    /// (amount, day) of the last recorded spend per user.
    spent: [(i128, u64); ACTORS],
    seq: u32,
    ts: u64,
    bug: bool,
}

impl Model {
    fn is_guardian(&self, a: usize) -> bool {
        self.guardians.contains(&a)
    }
    fn day(&self) -> u64 {
        self.ts / SECONDS_PER_DAY
    }
    fn spent_today(&self, u: usize) -> i128 {
        let (amt, day) = self.spent[u];
        if day == self.day() { amt } else { 0 }
    }

    /// Applies `op`; returns whether the contract call should succeed.
    fn apply(&mut self, op: &Op) -> bool {
        match *op {
            Op::AddGuardian { caller, guardian } => {
                if caller != self.admin || self.is_guardian(guardian) || self.guardians.len() >= MAX_GUARDIANS {
                    return false;
                }
                self.guardians.push(guardian);
                true
            }
            Op::RemoveGuardian { caller, guardian } => {
                if caller != self.admin || !self.is_guardian(guardian) {
                    return false;
                }
                if let Some((t, _)) = self.config {
                    if (self.guardians.len() as u32 - 1) < t {
                        return false;
                    }
                }
                self.guardians.retain(|g| *g != guardian);
                if let Some(p) = self.proposal.as_mut() {
                    if p.approvals.contains(&guardian) {
                        p.approvals.retain(|g| *g != guardian);
                        if let Some((t, _)) = self.config {
                            if (p.approvals.len() as u32) < t {
                                p.ready_at = None;
                            }
                        }
                    }
                }
                true
            }
            Op::SetRecoveryConfig { caller, threshold, extra_delay } => {
                if caller != self.admin || self.proposal.is_some() || threshold <= 1 {
                    return false;
                }
                if self.guardians.len() < 3 || threshold as usize > self.guardians.len() {
                    return false;
                }
                // extra_delay == 0 → exactly the minimum; the strategy never
                // goes below it, the dedicated unit tests cover that error.
                self.config = Some((threshold, GlobeWallet::MIN_RECOVERY_DELAY_LEDGERS + extra_delay));
                true
            }
            Op::InitiateRecovery { guardian, new_admin } => {
                if !self.is_guardian(guardian) || self.config.is_none() || self.proposal.is_some() {
                    return false;
                }
                self.proposal = Some(Proposal { new_admin, approvals: vec![guardian], ready_at: None });
                true
            }
            Op::ApproveRecovery { guardian } => {
                if !self.is_guardian(guardian) {
                    return false;
                }
                let Some((t, delay)) = self.config else { return false };
                let seq = self.seq;
                let Some(p) = self.proposal.as_mut() else { return false };
                if p.approvals.contains(&guardian) {
                    return false;
                }
                p.approvals.push(guardian);
                if p.approvals.len() as u32 >= t && p.ready_at.is_none() {
                    p.ready_at = Some(seq.saturating_add(delay));
                }
                true
            }
            Op::RevokeApproval { guardian } => {
                if !self.is_guardian(guardian) {
                    return false;
                }
                let Some((t, _)) = self.config else { return false };
                let Some(p) = self.proposal.as_mut() else { return false };
                if !p.approvals.contains(&guardian) {
                    return false;
                }
                p.approvals.retain(|g| *g != guardian);
                if (p.approvals.len() as u32) < t {
                    p.ready_at = None;
                }
                true
            }
            Op::ExecuteRecovery => {
                let Some((t, _)) = self.config else { return false };
                let Some(p) = self.proposal.clone() else { return false };
                if (p.approvals.len() as u32) < t {
                    return false;
                }
                let Some(ready_at) = p.ready_at else { return false };
                if self.seq < ready_at || p.new_admin == self.admin {
                    return false;
                }
                self.admin = p.new_admin;
                self.proposal = None;
                true
            }
            Op::CancelRecovery { caller } => {
                if caller != self.admin || self.proposal.is_none() {
                    return false;
                }
                self.proposal = None;
                true
            }
            Op::SetSpendLimit { user, limit } => {
                if limit < 0 || (limit != 0 && self.spent_today(user) > limit) {
                    return false;
                }
                self.limits[user] = limit;
                true
            }
            Op::RecordSpend { user, amount } => {
                if amount <= 0 {
                    return false;
                }
                let limit = self.limits[user];
                if limit == 0 {
                    return true;
                }
                let new_spent = self.spent_today(user) + amount;
                let over = if self.bug { new_spent >= limit } else { new_spent > limit };
                if over {
                    return false;
                }
                self.spent[user] = (new_spent, self.day());
                true
            }
            Op::AdvanceLedgers(n) => {
                self.seq += n;
                true
            }
            Op::AdvanceTime(s) => {
                self.ts += s;
                true
            }
        }
    }
}

struct Harness {
    env: Env,
    client: GlobeWalletClient<'static>,
    actors: std::vec::Vec<Address>,
    xlm: String,
}

impl Harness {
    fn new() -> (Self, Model) {
        let env = Env::default();
        env.mock_all_auths();
        env.budget().reset_unlimited();
        let id = env.register_contract(None, GlobeWallet);
        let client = GlobeWalletClient::new(&env, &id);
        let actors: std::vec::Vec<Address> = (0..ACTORS).map(|_| Address::generate(&env)).collect();
        client.initialize(&actors[0]);
        let xlm = String::from_str(&env, "XLM");
        // Register XLM for every actor so `extend_user_ttl` covers their
        // spend entries (it walks the user's asset list).
        for a in &actors {
            client.add_asset(a, &AssetInfo { code: xlm.clone(), issuer: None });
        }
        let model = Model {
            seq: env.ledger().sequence(),
            ts: env.ledger().timestamp(),
            ..Model::default()
        };
        (Self { env, client, actors, xlm }, model)
    }

    fn call(&self, op: &Op) -> bool {
        let c = &self.client;
        let a = &self.actors;
        match *op {
            Op::AddGuardian { caller, guardian } => c.try_add_guardian(&a[caller], &a[guardian]).is_ok(),
            Op::RemoveGuardian { caller, guardian } => c.try_remove_guardian(&a[caller], &a[guardian]).is_ok(),
            Op::SetRecoveryConfig { caller, threshold, extra_delay } => c
                .try_set_recovery_config(&a[caller], &threshold, &(GlobeWallet::MIN_RECOVERY_DELAY_LEDGERS + extra_delay))
                .is_ok(),
            Op::InitiateRecovery { guardian, new_admin } => c.try_initiate_recovery(&a[guardian], &a[new_admin]).is_ok(),
            Op::ApproveRecovery { guardian } => c.try_approve_recovery(&a[guardian]).is_ok(),
            Op::RevokeApproval { guardian } => c.try_revoke_recovery_approval(&a[guardian]).is_ok(),
            Op::ExecuteRecovery => c.try_execute_recovery().is_ok(),
            Op::CancelRecovery { caller } => c.try_cancel_recovery(&a[caller]).is_ok(),
            Op::SetSpendLimit { user, limit } => c.try_set_spend_limit(&a[user], &self.xlm, &limit).is_ok(),
            Op::RecordSpend { user, amount } => c.try_record_spend(&a[user], &self.xlm, &amount).is_ok(),
            Op::AdvanceLedgers(n) => {
                self.env.ledger().with_mut(|l| l.sequence_number += n);
                true
            }
            Op::AdvanceTime(s) => {
                self.env.ledger().with_mut(|l| l.timestamp += s);
                true
            }
        }
    }

    fn idx(&self, addr: &Address) -> usize {
        self.actors.iter().position(|a| a == addr).expect("unknown address in contract state")
    }

    fn assert_matches(&self, m: &Model, step: usize, op: &Op) {
        let c = &self.client;
        // Exactly one admin, and it is the one the model expects.
        assert_eq!(self.idx(&c.admin()), m.admin, "admin diverged at step {step} ({op:?})");
        let guardians: std::vec::Vec<usize> = c.guardians().iter().map(|g| self.idx(&g)).collect();
        assert_eq!(guardians, m.guardians, "guardians diverged at step {step} ({op:?})");
        let cfg = c.recovery_config().map(|r| (r.threshold, r.delay_in_ledgers));
        assert_eq!(cfg, m.config, "recovery config diverged at step {step} ({op:?})");
        let proposal = c.recovery_proposal().map(|p| Proposal {
            new_admin: self.idx(&p.new_admin),
            approvals: p.approvals.iter().map(|g| self.idx(&g)).collect(),
            ready_at: p.ready_at,
        });
        assert_eq!(proposal, m.proposal, "recovery proposal diverged at step {step} ({op:?})");
        if let (Some(p), Some((t, delay))) = (&m.proposal, m.config) {
            // Quorum always arms the timelock; below quorum it is disarmed.
            assert_eq!(p.ready_at.is_some(), p.approvals.len() as u32 >= t, "timelock arming at step {step}");
            if let Some(r) = p.ready_at {
                assert!(r >= delay, "ready_at must include the delay");
            }
        }
        for (u, addr) in self.actors.iter().enumerate() {
            let limit = c.get_spend_limit(addr, &self.xlm);
            let spent = c.get_spent_today(addr, &self.xlm);
            assert_eq!(limit, m.limits[u], "limit diverged for actor {u} at step {step} ({op:?})");
            if limit > 0 {
                // Core invariant: spent today never exceeds the limit.
                assert!(spent <= limit, "spent {spent} > limit {limit} at step {step}");
                assert_eq!(spent, m.spent_today(u), "spent diverged for actor {u} at step {step} ({op:?})");
            }
        }
    }
}

fn run(ops: &[Op], bug: bool) {
    let (h, mut model) = Harness::new();
    model.bug = bug;
    for (step, op) in ops.iter().enumerate() {
        let before_admin = model.admin;
        let expected = model.apply(op);
        let actual = h.call(op);
        assert_eq!(actual, expected, "step {step}: {op:?} contract ok={actual}, model ok={expected}");
        if matches!(op, Op::ExecuteRecovery) && actual {
            // Recovery only executes after quorum + delay (checked in the
            // model's precondition) and always changes the admin.
            assert_ne!(before_admin, model.admin);
        }
        // Keeper (issue #185): keep every per-user entry alive between steps.
        for a in &h.actors {
            h.client.extend_user_ttl(a);
        }
        h.assert_matches(&model, step, op);
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        // Overridden by PROPTEST_CASES in CI / nightly.
        cases: 64,
        max_shrink_iters: 2_000,
        ..ProptestConfig::default()
    })]

    #[test]
    fn contract_matches_reference_model(ops in proptest::collection::vec(op_strategy(), 1..60)) {
        run(&ops, false);
    }
}

/// Seeds a sequence that sets up the guardian/recovery state deterministically
/// so even a tiny CI case budget exercises the full recovery path.
#[test]
fn full_recovery_path_matches_model() {
    let ops = vec![
        Op::AddGuardian { caller: 0, guardian: 1 },
        Op::AddGuardian { caller: 0, guardian: 2 },
        Op::AddGuardian { caller: 0, guardian: 3 },
        Op::SetRecoveryConfig { caller: 0, threshold: 2, extra_delay: 0 },
        Op::InitiateRecovery { guardian: 1, new_admin: 4 },
        Op::ExecuteRecovery, // not quorate
        Op::ApproveRecovery { guardian: 2 },
        Op::ExecuteRecovery, // timelock not elapsed
        Op::AdvanceLedgers(LEDGERS_PER_DAY / 2 - 1),
        Op::AdvanceLedgers(LEDGERS_PER_DAY / 2 - 1),
        Op::AdvanceLedgers(10),
        Op::ExecuteRecovery,
        Op::AddGuardian { caller: 0, guardian: 5 }, // old admin lost control
        Op::AddGuardian { caller: 4, guardian: 5 },
    ];
    run(&ops, false);
}

/// Test plan: an injected bug (off-by-one in the model's limit check) must
/// be caught by the harness.
#[test]
#[should_panic(expected = "model ok")]
fn harness_catches_injected_bug() {
    let ops = vec![
        Op::SetSpendLimit { user: 1, limit: 100 },
        Op::RecordSpend { user: 1, amount: 100 },
    ];
    run(&ops, true);
}
