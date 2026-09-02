mod common;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const SECONDS_PER_YEAR: u128 = 31_536_000;

#[test]
fn mm_fee_period_gate_auth_and_inkind_split() {
    let mut env = boot();
    // yearly_fee=1000 bps, raise_period=2_592_000, mm_withdraw_period=1_000_000, idle_period=7_776_000.
    // Fresh: last_mm_fee_withdraw_at = created_at + raise_period = BASE+2_592_000; period boundary at
    // BASE+3_592_000. last_trade_at inits to created_at (BASE), which is the NoTradesYet sentinel.
    let live_vault = bootstrap_vault(&mut env);
    // simulate a trade just after the fundraise (last_trade_at != created_at, and recent → not dormant)
    set_vault_last_trade(&mut env, live_vault.vault_pool, (BASE_TIME + 2_592_001) as u64);
    let operator = env.operator.insecure_clone();
    env.svm.airdrop(&operator.pubkey(), 1_000_000_000).unwrap();
    let admin_key = env.admin.pubkey();
    let vault_balance: u128 = 100_000_000;
    let vault_ata = inject_token_account(
        &mut env,
        live_vault.mint,
        live_vault.vault_pool,
        vault_balance as u64,
    );
    let manager_ata = inject_token_account(
        &mut env,
        live_vault.mint,
        live_vault.money_manager.pubkey(),
        0,
    );
    let protocol_ata = inject_token_account(&mut env, live_vault.mint, admin_key, 0);

    let base_metas = vec![
        meta(live_vault.admin_pool, false, false),
        meta(operator.pubkey(), true, true),
        meta(live_vault.vault_pool, false, true),
        meta(live_vault.asset_registry, false, false),
        meta(spl_token_id(), false, false),
        meta(token_2022_id(), false, false),
    ];
    let mut metas_with_route = base_metas.clone();
    metas_with_route.extend_from_slice(&[
        meta(live_vault.mint, false, false),
        meta(vault_ata, false, true),
        meta(manager_ata, false, true),
        meta(protocol_ata, false, true),
    ]);

    // NEGATIVE: before the period boundary (still at BASE_TIME) -> OutsideWithdrawPeriod
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("withdraw_money_management_fee"),
            vec![],
            metas_with_route.clone(),
        ),
        &[&operator],
    )
    .unwrap_err();
    assert!(
        error.contains("OutsideWithdrawPeriod") && !error.contains("Operator"),
        "expected period gate (OutsideWithdrawPeriod), got: {error}"
    );

    // advance past the period boundary (last_mm_fee_withdraw_at = BASE+2_592_000; +2_000_000 elapsed)
    let elapsed_seconds: u128 = 2_000_000;
    let fee_time = BASE_TIME + 2_592_000 + elapsed_seconds as i64;
    set_clock(&mut env, fee_time);

    // NEGATIVE: wrong operator -> InvalidOperator
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let mut attacker_metas = metas_with_route.clone();
    attacker_metas[1] = meta(attacker.pubkey(), true, true);
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("withdraw_money_management_fee"),
            vec![],
            attacker_metas,
        ),
        &[&attacker],
    )
    .unwrap_err();
    assert!(
        error.contains("InvalidOperator"),
        "expected InvalidOperator, got: {error}"
    );

    // POSITIVE: operator withdraws the in-kind streamed fee, split protocol/manager
    send(
        &mut env,
        build_instruction(
            ix_disc("withdraw_money_management_fee"),
            vec![],
            metas_with_route,
        ),
        &[&operator],
    )
    .expect("mm fee ok");
    let total_fee = vault_balance * 1000 * elapsed_seconds / (10_000 * SECONDS_PER_YEAR);
    let admin_fee = total_fee * 2000 / 10_000;
    let manager_fee = total_fee - admin_fee;
    assert!(total_fee > 0, "sanity: nonzero fee");
    assert_eq!(
        token_balance(&env, manager_ata) as u128,
        manager_fee,
        "manager gets fee - protocol cut"
    );
    assert_eq!(
        token_balance(&env, protocol_ata) as u128,
        admin_fee,
        "protocol gets its cut"
    );
    assert_eq!(
        token_balance(&env, vault_ata) as u128,
        vault_balance - total_fee,
        "vault debited total fee"
    );
    assert_eq!(
        vault_last_management_fee_at(&env, live_vault.vault_pool),
        fee_time as u64,
        "accrual clock advanced"
    );
}
