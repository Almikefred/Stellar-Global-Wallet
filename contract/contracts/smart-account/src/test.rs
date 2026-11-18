#![cfg(test)]
extern crate std;

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    auth::{Context, ContractContext},
    testutils::{Address as _, Ledger as _},
    vec, Address, BytesN, Env, IntoVal, Map, Symbol, Vec,
};

const DAY: u64 = 86_400;

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn pk(env: &Env, k: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &k.verifying_key().to_bytes())
}

fn sign(env: &Env, k: &SigningKey, payload: &BytesN<32>) -> Signature {
    Signature {
        public_key: pk(env, k),
        signature: BytesN::from_array(env, &k.sign(&payload.to_array()).to_bytes()),
    }
}

struct Setup {
    env: Env,
    account: Address,
    client: SmartAccountClient<'static>,
    owner: SigningKey,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 10 * DAY);
    let account = env.register_contract(None, SmartAccount);
    let client = SmartAccountClient::new(&env, &account);
    let owner = key(1);
    client.init(&pk(&env, &owner), &None);
    Setup { env, account, client, owner }
}

fn transfer_ctx(env: &Env, token: &Address, from: &Address, amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(env, "transfer"),
        args: vec![
            env,
            from.into_val(env),
            Address::generate(env).into_val(env),
            amount.into_val(env),
        ],
    })
}

fn payload(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

fn check(
    s: &Setup,
    signers: &[&SigningKey],
    contexts: Vec<Context>,
) -> Result<(), Result<AccError, soroban_sdk::InvokeError>> {
    let p = payload(&s.env, 7);
    let mut sigs: std::vec::Vec<Signature> = signers.iter().map(|k| sign(&s.env, k, &p)).collect();
    sigs.sort_by(|a, b| a.public_key.cmp(&b.public_key));
    let mut v = Vec::new(&s.env);
    for sig in sigs {
        v.push_back(sig);
    }
    s.env
        .try_invoke_contract_check_auth::<AccError>(&s.account, &p, v.into_val(&s.env), &contexts)
}

// ── Root signer ──────────────────────────────────────────────────────────────

#[test]
fn owner_signature_authorizes() {
    let s = setup();
    let token = Address::generate(&s.env);
    assert_eq!(check(&s, &[&s.owner], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 5)]), Ok(()));
}

#[test]
fn unknown_signer_rejected() {
    let s = setup();
    let stranger = key(9);
    assert_eq!(
        check(&s, &[&stranger], Vec::new(&s.env)),
        Err(Ok(AccError::UnknownSigner))
    );
}

#[test]
fn empty_signatures_rejected() {
    let s = setup();
    let v: Vec<Signature> = Vec::new(&s.env);
    assert_eq!(
        s.env.try_invoke_contract_check_auth::<AccError>(
            &s.account,
            &payload(&s.env, 1),
            v.into_val(&s.env),
            &Vec::new(&s.env)
        ),
        Err(Ok(AccError::NoSignatures))
    );
}

#[test]
fn forged_signature_rejected() {
    let s = setup();
    let p = payload(&s.env, 7);
    // Valid signature, but over a different payload.
    let sig = sign(&s.env, &s.owner, &payload(&s.env, 8));
    let res = s.env.try_invoke_contract_check_auth::<AccError>(
        &s.account,
        &p,
        vec![&s.env, sig].into_val(&s.env),
        &Vec::new(&s.env),
    );
    assert!(res.is_err());
}

#[test]
fn multisig_threshold_enforced() {
    let s = setup();
    let second = key(2);
    s.client.add_signer(&pk(&s.env, &second));
    s.client.set_threshold(&2);
    assert_eq!(check(&s, &[&s.owner], Vec::new(&s.env)), Err(Ok(AccError::ThresholdNotMet)));
    assert_eq!(check(&s, &[&s.owner, &second], Vec::new(&s.env)), Ok(()));
}

