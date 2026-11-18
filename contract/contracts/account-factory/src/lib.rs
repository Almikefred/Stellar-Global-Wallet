#![no_std]

//! # account-factory
//!
//! Deploys one `smart-account` per user at a deterministic address
//! (issue #180). Salt = `sha256(user_id)`, so the backend can compute a
//! user's wallet address before it exists (see
//! `backend/src/services/contracts/smartAccount.ts`).
//!
//! Creation is admin-gated: if anyone could deploy for any `user_id`, a
//! squatter could claim a victim's deterministic address with their own
//! signer. The factory also owns the per-wallet upgrade policy: an account
//! deployed here only accepts WASM hashes listed by `is_wasm_approved`.

use smart_account::SmartAccountClient;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Bytes, BytesN, Env, Symbol,
};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum DataKey {
    Admin,
    /// WASM hash new accounts are deployed from.
    AccountWasm,
    /// Persistent: WASM hashes accounts may upgrade to.
    ApprovedWasm(BytesN<32>),
    /// Persistent: deployed account per salt.
    Account(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum FactoryError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    AccountExists = 4,
    EmptyUserId = 5,
}

const LEDGERS_PER_DAY: u32 = 17_280;
const TTL_THRESHOLD: u32 = LEDGERS_PER_DAY * 7;
const TTL_EXTEND_TO: u32 = LEDGERS_PER_DAY * 30;

#[contract]
pub struct AccountFactory;

#[contractimpl]
impl AccountFactory {
    pub fn initialize(env: Env, admin: Address, account_wasm: BytesN<32>) -> Result<(), FactoryError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(FactoryError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::AccountWasm, &account_wasm);
        Self::set_approved(&env, &account_wasm, true);
        Self::bump(&env);
        env.events()
            .publish((Symbol::new(&env, "factory_initialized"),), (admin, account_wasm));
        Ok(())
    }

    pub fn admin(env: Env) -> Result<Address, FactoryError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FactoryError::NotInitialized)
    }

    /// Salt for a user id: `sha256(user_id)`.
    pub fn salt(env: Env, user_id: Bytes) -> BytesN<32> {
        env.crypto().sha256(&user_id).to_bytes()
    }

    /// Deterministic address of `user_id`'s account (deployed or not).
    pub fn account_address(env: Env, user_id: Bytes) -> Address {
        let salt = Self::salt(env.clone(), user_id);
        env.deployer().with_current_contract(salt).deployed_address()
    }

    /// Deploy and initialise `user_id`'s account with one root signer.
    pub fn create_account(env: Env, user_id: Bytes, signer: BytesN<32>) -> Result<Address, FactoryError> {
        let admin = Self::admin(env.clone())?;
        admin.require_auth();
        if user_id.is_empty() {
            return Err(FactoryError::EmptyUserId);
        }
        let salt = Self::salt(env.clone(), user_id);
        let key = DataKey::Account(salt.clone());
        if env.storage().persistent().has(&key) {
            return Err(FactoryError::AccountExists);
        }
        let wasm: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::AccountWasm)
            .ok_or(FactoryError::NotInitialized)?;
        let address = env.deployer().with_current_contract(salt).deploy(wasm);
        SmartAccountClient::new(&env, &address).init(&signer, &Some(env.current_contract_address()));
        env.storage().persistent().set(&key, &address);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        Self::bump(&env);
        env.events()
            .publish((Symbol::new(&env, "account_created"),), (address.clone(), signer));
        Ok(address)
    }

    /// Change the WASM new accounts are deployed from (also approves it).
    pub fn set_account_wasm(env: Env, wasm: BytesN<32>) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::AccountWasm, &wasm);
        Self::set_approved(&env, &wasm, true);
        env.events()
            .publish((Symbol::new(&env, "account_wasm_set"),), wasm);
        Ok(())
    }

    pub fn approve_wasm(env: Env, wasm: BytesN<32>) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        Self::set_approved(&env, &wasm, true);
        env.events().publish((Symbol::new(&env, "wasm_approved"),), wasm);
        Ok(())
    }

    pub fn revoke_wasm(env: Env, wasm: BytesN<32>) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        Self::set_approved(&env, &wasm, false);
        env.events().publish((Symbol::new(&env, "wasm_revoked"),), wasm);
        Ok(())
    }

    pub fn is_wasm_approved(env: Env, wasm: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::ApprovedWasm(wasm))
    }

    fn require_admin(env: &Env) -> Result<(), FactoryError> {
        let admin = Self::admin(env.clone())?;
        admin.require_auth();
        Ok(())
    }

    fn set_approved(env: &Env, wasm: &BytesN<32>, approved: bool) {
        let key = DataKey::ApprovedWasm(wasm.clone());
        if approved {
            env.storage().persistent().set(&key, &true);
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        } else {
            env.storage().persistent().remove(&key);
        }
    }

    fn bump(env: &Env) {
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Bytes, BytesN, Env};

    fn setup() -> (Env, Address, AccountFactoryClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, AccountFactory);
        let client = AccountFactoryClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &BytesN::from_array(&env, &[1; 32]));
        (env, admin, client)
    }

    #[test]
    fn address_is_deterministic_per_user_id() {
        let (env, _admin, client) = setup();
        let alice = Bytes::from_slice(&env, b"user-alice");
        let bob = Bytes::from_slice(&env, b"user-bob");
        assert_eq!(client.account_address(&alice), client.account_address(&alice));
        assert_ne!(client.account_address(&alice), client.account_address(&bob));
        assert_eq!(client.salt(&alice), env.crypto().sha256(&alice).to_bytes());
    }

    #[test]
    fn initial_wasm_is_approved_and_revocable() {
        let (env, _admin, client) = setup();
        let w1 = BytesN::from_array(&env, &[1; 32]);
        let w2 = BytesN::from_array(&env, &[2; 32]);
        assert!(client.is_wasm_approved(&w1));
        assert!(!client.is_wasm_approved(&w2));
        client.approve_wasm(&w2);
        assert!(client.is_wasm_approved(&w2));
        client.revoke_wasm(&w2);
        assert!(!client.is_wasm_approved(&w2));
    }

    #[test]
    fn initialize_twice_fails() {
        let (env, admin, client) = setup();
        assert_eq!(
            client.try_initialize(&admin, &BytesN::from_array(&env, &[3; 32])),
            Err(Ok(FactoryError::AlreadyInitialized))
        );
    }

    #[test]
    fn empty_user_id_rejected() {
        let (env, _admin, client) = setup();
        assert_eq!(
            client.try_create_account(&Bytes::new(&env), &BytesN::from_array(&env, &[9; 32])),
            Err(Ok(FactoryError::EmptyUserId))
        );
    }

    #[test]
    #[should_panic]
    fn approve_wasm_requires_admin_auth() {
        let env = Env::default();
        let id = env.register_contract(None, AccountFactory);
        let client = AccountFactoryClient::new(&env, &id);
        client.initialize(&Address::generate(&env), &BytesN::from_array(&env, &[1; 32]));
        // No mocked auth.
        client.approve_wasm(&BytesN::from_array(&env, &[2; 32]));
    }

    #[test]
    #[should_panic]
    fn create_account_requires_admin_auth() {
        let env = Env::default();
        let id = env.register_contract(None, AccountFactory);
        let client = AccountFactoryClient::new(&env, &id);
        client.initialize(&Address::generate(&env), &BytesN::from_array(&env, &[1; 32]));
        client.create_account(&Bytes::from_slice(&env, b"u"), &BytesN::from_array(&env, &[9; 32]));
    }
}
