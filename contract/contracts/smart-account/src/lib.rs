#![no_std]

//! # smart-account
//!
//! Per-user GlobeWallet smart wallet (issue #180): a Soroban *custom account*
//! whose `__check_auth` decides every authorization for the user's address.
//!
//! * **Signers** — ed25519 public keys, M-of-N via `threshold`. Verified with
//!   the host function `env.crypto().ed25519_verify` (issue #183: no crypto
//!   library is linked into the WASM).
//! * **Spend policy** — per-token daily caps enforced *inside* `__check_auth`
//!   by inspecting the auth contexts (`transfer` / `approve` / `burn` calls on
//!   a token where the account is the `from`). Raising or removing a cap is
//!   timelocked so a stolen key cannot lift the limit and drain in one go.
//! * **Social recovery** — guardians (any Soroban address) rotate the
//!   *user's* signer set after M-of-N approval and a timelock. The account
//!   itself can cancel while it still controls a signer.
//! * **Session keys** (issue #182) — scoped ed25519 keys: allowed contracts,
//!   allowed functions, per-token lifetime caps, expiry. Revocable, listable,
//!   and never allowed to call the account itself.
//!
//! Design note: `contract/docs/design/smart-accounts.md`.

use soroban_sdk::{
    auth::{Context, ContractContext, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

// ── Types ────────────────────────────────────────────────────────────────────

/// One signature over the Soroban authorization payload.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Signature {
    pub public_key: BytesN<32>,
    pub signature: BytesN<64>,
}

/// A scoped session key (issue #182).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SessionKey {
    pub public_key: BytesN<32>,
    /// Contracts the key may call. Empty = any contract except the account.
    pub allowed_contracts: Vec<Address>,
    /// Function names the key may call. Empty = any function.
    pub allowed_fns: Vec<Symbol>,
    /// Token contract -> max amount the key may move over its lifetime.
    /// A token missing from the map cannot be moved by the key at all.
    pub token_caps: Map<Address, i128>,
    /// Unix seconds after which the key is rejected.
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingLimit {
    pub limit: i128,
    pub effective_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DailySpent {
    pub amount: i128,
    pub day: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RecoveryConfig {
    pub threshold: u32,
    pub delay_seconds: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RecoveryProposal {
    pub new_signer: BytesN<32>,
    pub approvals: Vec<Address>,
    pub ready_at: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum DataKey {
    /// Instance: ordered signer list (small; read on every `__check_auth`).
    Signers,
    /// Instance: required signer count.
    Threshold,
    /// Instance: factory that deployed the account (upgrade policy).
    Factory,
    /// Instance: guardian recovery config.
    RecoveryConfig,
    /// Persistent: ordered guardian list.
    Guardians,
    /// Persistent: guardian membership flag.
    Guardian(Address),
    /// Persistent: in-flight recovery proposal.
    Recovery,
    /// Persistent: active daily cap per token.
    SpendLimit(Address),
    /// Persistent: timelocked cap increase per token.
    PendingLimit(Address),
    /// Persistent: amount spent in the current UTC day per token.
    Spent(Address),
    /// Persistent: session key record.
    Session(BytesN<32>),
    /// Persistent: list of active session public keys.
    Sessions,
    /// Persistent: lifetime amount moved by a session key per token.
    SessionSpent(BytesN<32>, Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AccError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NoSignatures = 3,
    UnknownSigner = 4,
    /// Signatures must be sorted by public key with no duplicates.
    BadSignatureOrder = 5,
    ThresholdNotMet = 6,
    InvalidThreshold = 7,
    SignerExists = 8,
    SignerNotFound = 9,
    LastSigner = 10,
    SpendLimitExceeded = 11,
    InvalidAmount = 12,
    GuardianExists = 13,
    GuardianNotFound = 14,
    GuardianLimitExceeded = 15,
    RecoveryNotConfigured = 16,
    RecoveryPending = 17,
    NoRecovery = 18,
    AlreadyApproved = 19,
    RecoveryNotReady = 20,
    SessionNotFound = 21,
    SessionExpired = 22,
    /// Session key used outside its allowed contracts/functions, against the
    /// account itself, or for a non-contract context.
    SessionScopeViolation = 23,
    SessionCapExceeded = 24,
    /// A session signature must be the only signature in the payload.
    SessionMixedSignatures = 25,
    InvalidSession = 26,
    SessionExists = 27,
    NoPendingLimit = 28,
    LimitNotReady = 29,
    UpgradeNotApproved = 30,
    RecoveryDelayTooShort = 31,
}

// ── Constants ────────────────────────────────────────────────────────────────

const SECONDS_PER_DAY: u64 = 86_400;
const LEDGERS_PER_DAY: u32 = 17_280;
const TTL_THRESHOLD: u32 = LEDGERS_PER_DAY * 7;
const TTL_EXTEND_TO: u32 = LEDGERS_PER_DAY * 30;

#[contract]
pub struct SmartAccount;

#[contractimpl]
impl SmartAccount {
    pub const MAX_SIGNERS: u32 = 10;
    pub const MAX_GUARDIANS: u32 = 10;
    pub const MAX_SESSIONS: u32 = 20;
    /// Longest a session key may live.
    pub const MAX_SESSION_SECONDS: u64 = 30 * SECONDS_PER_DAY;
    /// Delay before a raised/removed spend cap takes effect.
    pub const LIMIT_INCREASE_DELAY: u64 = SECONDS_PER_DAY;
    /// Minimum recovery timelock.
    pub const MIN_RECOVERY_DELAY: u64 = SECONDS_PER_DAY;

    /// Initialise with one root signer. The factory calls this in the same
    /// transaction as the deploy, so it cannot be front-run.
    pub fn init(env: Env, signer: BytesN<32>, factory: Option<Address>) -> Result<(), AccError> {
        if env.storage().instance().has(&DataKey::Signers) {
            return Err(AccError::AlreadyInitialized);
        }
        let mut signers: Vec<BytesN<32>> = Vec::new(&env);
        signers.push_back(signer.clone());
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage().instance().set(&DataKey::Threshold, &1u32);
        if let Some(f) = &factory {
            env.storage().instance().set(&DataKey::Factory, f);
        }
        Self::bump(&env);
        env.events()
            .publish((Symbol::new(&env, "account_initialized"),), signer);
        Ok(())
    }

    // ── Signers ──────────────────────────────────────────────────────────────

    pub fn signers(env: Env) -> Vec<BytesN<32>> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn threshold(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Threshold).unwrap_or(1)
    }

    pub fn add_signer(env: Env, signer: BytesN<32>) -> Result<(), AccError> {
        Self::require_self(&env)?;
        let mut signers = Self::signers(env.clone());
        if signers.contains(&signer) {
            return Err(AccError::SignerExists);
        }
        if signers.len() >= Self::MAX_SIGNERS {
            return Err(AccError::InvalidThreshold);
        }
        if env.storage().persistent().has(&DataKey::Session(signer.clone())) {
            return Err(AccError::SessionExists);
        }
        signers.push_back(signer.clone());
        env.storage().instance().set(&DataKey::Signers, &signers);
        Self::bump(&env);
        env.events().publish((Symbol::new(&env, "signer_added"),), signer);
        Ok(())
    }

    pub fn remove_signer(env: Env, signer: BytesN<32>) -> Result<(), AccError> {
        Self::require_self(&env)?;
        let signers = Self::signers(env.clone());
        let idx = signers.first_index_of(&signer).ok_or(AccError::SignerNotFound)?;
        if signers.len() <= 1 {
            return Err(AccError::LastSigner);
        }
        if signers.len() - 1 < Self::threshold(env.clone()) {
            return Err(AccError::InvalidThreshold);
        }
        let mut signers = signers;
        signers.remove(idx);
        env.storage().instance().set(&DataKey::Signers, &signers);
        Self::bump(&env);
        env.events()
            .publish((Symbol::new(&env, "signer_removed"),), signer);
        Ok(())
    }

    pub fn set_threshold(env: Env, threshold: u32) -> Result<(), AccError> {
        Self::require_self(&env)?;
        if threshold == 0 || threshold > Self::signers(env.clone()).len() {
            return Err(AccError::InvalidThreshold);
        }
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        Self::bump(&env);
        env.events()
            .publish((Symbol::new(&env, "threshold_set"),), threshold);
        Ok(())
    }

    // ── Spend limits ─────────────────────────────────────────────────────────

    /// Set a daily cap (smallest token unit) for `token`; `0` = unlimited.
    /// Lowering a cap (or setting the first one) is immediate. Raising or
    /// removing one is queued for [`Self::LIMIT_INCREASE_DELAY`] seconds.
    pub fn set_spend_limit(env: Env, token: Address, limit: i128) -> Result<(), AccError> {
        Self::require_self(&env)?;
        if limit < 0 {
            return Err(AccError::InvalidAmount);
        }
        let current = Self::spend_limit(env.clone(), token.clone());
        let tightening = current == 0 && limit > 0 || current > 0 && limit > 0 && limit <= current;
        if tightening {
            Self::set_persistent(&env, &DataKey::SpendLimit(token.clone()), &limit);
            env.storage()
                .persistent()
                .remove(&DataKey::PendingLimit(token.clone()));
            env.events()
                .publish((Symbol::new(&env, "spend_limit_set"), token), limit);
        } else {
            let effective_at = env.ledger().timestamp() + Self::LIMIT_INCREASE_DELAY;
            Self::set_persistent(
                &env,
                &DataKey::PendingLimit(token.clone()),
                &PendingLimit { limit, effective_at },
            );
            env.events().publish(
                (Symbol::new(&env, "spend_limit_queued"), token),
                (limit, effective_at),
            );
        }
        Ok(())
    }

    /// Apply a queued cap increase once its delay has passed. Anyone may call.
    pub fn apply_spend_limit(env: Env, token: Address) -> Result<(), AccError> {
        let pending: PendingLimit = env
            .storage()
            .persistent()
            .get(&DataKey::PendingLimit(token.clone()))
            .ok_or(AccError::NoPendingLimit)?;
        if env.ledger().timestamp() < pending.effective_at {
            return Err(AccError::LimitNotReady);
        }
        Self::apply_pending(&env, &token, &pending);
        Ok(())
    }

    pub fn spend_limit(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::SpendLimit(token))
            .unwrap_or(0)
    }

    pub fn pending_spend_limit(env: Env, token: Address) -> Option<PendingLimit> {
        env.storage().persistent().get(&DataKey::PendingLimit(token))
    }

    pub fn spent_today(env: Env, token: Address) -> i128 {
        let today = env.ledger().timestamp() / SECONDS_PER_DAY;
        let spent: Option<DailySpent> = env.storage().persistent().get(&DataKey::Spent(token));
        match spent {
            Some(s) if s.day == today => s.amount,
            _ => 0,
        }
    }

    // ── Guardians & recovery ─────────────────────────────────────────────────

    pub fn guardians(env: Env) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Guardians)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn add_guardian(env: Env, guardian: Address) -> Result<(), AccError> {
        Self::require_self(&env)?;
        if Self::is_guardian(&env, &guardian) {
            return Err(AccError::GuardianExists);
        }
        let mut guardians = Self::guardians(env.clone());
        if guardians.len() >= Self::MAX_GUARDIANS {
            return Err(AccError::GuardianLimitExceeded);
        }
        guardians.push_back(guardian.clone());
        Self::set_persistent(&env, &DataKey::Guardians, &guardians);
        Self::set_persistent(&env, &DataKey::Guardian(guardian.clone()), &true);
        env.events()
            .publish((Symbol::new(&env, "guardian_added"),), guardian);
        Ok(())
    }

    pub fn remove_guardian(env: Env, guardian: Address) -> Result<(), AccError> {
        Self::require_self(&env)?;
        let mut guardians = Self::guardians(env.clone());
        let idx = guardians
            .first_index_of(&guardian)
            .ok_or(AccError::GuardianNotFound)?;
        if let Some(cfg) = Self::recovery_config(env.clone()) {
            if guardians.len() - 1 < cfg.threshold {
                return Err(AccError::InvalidThreshold);
            }
        }
        guardians.remove(idx);
        Self::set_persistent(&env, &DataKey::Guardians, &guardians);
        env.storage()
            .persistent()
            .remove(&DataKey::Guardian(guardian.clone()));
        // Drop a stale approval so it cannot count toward quorum.
        if let Some(mut p) = Self::recovery(env.clone()) {
            if let Some(i) = p.approvals.first_index_of(&guardian) {
                p.approvals.remove(i);
                Self::set_persistent(&env, &DataKey::Recovery, &p);
            }
        }
        env.events()
            .publish((Symbol::new(&env, "guardian_removed"),), guardian);
        Ok(())
    }

    pub fn set_recovery_config(env: Env, threshold: u32, delay_seconds: u64) -> Result<(), AccError> {
        Self::require_self(&env)?;
        if env.storage().persistent().has(&DataKey::Recovery) {
            return Err(AccError::RecoveryPending);
        }
        if threshold == 0 || threshold > Self::guardians(env.clone()).len() {
            return Err(AccError::InvalidThreshold);
        }
        if delay_seconds < Self::MIN_RECOVERY_DELAY {
            return Err(AccError::RecoveryDelayTooShort);
        }
        env.storage().instance().set(
            &DataKey::RecoveryConfig,
            &RecoveryConfig { threshold, delay_seconds },
        );
        Self::bump(&env);
        env.events().publish(
            (Symbol::new(&env, "recovery_config_set"),),
            (threshold, delay_seconds),
        );
        Ok(())
    }

    pub fn recovery_config(env: Env) -> Option<RecoveryConfig> {
        env.storage().instance().get(&DataKey::RecoveryConfig)
    }

    pub fn recovery(env: Env) -> Option<RecoveryProposal> {
        env.storage().persistent().get(&DataKey::Recovery)
    }

    /// A guardian proposes replacing every signer with `new_signer`.
    pub fn initiate_recovery(env: Env, guardian: Address, new_signer: BytesN<32>) -> Result<(), AccError> {
        guardian.require_auth();
        Self::require_guardian(&env, &guardian)?;
        let cfg = Self::recovery_config(env.clone()).ok_or(AccError::RecoveryNotConfigured)?;
        if env.storage().persistent().has(&DataKey::Recovery) {
            return Err(AccError::RecoveryPending);
        }
        let mut approvals = Vec::new(&env);
        approvals.push_back(guardian.clone());
        let ready_at = Self::ready_at(&env, &cfg, approvals.len());
        Self::set_persistent(
            &env,
            &DataKey::Recovery,
            &RecoveryProposal { new_signer: new_signer.clone(), approvals, ready_at },
        );
        env.events().publish(
            (Symbol::new(&env, "recovery_initiated"),),
            (guardian, new_signer),
        );
        Ok(())
    }

    pub fn approve_recovery(env: Env, guardian: Address) -> Result<(), AccError> {
        guardian.require_auth();
        Self::require_guardian(&env, &guardian)?;
        let cfg = Self::recovery_config(env.clone()).ok_or(AccError::RecoveryNotConfigured)?;
        let mut p = Self::recovery(env.clone()).ok_or(AccError::NoRecovery)?;
        if p.approvals.contains(&guardian) {
            return Err(AccError::AlreadyApproved);
        }
        p.approvals.push_back(guardian.clone());
        if p.ready_at.is_none() {
            p.ready_at = Self::ready_at(&env, &cfg, p.approvals.len());
        }
        Self::set_persistent(&env, &DataKey::Recovery, &p);
        env.events()
            .publish((Symbol::new(&env, "recovery_approved"),), guardian);
        Ok(())
    }

    /// The account (still holding a signer) vetoes a recovery.
    pub fn cancel_recovery(env: Env) -> Result<(), AccError> {
        Self::require_self(&env)?;
        if !env.storage().persistent().has(&DataKey::Recovery) {
            return Err(AccError::NoRecovery);
        }
        env.storage().persistent().remove(&DataKey::Recovery);
        env.events()
            .publish((Symbol::new(&env, "recovery_cancelled"),), ());
        Ok(())
    }

    /// Anyone may execute once quorum is held and the timelock passed.
    /// Replaces all signers, resets threshold to 1 and revokes every session.
    pub fn execute_recovery(env: Env) -> Result<(), AccError> {
        let cfg = Self::recovery_config(env.clone()).ok_or(AccError::RecoveryNotConfigured)?;
        let p = Self::recovery(env.clone()).ok_or(AccError::NoRecovery)?;
        if p.approvals.len() < cfg.threshold {
            return Err(AccError::ThresholdNotMet);
        }
        let ready_at = p.ready_at.ok_or(AccError::RecoveryNotReady)?;
        if env.ledger().timestamp() < ready_at {
            return Err(AccError::RecoveryNotReady);
        }
        let mut signers = Vec::new(&env);
        signers.push_back(p.new_signer.clone());
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage().instance().set(&DataKey::Threshold, &1u32);
        for pk in Self::session_public_keys(&env).iter() {
            env.storage().persistent().remove(&DataKey::Session(pk));
        }
        env.storage().persistent().remove(&DataKey::Sessions);
        env.storage().persistent().remove(&DataKey::Recovery);
        Self::bump(&env);
        env.events().publish(
            (Symbol::new(&env, "recovery_executed"),),
            (p.new_signer, p.approvals),
        );
        Ok(())
    }

    // ── Session keys (issue #182) ────────────────────────────────────────────

    pub fn add_session_key(env: Env, session: SessionKey) -> Result<(), AccError> {
        Self::require_self(&env)?;
        let now = env.ledger().timestamp();
        if session.expires_at <= now || session.expires_at > now + Self::MAX_SESSION_SECONDS {
            return Err(AccError::InvalidSession);
        }
        for (_, cap) in session.token_caps.iter() {
            if cap <= 0 {
                return Err(AccError::InvalidAmount);
            }
        }
        if session.allowed_contracts.contains(&env.current_contract_address()) {
            return Err(AccError::InvalidSession);
        }
        let pk = session.public_key.clone();
        if Self::signers(env.clone()).contains(&pk) {
            return Err(AccError::SignerExists);
        }
        let key = DataKey::Session(pk.clone());
        if env.storage().persistent().has(&key) {
            return Err(AccError::SessionExists);
        }
        let mut list = Self::session_public_keys(&env);
        if list.len() >= Self::MAX_SESSIONS {
            return Err(AccError::InvalidSession);
        }
        list.push_back(pk.clone());
        Self::set_persistent(&env, &DataKey::Sessions, &list);
        Self::set_persistent(&env, &key, &session);
        env.events().publish(
            (Symbol::new(&env, "session_added"),),
            (pk, session.expires_at),
        );
        Ok(())
    }

    pub fn revoke_session_key(env: Env, public_key: BytesN<32>) -> Result<(), AccError> {
        Self::require_self(&env)?;
        let key = DataKey::Session(public_key.clone());
        if !env.storage().persistent().has(&key) {
            return Err(AccError::SessionNotFound);
        }
        env.storage().persistent().remove(&key);
        let mut list = Self::session_public_keys(&env);
        if let Some(i) = list.first_index_of(&public_key) {
            list.remove(i);
        }
        Self::set_persistent(&env, &DataKey::Sessions, &list);
        env.events()
            .publish((Symbol::new(&env, "session_revoked"),), public_key);
        Ok(())
    }

    pub fn session_keys(env: Env) -> Vec<SessionKey> {
        let mut out = Vec::new(&env);
        for pk in Self::session_public_keys(&env).iter() {
            if let Some(s) = env
                .storage()
                .persistent()
                .get::<DataKey, SessionKey>(&DataKey::Session(pk))
            {
                out.push_back(s);
            }
        }
        out
    }

    pub fn session_spent(env: Env, public_key: BytesN<32>, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::SessionSpent(public_key, token))
            .unwrap_or(0)
    }

    // ── Upgrade policy ───────────────────────────────────────────────────────

    /// Self-authorised upgrade. If the account was deployed by a factory, the
    /// factory must list `wasm_hash` as approved (`is_wasm_approved`).
    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) -> Result<(), AccError> {
        Self::require_self(&env)?;
        let factory: Option<Address> = env.storage().instance().get(&DataKey::Factory);
        if let Some(f) = factory {
            let approved: bool = env.invoke_contract(
                &f,
                &Symbol::new(&env, "is_wasm_approved"),
                soroban_sdk::vec![&env, wasm_hash.clone().into_val(&env)],
            );
            if !approved {
                return Err(AccError::UpgradeNotApproved);
            }
        }
        env.events()
            .publish((Symbol::new(&env, "account_upgraded"),), wasm_hash.clone());
        env.deployer().update_current_contract_wasm(wasm_hash);
        Ok(())
    }

    // ── Internals ────────────────────────────────────────────────────────────

    fn require_self(env: &Env) -> Result<(), AccError> {
        if !env.storage().instance().has(&DataKey::Signers) {
            return Err(AccError::NotInitialized);
        }
        env.current_contract_address().require_auth();
        Ok(())
    }

    fn is_guardian(env: &Env, who: &Address) -> bool {
        env.storage().persistent().has(&DataKey::Guardian(who.clone()))
    }

    fn require_guardian(env: &Env, who: &Address) -> Result<(), AccError> {
        if Self::is_guardian(env, who) {
            Ok(())
        } else {
            Err(AccError::GuardianNotFound)
        }
    }

    fn ready_at(env: &Env, cfg: &RecoveryConfig, approvals: u32) -> Option<u64> {
        if approvals >= cfg.threshold {
            Some(env.ledger().timestamp() + cfg.delay_seconds)
        } else {
            None
        }
    }

    fn session_public_keys(env: &Env) -> Vec<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::Sessions)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn set_persistent<V: IntoVal<Env, Val>>(env: &Env, key: &DataKey, value: &V) {
        env.storage().persistent().set(key, value);
        env.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    fn bump(env: &Env) {
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    fn apply_pending(env: &Env, token: &Address, pending: &PendingLimit) {
        Self::set_persistent(env, &DataKey::SpendLimit(token.clone()), &pending.limit);
        env.storage()
            .persistent()
            .remove(&DataKey::PendingLimit(token.clone()));
        env.events().publish(
            (Symbol::new(env, "spend_limit_set"), token.clone()),
            pending.limit,
        );
    }

    /// If `ctx` moves this account's funds, return `(token, amount)`.
    /// Recognises the SEP-41 `transfer(from, to, amount)`,
    /// `approve(from, spender, amount, exp)` and `burn(from, amount)`.
    fn spend_of(env: &Env, ctx: &ContractContext) -> Result<Option<(Address, i128)>, AccError> {
        let amount_idx = if ctx.fn_name == Symbol::new(env, "transfer")
            || ctx.fn_name == Symbol::new(env, "approve")
        {
            2
        } else if ctx.fn_name == Symbol::new(env, "burn") {
            1
        } else {
            return Ok(None);
        };
        let from = match ctx.args.get(0) {
            Some(v) => Address::try_from_val(env, &v).ok(),
            None => None,
        };
        if from != Some(env.current_contract_address()) {
            return Ok(None);
        }
        let raw = ctx.args.get(amount_idx).ok_or(AccError::InvalidAmount)?;
        let amount = i128::try_from_val(env, &raw).map_err(|_| AccError::InvalidAmount)?;
        if amount < 0 {
            return Err(AccError::InvalidAmount);
        }
        Ok(Some((ctx.contract.clone(), amount)))
    }

    /// Daily cap check + bookkeeping for one spend (applies to all signers).
    fn enforce_daily_limit(env: &Env, token: &Address, amount: i128) -> Result<(), AccError> {
        if let Some(pending) = Self::pending_spend_limit(env.clone(), token.clone()) {
            if env.ledger().timestamp() >= pending.effective_at {
                Self::apply_pending(env, token, &pending);
            }
        }
        let limit = Self::spend_limit(env.clone(), token.clone());
        if limit == 0 {
            return Ok(());
        }
        let spent = Self::spent_today(env.clone(), token.clone());
        let total = spent.checked_add(amount).ok_or(AccError::SpendLimitExceeded)?;
        if total > limit {
            return Err(AccError::SpendLimitExceeded);
        }
        let day = env.ledger().timestamp() / SECONDS_PER_DAY;
        Self::set_persistent(
            env,
            &DataKey::Spent(token.clone()),
            &DailySpent { amount: total, day },
        );
        Ok(())
    }

    fn check_session_scope(env: &Env, session: &SessionKey, ctx: &Context) -> Result<(), AccError> {
        let c = match ctx {
            Context::Contract(c) => c,
            _ => return Err(AccError::SessionScopeViolation),
        };
        if c.contract == env.current_contract_address() {
            return Err(AccError::SessionScopeViolation);
        }
        if !session.allowed_contracts.is_empty() && !session.allowed_contracts.contains(&c.contract) {
            return Err(AccError::SessionScopeViolation);
        }
        if !session.allowed_fns.is_empty() && !session.allowed_fns.contains(&c.fn_name) {
            return Err(AccError::SessionScopeViolation);
        }
        if let Some((token, amount)) = Self::spend_of(env, c)? {
            let cap = session
                .token_caps
                .get(token.clone())
                .ok_or(AccError::SessionCapExceeded)?;
            let key = DataKey::SessionSpent(session.public_key.clone(), token);
            let spent: i128 = env.storage().persistent().get(&key).unwrap_or(0);
            let total = spent.checked_add(amount).ok_or(AccError::SessionCapExceeded)?;
            if total > cap {
                return Err(AccError::SessionCapExceeded);
            }
            Self::set_persistent(env, &key, &total);
        }
        Ok(())
    }
}

#[contractimpl]
impl CustomAccountInterface for SmartAccount {
    type Signature = Vec<Signature>;
    type Error = AccError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signatures: Vec<Signature>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccError> {
        let first = signatures.get(0).ok_or(AccError::NoSignatures)?;
        let payload: Bytes = signature_payload.clone().into();

        let session: Option<SessionKey> = env
            .storage()
            .persistent()
            .get(&DataKey::Session(first.public_key.clone()));

        if let Some(session) = session {
            // ── Session-key mode ────────────────────────────────────────────
            if signatures.len() != 1 {
                return Err(AccError::SessionMixedSignatures);
            }
            if env.ledger().timestamp() >= session.expires_at {
                return Err(AccError::SessionExpired);
            }
            env.crypto()
                .ed25519_verify(&first.public_key, &payload, &first.signature);
            for ctx in auth_contexts.iter() {
                Self::check_session_scope(&env, &session, &ctx)?;
            }
        } else {
            // ── Root-signer mode ────────────────────────────────────────────
            let signers = Self::signers(env.clone());
            if signers.is_empty() {
                return Err(AccError::NotInitialized);
            }
            let mut prev: Option<BytesN<32>> = None;
            for sig in signatures.iter() {
                if let Some(p) = &prev {
                    if sig.public_key <= *p {
                        return Err(AccError::BadSignatureOrder);
                    }
                }
                if !signers.contains(&sig.public_key) {
                    return Err(AccError::UnknownSigner);
                }
                env.crypto()
                    .ed25519_verify(&sig.public_key, &payload, &sig.signature);
                prev = Some(sig.public_key.clone());
            }
            if signatures.len() < Self::threshold(env.clone()) {
                return Err(AccError::ThresholdNotMet);
            }
        }

        // ── Spend policy (every signer type) ────────────────────────────────
        for ctx in auth_contexts.iter() {
            if let Context::Contract(c) = &ctx {
                if let Some((token, amount)) = Self::spend_of(&env, c)? {
                    Self::enforce_daily_limit(&env, &token, amount)?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;