#[test]
fn cannot_remove_last_signer_or_set_bad_threshold() {
    let s = setup();
    assert_eq!(
        s.client.try_remove_signer(&pk(&s.env, &s.owner)),
        Err(Ok(AccError::LastSigner))
    );
    assert_eq!(s.client.try_set_threshold(&2), Err(Ok(AccError::InvalidThreshold)));
    assert_eq!(s.client.try_set_threshold(&0), Err(Ok(AccError::InvalidThreshold)));
}

#[test]
fn init_twice_fails() {
    let s = setup();
    assert_eq!(
        s.client.try_init(&pk(&s.env, &key(5)), &None),
        Err(Ok(AccError::AlreadyInitialized))
    );
}

#[test]
#[should_panic]
fn self_management_requires_account_auth() {
    let env = Env::default();
    let account = env.register_contract(None, SmartAccount);
    let client = SmartAccountClient::new(&env, &account);
    client.init(&pk(&env, &key(1)), &None);
    // No mocked auth: the account's own authorization is missing.
    client.add_signer(&pk(&env, &key(2)));
}

// ── Spend policy in __check_auth ─────────────────────────────────────────────

#[test]
fn daily_limit_enforced_in_check_auth() {
    let s = setup();
    let token = Address::generate(&s.env);
    s.client.set_spend_limit(&token, &100);
    assert_eq!(check(&s, &[&s.owner], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 60)]), Ok(()));
    assert_eq!(s.client.spent_today(&token), 60);
    assert_eq!(
        check(&s, &[&s.owner], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 41)]),
        Err(Ok(AccError::SpendLimitExceeded))
    );
    // Resets on the next UTC day.
    s.env.ledger().with_mut(|l| l.timestamp += DAY);
    assert_eq!(check(&s, &[&s.owner], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 100)]), Ok(()));
}

#[test]
fn transfer_from_someone_else_is_not_counted() {
    let s = setup();
    let token = Address::generate(&s.env);
    s.client.set_spend_limit(&token, &10);
    let other = Address::generate(&s.env);
    assert_eq!(check(&s, &[&s.owner], vec![&s.env, transfer_ctx(&s.env, &token, &other, 1_000)]), Ok(()));
    assert_eq!(s.client.spent_today(&token), 0);
}

#[test]
fn raising_limit_is_timelocked() {
    let s = setup();
    let token = Address::generate(&s.env);
    s.client.set_spend_limit(&token, &100);
    s.client.set_spend_limit(&token, &1_000);
    assert_eq!(s.client.spend_limit(&token), 100);
    assert_eq!(s.client.try_apply_spend_limit(&token), Err(Ok(AccError::LimitNotReady)));
    assert_eq!(
        check(&s, &[&s.owner], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 500)]),
        Err(Ok(AccError::SpendLimitExceeded))
    );
    s.env.ledger().with_mut(|l| l.timestamp += SmartAccount::LIMIT_INCREASE_DELAY);
    s.client.apply_spend_limit(&token);
    assert_eq!(s.client.spend_limit(&token), 1_000);
    // Lowering is immediate.
    s.client.set_spend_limit(&token, &50);
    assert_eq!(s.client.spend_limit(&token), 50);
}

#[test]
fn negative_limit_rejected() {
    let s = setup();
    let token = Address::generate(&s.env);
    assert_eq!(s.client.try_set_spend_limit(&token, &-1), Err(Ok(AccError::InvalidAmount)));
}

// ── Recovery ─────────────────────────────────────────────────────────────────

fn with_guardians(s: &Setup, n: u32, threshold: u32) -> std::vec::Vec<Address> {
    let mut gs = std::vec::Vec::new();
    for _ in 0..n {
        let g = Address::generate(&s.env);
        s.client.add_guardian(&g);
        gs.push(g);
    }
    s.client.set_recovery_config(&threshold, &SmartAccount::MIN_RECOVERY_DELAY);
    gs
}

