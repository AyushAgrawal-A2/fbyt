mod common;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const FEED_ID: &str = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

fn new_money_manager(env: &mut Env) -> Keypair {
    let money_manager = Keypair::new();
    env.svm
        .airdrop(&money_manager.pubkey(), 50_000_000_000)
        .unwrap();
    money_manager
}

#[test]
fn create_money_manager_pool_ok_and_no_double() {
    let mut env = boot();
    let admin_pool = inject_admin_pool(&mut env);
    let money_manager = new_money_manager(&mut env);
    let (money_manager_pool, _) = money_manager_pool_pda(admin_pool, money_manager.pubkey());
    let metas = vec![
        meta(admin_pool, false, false),
        meta(money_manager.pubkey(), true, true),
        meta(money_manager_pool, false, true),
        meta(SYSTEM, false, false),
    ];
    // POSITIVE
    send(
        &mut env,
        build_instruction(ix_disc("create_money_manager_pool"), vec![], metas.clone()),
        &[&money_manager],
    )
    .expect("create mm ok");
    let account_data = env.svm.get_account(&money_manager_pool).unwrap().data;
    assert_eq!(&account_data[..8], &acct_disc("MoneyManagerPool"));
    assert_eq!(read_u64(&account_data, 73), 0, "vaults_amount starts 0");
    // NEGATIVE: creating the same pool again -> init fails (account already in use)
    let error = send(
        &mut env,
        build_instruction(ix_disc("create_money_manager_pool"), vec![], metas),
        &[&money_manager],
    )
    .unwrap_err();
    assert!(
        error.to_lowercase().contains("already in use") || error.to_lowercase().contains("in use"),
        "expected already-in-use, got: {error}"
    );
}

/// Full path: admin_pool + money_manager_pool + approved oracle + pyth price -> create_vault.
fn setup_vault_prereqs(
    env: &mut Env,
) -> (
    Keypair,
    solana_address::Address,
    solana_address::Address,
    solana_address::Address,
) {
    let admin_pool = inject_admin_pool(env);
    let mint = inject_mint(env, 6);
    let (oracle_pool, _) = oracle_pool_pda(admin_pool, mint);
    let admin = env.admin.insecure_clone();
    // create + approve oracle
    let requester = Keypair::new();
    env.svm.airdrop(&requester.pubkey(), 5_000_000_000).unwrap();
    let create_metas = vec![
        meta(requester.pubkey(), true, true),
        meta(admin_pool, false, true),
        meta(mint, false, true),
        meta(oracle_pool, false, true),
        meta(SYSTEM, false, false),
    ];
    let mut feed = (FEED_ID.len() as u32).to_le_bytes().to_vec();
    feed.extend_from_slice(FEED_ID.as_bytes());
    send(
        env,
        build_instruction(ix_disc("create_oracle_pool"), feed, create_metas),
        &[&requester],
    )
    .expect("oracle create");
    let approve_metas = vec![
        meta(admin.pubkey(), true, true),
        meta(admin_pool, false, true),
        meta(mint, false, true),
        meta(oracle_pool, false, true),
    ];
    send(
        env,
        build_instruction(ix_disc("approve_oracle_pool"), vec![], approve_metas),
        &[&admin],
    )
    .expect("oracle approve");
    // money manager pool
    let money_manager = new_money_manager(env);
    let (money_manager_pool, _) = money_manager_pool_pda(admin_pool, money_manager.pubkey());
    let pool_metas = vec![
        meta(admin_pool, false, false),
        meta(money_manager.pubkey(), true, true),
        meta(money_manager_pool, false, true),
        meta(SYSTEM, false, false),
    ];
    send(
        env,
        build_instruction(ix_disc("create_money_manager_pool"), vec![], pool_metas),
        &[&money_manager],
    )
    .expect("mm pool");
    (money_manager, admin_pool, mint, oracle_pool)
}

