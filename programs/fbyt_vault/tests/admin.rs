mod common;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn admin_modify_fee_ok_and_rejects_bad_fee_and_wrong_admin() {
    let mut env = boot();
    let admin_pool = inject_admin_pool(&mut env);

    let mut args = Vec::new();
    args.extend_from_slice(&5_000_000u64.to_le_bytes()); // creation_fee
    args.extend_from_slice(&1000u16.to_le_bytes()); // protocol_performance_fee
    args.extend_from_slice(&1000u16.to_le_bytes()); // protocol_money_management_fee
    args.extend_from_slice(&2_000_000u64.to_le_bytes()); // trading_fee
    args.extend_from_slice(&1200u16.to_le_bytes()); // money_management_yearly_fee_max
    args.extend_from_slice(&1800u16.to_le_bytes()); // performance_fee_max
    let admin = env.admin.insecure_clone();
    let metas = vec![
        meta(admin.pubkey(), true, true),
        meta(admin_pool, false, true),
    ];
    // POSITIVE
    send(
        &mut env,
        build_instruction(ix_disc("admin_modify_fee"), args.clone(), metas.clone()),
        &[&admin],
    )
    .expect("modify_fee ok");
    assert_eq!(
        read_admin_pool(&env).creation_fee,
        5_000_000,
        "creation_fee updated"
    );

    // NEGATIVE 1: fee bps > 10000 -> InvalidFee
    let mut bad_args = Vec::new();
    bad_args.extend_from_slice(&1u64.to_le_bytes());
    bad_args.extend_from_slice(&20000u16.to_le_bytes()); // > 10000
    bad_args.extend_from_slice(&1u16.to_le_bytes());
    bad_args.extend_from_slice(&1u64.to_le_bytes());
    bad_args.extend_from_slice(&1u16.to_le_bytes());
    bad_args.extend_from_slice(&1u16.to_le_bytes());
    let error = send(
        &mut env,
        build_instruction(ix_disc("admin_modify_fee"), bad_args, metas.clone()),
        &[&admin],
    )
    .unwrap_err();
    assert!(
        error.contains("InvalidFee") || error.contains("6010") || error.contains("6062"),
        "expected InvalidFee, got: {error}"
    );

    // NEGATIVE 2: wrong admin signer -> authorization violation
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let attacker_metas = vec![
        meta(attacker.pubkey(), true, true),
        meta(admin_pool, false, true),
    ];
    let error = send(
        &mut env,
        build_instruction(ix_disc("admin_modify_fee"), args, attacker_metas),
        &[&attacker],
    )
    .unwrap_err();
    assert!(
        error.contains("InvalidAdmin"),
        "expected InvalidAdmin, got: {error}"
    );
}

#[test]
fn admin_update_max_slippage_bps_bounds() {
    let mut env = boot();
    let admin_pool = inject_admin_pool(&mut env);
    let admin = env.admin.insecure_clone();
    let metas = vec![
        meta(admin.pubkey(), true, true),
        meta(admin_pool, false, true),
    ];
    // POSITIVE
    send(
        &mut env,
        build_instruction(
            ix_disc("admin_update_max_slippage_bps"),
            500u16.to_le_bytes().to_vec(),
            metas.clone(),
        ),
        &[&admin],
    )
    .expect("ok");
    assert_eq!(read_admin_pool(&env).max_slippage_bps, 500);
    // NEGATIVE: > 10000 -> InvalidBps
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("admin_update_max_slippage_bps"),
            10001u16.to_le_bytes().to_vec(),
            metas,
        ),
        &[&admin],
    )
    .unwrap_err();
    assert!(
        error.contains("InvalidBps") || error.contains("6069"),
        "expected InvalidBps, got: {error}"
    );
}

#[test]
fn ownership_transfer_then_accept() {
    let mut env = boot();
    let admin_pool = inject_admin_pool(&mut env);
    let admin = env.admin.insecure_clone();
    let new_admin = Keypair::new();
    env.svm.airdrop(&new_admin.pubkey(), 1_000_000_000).unwrap();

    // transfer_ownership: [admin(signer,mut), pending_admin(mut), admin_pool(mut)]
    let transfer_metas = vec![
        meta(admin.pubkey(), true, true),
        meta(new_admin.pubkey(), false, true),
        meta(admin_pool, false, true),
    ];
    send(
        &mut env,
        build_instruction(ix_disc("admin_transfer_ownership"), vec![], transfer_metas),
        &[&admin],
    )
    .expect("transfer ok");
    assert_eq!(read_admin_pool(&env).pending_admin, new_admin.pubkey());

    // NEGATIVE: wrong pending accepts -> authorization violation
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let attacker_metas = vec![
        meta(attacker.pubkey(), true, true),
        meta(admin_pool, false, true),
    ];
    let error = send(
        &mut env,
        build_instruction(ix_disc("admin_accept_ownership"), vec![], attacker_metas),
        &[&attacker],
    )
    .unwrap_err();
    // a wrong pending admin is the dedicated InvalidPendingAdmin (6065), not the generic InvalidAdmin
    assert!(
        error.contains("InvalidPendingAdmin"),
        "expected InvalidPendingAdmin, got: {error}"
    );

    // POSITIVE: real pending accepts
    let accept_metas = vec![
        meta(new_admin.pubkey(), true, true),
        meta(admin_pool, false, true),
    ];
    send(
        &mut env,
        build_instruction(ix_disc("admin_accept_ownership"), vec![], accept_metas),
        &[&new_admin],
    )
    .expect("accept ok");
    let view = read_admin_pool(&env);
    assert_eq!(view.admin, new_admin.pubkey(), "admin rotated");
    assert_eq!(view.pending_admin, SYSTEM, "pending cleared");
}