#[test]
fn lost_key_recovered_by_guardians() {
    let s = setup();
    let token = Address::generate(&s.env);
    s.client.set_spend_limit(&token, &100);
    let gs = with_guardians(&s, 3, 2);
    let new_key = key(42);
    s.client.initiate_recovery(&gs[0], &pk(&s.env, &new_key));
    assert_eq!(s.client.try_execute_recovery(), Err(Ok(AccError::ThresholdNotMet)));
    s.client.approve_recovery(&gs[1]);
    assert_eq!(s.client.try_execute_recovery(), Err(Ok(AccError::RecoveryNotReady)));
    s.env.ledger().with_mut(|l| l.timestamp += SmartAccount::MIN_RECOVERY_DELAY);
    s.client.execute_recovery();

    assert_eq!(s.client.signers(), vec![&s.env, pk(&s.env, &new_key)]);
    assert_eq!(check(&s, &[&s.owner], Vec::new(&s.env)), Err(Ok(AccError::UnknownSigner)));
    // Recovered key sends within the (unchanged) limit.
    assert_eq!(check(&s, &[&new_key], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 100)]), Ok(()));
}

#[test]
fn non_guardian_cannot_initiate_recovery() {
    let s = setup();
    with_guardians(&s, 3, 2);
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.client.try_initiate_recovery(&stranger, &pk(&s.env, &key(3))),
        Err(Ok(AccError::GuardianNotFound))
    );
}

#[test]
fn duplicate_approval_and_short_delay_rejected() {
    let s = setup();
    let gs = with_guardians(&s, 3, 2);
    s.client.initiate_recovery(&gs[0], &pk(&s.env, &key(3)));
    assert_eq!(s.client.try_approve_recovery(&gs[0]), Err(Ok(AccError::AlreadyApproved)));
    assert_eq!(
        s.client.try_set_recovery_config(&2, &1),
        Err(Ok(AccError::RecoveryPending))
    );
    s.client.cancel_recovery();
    assert_eq!(
        s.client.try_set_recovery_config(&2, &1),
        Err(Ok(AccError::RecoveryDelayTooShort))
    );
}

#[test]
fn removed_guardian_approval_dropped() {
    let s = setup();
    let gs = with_guardians(&s, 3, 2);
    s.client.initiate_recovery(&gs[0], &pk(&s.env, &key(3)));
    s.client.remove_guardian(&gs[0]);
    assert_eq!(s.client.recovery().unwrap().approvals.len(), 0);
}

// ── Session keys (issue #182) ────────────────────────────────────────────────

fn session(s: &Setup, k: &SigningKey, allowed: &Address, token: &Address, cap: i128) -> SessionKey {
    let mut caps = Map::new(&s.env);
    caps.set(token.clone(), cap);
    SessionKey {
        public_key: pk(&s.env, k),
        allowed_contracts: vec![&s.env, allowed.clone()],
        allowed_fns: vec![&s.env, Symbol::new(&s.env, "transfer")],
        token_caps: caps,
        expires_at: s.env.ledger().timestamp() + DAY,
    }
}

#[test]
fn session_key_within_scope_authorizes() {
    let s = setup();
    let token = Address::generate(&s.env);
    let sk = key(20);
    s.client.add_session_key(&session(&s, &sk, &token, &token, 50));
    assert_eq!(check(&s, &[&sk], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 30)]), Ok(()));
    assert_eq!(s.client.session_spent(&pk(&s.env, &sk), &token), 30);
    assert_eq!(s.client.session_keys().len(), 1);
}

#[test]
fn session_key_over_cap_rejected() {
    let s = setup();
    let token = Address::generate(&s.env);
    let sk = key(20);
    s.client.add_session_key(&session(&s, &sk, &token, &token, 50));
    assert_eq!(check(&s, &[&sk], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 30)]), Ok(()));
    assert_eq!(
        check(&s, &[&sk], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 21)]),
        Err(Ok(AccError::SessionCapExceeded))
    );
}

#[test]
fn session_key_non_allowed_contract_rejected() {
    let s = setup();
    let token = Address::generate(&s.env);
    let other = Address::generate(&s.env);
    let sk = key(20);
    s.client.add_session_key(&session(&s, &sk, &token, &token, 50));
    assert_eq!(
        check(&s, &[&sk], vec![&s.env, transfer_ctx(&s.env, &other, &s.account, 1)]),
        Err(Ok(AccError::SessionScopeViolation))
    );
}

