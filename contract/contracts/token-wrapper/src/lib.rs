#![no_std]

//! # token-wrapper
//!
//! Thin wrapper around the Soroban token interface that adds
//! allowance-gated transfers for the GlobeWallet protocol.
//! Enables the globe-wallet contract to move tokens on behalf
//! of users who have granted a per-session allowance.
//!
//! ## Authorization model (issue #174)
//! Allowances are scoped to `(owner, spender, token_id)`: approving a
//! spender for one token grants nothing for any other token. The wrapper is
//! a **bookkeeping** layer, not a delegated-spending layer — it does not hold
//! a SAC allowance of its own, so the underlying `token.transfer(from, ..)`
//! still requires `from`'s authorization. Concretely, for
//! `globe-wallet::send` the user signs one auth tree covering `send` and the
//! nested token `transfer`; the wallet contract (the `spender`) is
//! authorized implicitly as the direct caller. Session-key style delegated
//! spending (owner does not sign each transfer) is out of scope and is
//! documented in `contract/docs/design/token-wrapper-auth-model.md`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, Symbol,
};

// Named WrapperDataKey rather than DataKey: globe-wallet links this crate,
// so this type lands in globe-wallet's contract spec too, and two types
// called DataKey break the generated TypeScript bindings. Only variant
// names are stored on-chain, so the rename does not change storage keys.
#[contracttype]
pub enum WrapperDataKey {
    /// Legacy `(owner, spender)` allowance that applied to *every* token.
    /// No longer read or written (issue #174): existing entries are inert
    /// and archive on their own TTL, so a legacy approval can never be used
    /// to move a token the owner did not approve. Owners re-approve per
    /// token. Kept only so the variant's discriminant stays stable.
    Allowance(Address, Address),
    /// (owner, spender, token_id) → (amount, expiry_ledger)
    TokenAllowance(Address, Address, Address),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Allowance {
    pub amount: i128,
    pub expiry_ledger: u32,
}

// ── Errors ────────────────────────────────────────────────────────────────────
//
// Code namespace for token-wrapper contract errors. Codes start at 2001,
// reserved range 2001-2999, kept distinct from globe-wallet's WalletError
// range (1001-1030+, see contracts/globe-wallet/src/lib.rs) so a raw
// `Error(Contract, #N)` code is unambiguous about which contract raised it
// without also needing the contract address alongside it.

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum WrapperError {
    AllowanceExpired = 2001,
    InsufficientAllowance = 2002,
    InvalidAmount = 2003,
    InvalidExpiry = 2004,
}

#[contract]
pub struct TokenWrapper;

#[contractimpl]
impl TokenWrapper {
    /// Grant a spender allowance over the caller's tokens.
    ///
    /// **Overwrite semantics:** calling `approve` for an existing
    /// `(owner, spender)` pair **replaces** the previous allowance
    /// wholesale — it does **not** add to the remaining balance.
    /// If a spender has already used part of their allowance and
    /// the owner calls `approve` again, the new `amount` becomes the
    /// *total* allowance, not an increment on top of what's left.
    ///
    /// The allowance applies to `token_id` only (issue #174).
    ///
    /// `expiry_ledger` must be in the future.
    pub fn approve(
        env: Env,
        owner: Address,
        spender: Address,
        token_id: Address,
        amount: i128,
        expiry_ledger: u32,
    ) -> Result<(), WrapperError> {
        owner.require_auth();
        if amount < 0 {
            return Err(WrapperError::InvalidAmount);
        }
        if expiry_ledger <= env.ledger().sequence() {
            return Err(WrapperError::InvalidExpiry);
        }
        let key = WrapperDataKey::TokenAllowance(owner.clone(), spender.clone(), token_id.clone());
        env.storage()
            .persistent()
            .set(&key, &Allowance { amount, expiry_ledger });
        // Allowance carries an explicit `expiry_ledger` contract; storage TTL
        // must never expire *before* that ledger or the allowance would vanish
        // early through archival rather than through its own stated semantics.
        let extend_to = expiry_ledger.saturating_sub(env.ledger().sequence());
        env.storage().persistent().extend_ttl(&key, extend_to, extend_to);
        env.events().publish(
            (Symbol::new(&env, "approved"),),
            (owner, spender, token_id, amount, expiry_ledger),
        );
        Ok(())
    }

