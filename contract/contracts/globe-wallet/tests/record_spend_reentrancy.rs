use globe_wallet::{GlobeWallet, GlobeWalletClient, WalletError};
use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address, Env};

#[contract]
struct SameInvocationBatcher;

#[contractimpl]
impl SameInvocationBatcher {
    pub fn record_twice(
        env: Env,
        wallet: Address,
        user: Address,
        token_id: Address,
        first: i128,
        second: i128,
    ) {
        let wallet = GlobeWalletClient::new(&env, &wallet);
        wallet.record_spend(&user, &token_id, &first);
        wallet.record_spend(&user, &token_id, &second);
    }
}

#[test]
fn two_spends_in_one_host_invocation_accumulate() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let wallet_id = env.register_contract(None, GlobeWallet);
    let wallet = GlobeWalletClient::new(&env, &wallet_id);
    let batcher_id = env.register_contract(None, SameInvocationBatcher);
    let batcher = SameInvocationBatcherClient::new(&env, &batcher_id);
    let user = Address::generate(&env);
    let token_id = Address::generate(&env);

    wallet.set_spend_limit(&user, &token_id, &1_000_i128);

    // Both calls share one root host invocation. The second call must observe
    // the first call's write rather than overwrite a stale zero value.
    batcher.record_twice(
        &wallet_id,
        &user,
        &token_id,
        &600_i128,
        &400_i128,
    );

    assert_eq!(
        wallet.try_record_spend(&user, &token_id, &1_i128),
        Err(Ok(WalletError::SpendLimitExceeded))
    );
}