fn create_vault_args(money_management_fee: u16, performance_fee: u16) -> Vec<u8> {
    let mut args = Vec::new();
    args.extend_from_slice(&10_000u64.to_le_bytes()); // min_contribute (>= contribution_amount_min_usd)
    args.extend_from_slice(&2_592_000u64.to_le_bytes()); // raise_period (<= fundrising_period_max)
    args.extend_from_slice(&10_000u64.to_le_bytes()); // min_raise (>= raise_amount_min_usd)
    args.extend_from_slice(&1_000_000u64.to_le_bytes()); // mm_withdraw_period
    args.extend_from_slice(&3_888_000u64.to_le_bytes()); // withdraw_cooldown (<= max)
    args.extend_from_slice(&money_management_fee.to_le_bytes());
    args.extend_from_slice(&performance_fee.to_le_bytes());
    args.push(1u8); // is_open_ended
    args
}

#[test]
fn create_vault_ok_charges_fee_and_rejects_bad_params() {
    let mut env = boot();
    set_clock(&mut env, 1_700_000_000);
    let (money_manager, admin_pool, mint, oracle_pool) = setup_vault_prereqs(&mut env);
    let admin = env.admin.insecure_clone();
    let price_update = inject_price_update(&mut env, FEED_ID, 150_000_000, -8, 1_700_000_000);
    let (vault_pool, _) = vault_pool_pda(admin_pool, money_manager.pubkey(), 0);
    let (asset_registry, _) = asset_registry_pda(vault_pool);

    let metas = vec![
        meta(admin_pool, false, true),
        meta(admin.pubkey(), false, true),
        meta(money_manager.pubkey(), true, true),
        meta(
            money_manager_pool_pda(admin_pool, money_manager.pubkey()).0,
            false,
            true,
        ),
        meta(vault_pool, false, true),
        meta(asset_registry, false, true),
        meta(oracle_pool, false, false),
        meta(price_update, false, false),
        meta(mint, false, true),
        meta(SYSTEM, false, false),
    ];
    let admin_lamports_before = lamports(&env, admin.pubkey());
    // POSITIVE
    send(
        &mut env,
        build_instruction(
            ix_disc("create_vault"),
            create_vault_args(1000, 1500),
            metas.clone(),
        ),
        &[&money_manager],
    )
    .expect("create_vault ok");
    let vault_data = env.svm.get_account(&vault_pool).unwrap().data;
    assert_eq!(&vault_data[..8], &acct_disc("VaultPool"));
    assert_eq!(vault_data[145], 1, "vault status Active");
    assert_eq!(
        &env.svm.get_account(&asset_registry).unwrap().data[..8],
        &acct_disc("AssetRegistry")
    );
    assert_eq!(
        lamports(&env, admin.pubkey()) - admin_lamports_before,
        2_000_000,
        "admin received creation_fee"
    );

    // NEGATIVE: money_management_fee > max (1500) -> InvalidFee. index now 1.
    let (second_vault_pool, _) = vault_pool_pda(admin_pool, money_manager.pubkey(), 1);
    let (second_asset_registry, _) = asset_registry_pda(second_vault_pool);
    let second_metas = vec![
        meta(admin_pool, false, true),
        meta(admin.pubkey(), false, true),
        meta(money_manager.pubkey(), true, true),
        meta(
            money_manager_pool_pda(admin_pool, money_manager.pubkey()).0,
            false,
            true,
        ),
        meta(second_vault_pool, false, true),
        meta(second_asset_registry, false, true),
        meta(oracle_pool, false, false),
        meta(price_update, false, false),
        meta(mint, false, true),
        meta(SYSTEM, false, false),
    ];
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("create_vault"),
            create_vault_args(9999, 1500),
            second_metas,
        ),
        &[&money_manager],
    )
    .unwrap_err();
    assert!(
        error.contains("InvalidFee"),
        "expected InvalidFee, got: {error}"
    );
}