    /// Return current allowance for (owner, spender, token_id).
    pub fn allowance(env: Env, owner: Address, spender: Address, token_id: Address) -> Allowance {
        let key = WrapperDataKey::TokenAllowance(owner, spender, token_id);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or(Allowance { amount: 0, expiry_ledger: 0 })
    }

    /// Transfer tokens from `from` to `to` using a previously granted allowance.
    ///
    /// Decrements the `(from, spender, token_id)` allowance; fails if expired
    /// or insufficient. An allowance granted for a different token never
    /// applies (`InsufficientAllowance`, issue #174).
    /// An allowance is usable through and including its `expiry_ledger`.
    pub fn transfer_from(
        env: Env,
        spender: Address,
        token_id: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), WrapperError> {
        spender.require_auth();
        if amount <= 0 {
            return Err(WrapperError::InvalidAmount);
        }
        let key = WrapperDataKey::TokenAllowance(from.clone(), spender.clone(), token_id.clone());
        let current: Allowance = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Allowance { amount: 0, expiry_ledger: 0 });
        if current.amount == 0 && current.expiry_ledger == 0 {
            return Err(WrapperError::InsufficientAllowance);
        }
        if current.expiry_ledger < env.ledger().sequence() {
            return Err(WrapperError::AllowanceExpired);
        }
        if current.amount < amount {
            return Err(WrapperError::InsufficientAllowance);
        }
        let new_allowance = Allowance {
            amount: current.amount - amount,
            expiry_ledger: current.expiry_ledger,
        };
        env.storage().persistent().set(&key, &new_allowance);
        let extend_to = current.expiry_ledger.saturating_sub(env.ledger().sequence());
        env.storage().persistent().extend_ttl(&key, extend_to, extend_to);
        let token_client = token::Client::new(&env, &token_id);
        token_client.transfer(&from, &to, &amount);
        env.events().publish(
            (Symbol::new(&env, "transfer_from"),),
            (spender, token_id, from, to, amount),
        );
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn create_token_contract<'a>(
        env: &Env,
        admin: &Address,
    ) -> (Address, token::StellarAssetClient<'a>, token::Client<'a>) {
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let address = sac.address();
        (
            address.clone(),
            token::StellarAssetClient::new(env, &address),
            token::Client::new(env, &address),
        )
    }

    fn setup() -> (Env, Address, TokenWrapperClient<'static>) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let id = env.register_contract(None, TokenWrapper);
        let client = TokenWrapperClient::new(&env, &id);
        (env, id, client)
    }