#[test]
fn session_key_non_allowed_function_rejected() {
    let s = setup();
    let token = Address::generate(&s.env);
    let sk = key(20);
    s.client.add_session_key(&session(&s, &sk, &token, &token, 50));
    let ctx = Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(&s.env, "mint"),
        args: Vec::new(&s.env),
    });
    assert_eq!(check(&s, &[&sk], vec![&s.env, ctx]), Err(Ok(AccError::SessionScopeViolation)));
}

#[test]
fn session_key_cannot_manage_account() {
    let s = setup();
    let token = Address::generate(&s.env);
    let sk = key(20);
    let mut sess = session(&s, &sk, &token, &token, 50);
    sess.allowed_contracts = Vec::new(&s.env);
    sess.allowed_fns = Vec::new(&s.env);
    s.client.add_session_key(&sess);
    let ctx = Context::Contract(ContractContext {
        contract: s.account.clone(),
        fn_name: Symbol::new(&s.env, "add_signer"),
        args: vec![&s.env, pk(&s.env, &sk).into_val(&s.env)],
    });
    assert_eq!(check(&s, &[&sk], vec![&s.env, ctx]), Err(Ok(AccError::SessionScopeViolation)));
}

#[test]
fn session_key_expired_rejected() {
    let s = setup();
    let token = Address::generate(&s.env);
    let sk = key(20);
    s.client.add_session_key(&session(&s, &sk, &token, &token, 50));
    s.env.ledger().with_mut(|l| l.timestamp += DAY);
    assert_eq!(
        check(&s, &[&sk], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 1)]),
        Err(Ok(AccError::SessionExpired))
    );
}

#[test]
fn session_key_still_bound_by_daily_limit() {
    let s = setup();
    let token = Address::generate(&s.env);
    s.client.set_spend_limit(&token, &10);
    let sk = key(20);
    s.client.add_session_key(&session(&s, &sk, &token, &token, 50));
    assert_eq!(
        check(&s, &[&sk], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 20)]),
        Err(Ok(AccError::SpendLimitExceeded))
    );
}

#[test]
fn revoked_session_key_falls_back_to_unknown_signer() {
    let s = setup();
    let token = Address::generate(&s.env);
    let sk = key(20);
    s.client.add_session_key(&session(&s, &sk, &token, &token, 50));
    s.client.revoke_session_key(&pk(&s.env, &sk));
    assert_eq!(s.client.session_keys().len(), 0);
    assert_eq!(
        check(&s, &[&sk], vec![&s.env, transfer_ctx(&s.env, &token, &s.account, 1)]),
        Err(Ok(AccError::UnknownSigner))
    );
    assert_eq!(
        s.client.try_revoke_session_key(&pk(&s.env, &sk)),
        Err(Ok(AccError::SessionNotFound))
    );
}

#[test]
fn invalid_session_records_rejected() {
    let s = setup();
    let token = Address::generate(&s.env);
    let mut sess = session(&s, &key(20), &token, &token, 50);
    sess.expires_at = s.env.ledger().timestamp() + SmartAccount::MAX_SESSION_SECONDS + 1;
    assert_eq!(s.client.try_add_session_key(&sess), Err(Ok(AccError::InvalidSession)));
    // Root signer cannot double as a session key.
    let root = session(&s, &s.owner, &token, &token, 50);
    assert_eq!(s.client.try_add_session_key(&root), Err(Ok(AccError::SignerExists)));
    // Zero cap rejected.
    let zero = session(&s, &key(21), &token, &token, 0);
    assert_eq!(s.client.try_add_session_key(&zero), Err(Ok(AccError::InvalidAmount)));
}

#[test]
fn recovery_revokes_sessions() {
    let s = setup();
    let token = Address::generate(&s.env);
    let sk = key(20);
    s.client.add_session_key(&session(&s, &sk, &token, &token, 50));
    let gs = with_guardians(&s, 2, 2);
    s.client.initiate_recovery(&gs[0], &pk(&s.env, &key(42)));
    s.client.approve_recovery(&gs[1]);
    s.env.ledger().with_mut(|l| l.timestamp += SmartAccount::MIN_RECOVERY_DELAY);
    s.client.execute_recovery();
    assert_eq!(s.client.session_keys().len(), 0);
}
