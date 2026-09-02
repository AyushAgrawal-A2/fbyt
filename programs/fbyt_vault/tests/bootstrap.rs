mod common;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn config_args() -> Vec<u8> {
    let mut args = Vec::new();
    args.extend_from_slice(&2_000_000u64.to_le_bytes()); // creation_fee
    args.extend_from_slice(&2000u16.to_le_bytes()); // protocol_performance_fee
    args.extend_from_slice(&2000u16.to_le_bytes()); // protocol_money_management_fee
    args.extend_from_slice(&1_000_000u64.to_le_bytes()); // trading_fee
    args.extend_from_slice(&1500u16.to_le_bytes()); // money_management_yearly_fee_max
    args.extend_from_slice(&2000u16.to_le_bytes()); // performance_fee_max
    args.extend_from_slice(&3_888_000u64.to_le_bytes()); // withdraw_cooldown_max
    args.extend_from_slice(&2_592_000u64.to_le_bytes()); // fundrising_period_max
    args.extend_from_slice(&10_000u64.to_le_bytes()); // raise_amount_min_usd
    args.extend_from_slice(&10_000u64.to_le_bytes()); // contribution_amount_min_usd
    args.extend_from_slice(&259_200u64.to_le_bytes()); // oracle_max_age
    args.extend_from_slice(&7_776_000u64.to_le_bytes()); // idle_period
    args.extend_from_slice(&10_000u64.to_le_bytes()); // dust_threshold_usd
    args.extend_from_slice(&30u16.to_le_bytes()); // max_asset_count
    args.extend_from_slice(&1000u16.to_le_bytes()); // max_slippage_bps
    args
}

fn build_metas(
    admin: solana_address::Address,
    operator: solana_address::Address,
) -> Vec<solana_instruction::account_meta::AccountMeta> {
    let (admin_pool, _) = admin_pool_pda();
    vec![
        meta(admin, true, true),
        meta(operator, false, true),
        meta(program_id(), false, false),
        meta(program_data_addr(), false, false),
        meta(admin_pool, false, true),
        meta(SYSTEM, false, false),
    ]
}

#[test]
fn create_admin_pool_requires_upgrade_authority() {
    let mut env = boot();
    let admin = env.admin.insecure_clone();
    let operator = env.operator.pubkey();
    env.svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    set_upgrade_authority(&mut env, admin.pubkey());

    // NEGATIVE: a non-upgrade-authority signer -> program_data constraint fails
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("create_admin_pool"),
            config_args(),
            build_metas(attacker.pubkey(), operator),
        ),
        &[&attacker],
    )
    .unwrap_err();
    assert!(
        error.contains("2003") || error.to_lowercase().contains("constraint"),
        "expected raw constraint, got: {error}"
    );

    // NEGATIVE: bad fee (>10000) with the right authority -> InvalidFee
    let mut bad_args = config_args();
    bad_args[8..10].copy_from_slice(&20000u16.to_le_bytes()); // protocol_performance_fee
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("create_admin_pool"),
            bad_args,
            build_metas(admin.pubkey(), operator),
        ),
        &[&admin],
    )
    .unwrap_err();
    assert!(
        error.contains("InvalidFee"),
        "expected InvalidFee, got: {error}"
    );

    // POSITIVE: the upgrade authority bootstraps the admin pool
    send(
        &mut env,
        build_instruction(
            ix_disc("create_admin_pool"),
            config_args(),
            build_metas(admin.pubkey(), operator),
        ),
        &[&admin],
    )
    .expect("create_admin_pool ok");
    let view = read_admin_pool(&env);
    assert_eq!(view.admin, admin.pubkey(), "admin set");
    assert_eq!(view.operator, operator, "operator set");
    assert_eq!(view.creation_fee, 2_000_000);
    assert_eq!(view.max_slippage_bps, 1000);
}