    #[test]
    fn test_approve_and_allowance() {
        let (env, _id, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let token_id = Address::generate(&env);
        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.approve(&owner, &spender, &token_id, &1_000, &200);
        let a = client.allowance(&owner, &spender, &token_id);
        assert_eq!(a.amount, 1_000);
        assert_eq!(a.expiry_ledger, 200);
    }

    #[test]
    fn test_allowance_unset_pair_returns_zero() {
        let (env, _id, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let token_id = Address::generate(&env);
        // Cold read: never approved — hits unwrap_or default branch.
        let a = client.allowance(&owner, &spender, &token_id);
        assert_eq!(a.amount, 0);
        assert_eq!(a.expiry_ledger, 0);
    }

    #[test]
    fn test_approve_negative_amount_fails() {
        let (env, _id, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let token_id = Address::generate(&env);
        env.ledger().with_mut(|l| l.sequence_number = 100);
        assert_eq!(
            client.try_approve(&owner, &spender, &token_id, &-1, &200),
            Err(Ok(WrapperError::InvalidAmount))
        );
    }

    #[test]
    fn test_approve_past_expiry_fails() {
        let (env, _id, client) = setup();
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let token_id = Address::generate(&env);
        env.ledger().with_mut(|l| l.sequence_number = 100);
        assert_eq!(
            client.try_approve(&owner, &spender, &token_id, &1_000, &50),
            Err(Ok(WrapperError::InvalidExpiry))
        );
    }

    #[test]
    fn test_approve_overwrites_previous_allowance() {
        let (env, _id, client) = setup();
        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let to = Address::generate(&env);
        let (token_id, token_admin, _token) = create_token_contract(&env, &admin);
        token_admin.mint(&owner, &1_000);

        // Grant 500 allowance and spend 300, leaving 200 remaining.
        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.approve(&owner, &spender, &token_id, &500, &300);
        client.transfer_from(&spender, &token_id, &owner, &to, &300);
        let remaining = client.allowance(&owner, &spender, &token_id);
        assert_eq!(remaining.amount, 200);

        // Calling approve again replaces (not adds to) the allowance.
        client.approve(&owner, &spender, &token_id, &500, &400);
        let a = client.allowance(&owner, &spender, &token_id);
        assert_eq!(a.amount, 500); // NOT 700 — overwrite, not additive
        assert_eq!(a.expiry_ledger, 400);
    }

    #[test]
    fn test_transfer_from_happy_path() {
        let (env, _id, client) = setup();
        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let to = Address::generate(&env);
        let (token_id, token_admin, token) = create_token_contract(&env, &admin);
        token_admin.mint(&owner, &1_000);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.approve(&owner, &spender, &token_id, &500, &200);
        client.transfer_from(&spender, &token_id, &owner, &to, &300);

        assert_eq!(token.balance(&owner), 700);
        assert_eq!(token.balance(&to), 300);
        let remaining = client.allowance(&owner, &spender, &token_id);
        assert_eq!(remaining.amount, 200);
    }

    #[test]
    fn test_transfer_from_insufficient_allowance_fails() {
        let (env, _id, client) = setup();
        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let to = Address::generate(&env);
        let (token_id, token_admin, _token) = create_token_contract(&env, &admin);
        token_admin.mint(&owner, &1_000);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.approve(&owner, &spender, &token_id, &100, &200);
        assert_eq!(
            client.try_transfer_from(&spender, &token_id, &owner, &to, &300),
            Err(Ok(WrapperError::InsufficientAllowance))
        );
    }

    #[test]
    fn test_transfer_from_expired_allowance_fails() {
        let (env, _id, client) = setup();
        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let to = Address::generate(&env);
        let (token_id, token_admin, _token) = create_token_contract(&env, &admin);
        token_admin.mint(&owner, &1_000);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.approve(&owner, &spender, &token_id, &500, &150);
        env.ledger().with_mut(|l| l.sequence_number = 200);
        assert_eq!(
            client.try_transfer_from(&spender, &token_id, &owner, &to, &100),
            Err(Ok(WrapperError::AllowanceExpired))
        );
    }

    #[test]
    fn test_transfer_from_zero_amount_fails() {
        let (env, _id, client) = setup();
        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let to = Address::generate(&env);
        let (token_id, _token_admin, _token) = create_token_contract(&env, &admin);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        assert_eq!(
            client.try_transfer_from(&spender, &token_id, &owner, &to, &0),
            Err(Ok(WrapperError::InvalidAmount))
        );
    }

    #[test]
    fn test_transfer_from_rolls_back_allowance_when_underlying_transfer_fails() {
        // issue #38: `transfer_from` persists the debited allowance *before*
        // calling into the underlying token contract's `transfer`. If that
        // underlying call itself fails (e.g. the owner's real balance is
        // less than the amount being moved, even though it's within the
        // allowance this contract tracks), Soroban's atomic transaction
        // semantics roll back *all* state changes from the failed
        // invocation, including the allowance write made earlier in the
        // same call. This test locks in that expectation: the allowance
        // read afterward must show the original, pre-attempt value, proving
        // the storage write was rolled back rather than left partially
        // applied.
        let (env, _id, client) = setup();
        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let to = Address::generate(&env);
        let (token_id, token_admin, token) = create_token_contract(&env, &admin);
        // Owner has only 100 real tokens...
        token_admin.mint(&owner, &100);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        // ...but is approved for far more (500), so transfer_from's own
        // allowance check passes and it proceeds to persist the debited
        // allowance before calling the underlying token contract.
        client.approve(&owner, &spender, &token_id, &500, &200);

        // Attempt to move 300 — passes the allowance check (500 >= 300) but
        // exceeds the owner's real underlying balance (100), so the token
        // contract's own `transfer` call fails.
        assert!(client
            .try_transfer_from(&spender, &token_id, &owner, &to, &300)
            .is_err());

        // The allowance must still read the ORIGINAL, pre-attempt value.
        let a = client.allowance(&owner, &spender, &token_id);
        assert_eq!(a.amount, 500);
        assert_eq!(a.expiry_ledger, 200);
        // And no tokens actually moved.
        assert_eq!(token.balance(&owner), 100);
        assert_eq!(token.balance(&to), 0);
    }

    #[test]
    fn test_transfer_from_succeeds_exactly_at_expiry_ledger() {
        let (env, _id, client) = setup();
        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let to = Address::generate(&env);
        let (token_id, token_admin, _token) = create_token_contract(&env, &admin);
        token_admin.mint(&owner, &1_000);
        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.approve(&owner, &spender, &token_id, &500, &200);
        env.ledger().with_mut(|l| l.sequence_number = 200); // exactly at expiry_ledger
        client.transfer_from(&spender, &token_id, &owner, &to, &100); // currently succeeds — lock this in explicitly
    }

    #[test]
    fn test_allowance_for_token_a_cannot_move_token_b() {
        // issue #174: approving a spender for token A must grant nothing for
        // token B, even though both are held by the same owner.
        let (env, _id, client) = setup();
        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let to = Address::generate(&env);
        let (token_a, token_a_admin, _ta) = create_token_contract(&env, &admin);
        let (token_b, token_b_admin, token_b_client) = create_token_contract(&env, &admin);
        token_a_admin.mint(&owner, &1_000);
        token_b_admin.mint(&owner, &1_000);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.approve(&owner, &spender, &token_a, &500, &200);

        assert_eq!(
            client.try_transfer_from(&spender, &token_b, &owner, &to, &100),
            Err(Ok(WrapperError::InsufficientAllowance))
        );
        assert_eq!(token_b_client.balance(&owner), 1_000);
        assert_eq!(client.allowance(&owner, &spender, &token_b).amount, 0);
        // Token A's allowance is untouched by the rejected attempt.
        assert_eq!(client.allowance(&owner, &spender, &token_a).amount, 500);
    }

    #[test]
    fn test_allowances_are_independent_per_token() {
        let (env, _id, client) = setup();
        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let to = Address::generate(&env);
        let (token_a, token_a_admin, _ta) = create_token_contract(&env, &admin);
        let (token_b, token_b_admin, _tb) = create_token_contract(&env, &admin);
        token_a_admin.mint(&owner, &1_000);
        token_b_admin.mint(&owner, &1_000);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.approve(&owner, &spender, &token_a, &300, &200);
        client.approve(&owner, &spender, &token_b, &50, &200);
        client.transfer_from(&spender, &token_a, &owner, &to, &300);

        assert_eq!(client.allowance(&owner, &spender, &token_a).amount, 0);
        assert_eq!(client.allowance(&owner, &spender, &token_b).amount, 50);
        assert_eq!(
            client.try_transfer_from(&spender, &token_b, &owner, &to, &51),
            Err(Ok(WrapperError::InsufficientAllowance))
        );
    }

    #[test]
    fn test_transfer_from_auth_tree_requires_spender_and_owner() {
        // issue #174: documents exactly who signs. The wrapper is bookkeeping
        // only, so the SAC transfer nested inside transfer_from still needs
        // `from`'s authorization in addition to the spender's.
        use soroban_sdk::testutils::AuthorizedFunction;

        let (env, id, client) = setup();
        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let to = Address::generate(&env);
        let (token_id, token_admin, _token) = create_token_contract(&env, &admin);
        token_admin.mint(&owner, &1_000);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.approve(&owner, &spender, &token_id, &500, &200);
        client.transfer_from(&spender, &token_id, &owner, &to, &100);

        let auths = env.auths();
        // The spender authorizes the wrapper call itself.
        assert!(auths.iter().any(|(addr, inv)| addr == &spender
            && matches!(
                &inv.function,
                AuthorizedFunction::Contract((contract, func, _))
                    if contract == &id && func == &Symbol::new(&env, "transfer_from")
            )));
        // The owner must authorize the nested SAC transfer.
        assert!(auths.iter().any(|(addr, inv)| addr == &owner
            && matches!(
                &inv.function,
                AuthorizedFunction::Contract((contract, func, _))
                    if contract == &token_id && func == &Symbol::new(&env, "transfer")
            )));
    }

    #[test]
    fn test_approve_requires_owner_auth() {
        // Negative path: without mocked auth, approve must fail.
        let env = Env::default();
        let id = env.register_contract(None, TokenWrapper);
        let client = TokenWrapperClient::new(&env, &id);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let token_id = Address::generate(&env);
        env.ledger().with_mut(|l| l.sequence_number = 100);
        assert!(client.try_approve(&owner, &spender, &token_id, &10, &200).is_err());
    }
}
