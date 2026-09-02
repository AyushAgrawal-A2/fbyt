mod common;
use common::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Deposit 100 tokens ($150), then redeem all shares in-kind (no profit -> no perf fee).
fn setup_with_deposit(env: &mut Env) -> (LiveVault, Keypair, Address, Address, Address) {
    let live_vault = bootstrap_vault(env);
    let investor = Keypair::new();
    env.svm.airdrop(&investor.pubkey(), 5_000_000_000).unwrap();
    let investor_pool = make_investor_pool(env, &live_vault, &investor);
    let investor_ata = inject_token_account(env, live_vault.mint, investor.pubkey(), 100_000_000);
    let vault_ata = inject_token_account(env, live_vault.mint, live_vault.vault_pool, 0);
    let deposit_metas = vec![
        meta(investor.pubkey(), true, true),
        meta(live_vault.admin_pool, false, false),
        meta(live_vault.vault_pool, false, true),
        meta(live_vault.asset_registry, false, true),
        meta(investor_pool, false, true),
        meta(live_vault.oracle_pool, false, true),
        meta(investor_ata, false, true),
        meta(vault_ata, false, true),
        meta(live_vault.mint, false, true),
        meta(live_vault.price_update, false, false),
        meta(spl_token_id(), false, false),
        meta(SYSTEM, false, false),
    ];
    send(
        env,
        build_instruction(
            ix_disc("deposit_token_fund"),
            100_000_000u64.to_le_bytes().to_vec(),
            deposit_metas,
        ),
        &[&investor],
    )
    .expect("deposit");
    (live_vault, investor, investor_pool, investor_ata, vault_ata)
}

fn withdraw_metas(
    live_vault: &LiveVault,
    investor: Address,
    investor_pool: Address,
    route: &[solana_instruction::account_meta::AccountMeta],
) -> Vec<solana_instruction::account_meta::AccountMeta> {
    let mut metas = vec![
        meta(investor, true, true),
        meta(live_vault.money_manager.pubkey(), false, true),
        meta(live_vault.admin_pool, false, false),
        meta(live_vault.vault_pool, false, true),
        meta(live_vault.asset_registry, false, true),
        meta(investor_pool, false, true),
        meta(spl_token_id(), false, false),
        meta(token_2022_id(), false, false),
        meta(SYSTEM, false, false),
    ];
    metas.extend_from_slice(route);
    metas
}

#[test]
fn full_redeem_returns_tokens_and_burns_shares() {
    let mut env = boot();
    let (live_vault, investor, investor_pool, investor_ata, vault_ata) =
        setup_with_deposit(&mut env);
    assert_eq!(investor_shares(&env, investor_pool), 100_000_000);
    assert_eq!(token_balance(&env, vault_ata), 100_000_000);

    // pass cooldown (3_888_000) and refresh the oracle price to the new time
    let withdraw_time = BASE_TIME + 6_480_000 + 10; // raise_period + withdraw_cooldown (cooldown runs from fundraise end)
    set_clock(&mut env, withdraw_time);
    set_price_at(
        &mut env,
        live_vault.price_update,
        FEED,
        150_000_000,
        -8,
        withdraw_time,
    );

    let manager_fee_ata = inject_token_account(
        &mut env,
        live_vault.mint,
        live_vault.money_manager.pubkey(),
        0,
    );
    let admin_key = env.admin.pubkey();
    let protocol_fee_ata = inject_token_account(&mut env, live_vault.mint, admin_key, 0);
    let route = vec![
        meta(live_vault.oracle_pool, false, true),
        meta(live_vault.price_update, false, false),
        meta(live_vault.mint, false, false),
        meta(vault_ata, false, true),
        meta(investor_ata, false, true),
        meta(manager_fee_ata, false, true),
        meta(protocol_fee_ata, false, true),
    ];
    send(
        &mut env,
        build_instruction(
            ix_disc("withdraw_token_fund"),
            100_000_000u64.to_le_bytes().to_vec(),
            withdraw_metas(&live_vault, investor.pubkey(), investor_pool, &route),
        ),
        &[&investor],
    )
    .expect("withdraw ok");

    assert_eq!(
        token_balance(&env, investor_ata),
        100_000_000,
        "investor redeemed all tokens (no profit => no perf fee)"
    );
    assert_eq!(token_balance(&env, vault_ata), 0, "vault drained");
    assert_eq!(investor_shares(&env, investor_pool), 0, "shares burned");
    assert_eq!(
        vault_total_shares(&env, live_vault.vault_pool),
        0,
        "vault shares burned"
    );
    assert_eq!(
        token_balance(&env, manager_fee_ata),
        0,
        "no perf fee to manager"
    );
    assert_eq!(
        token_balance(&env, protocol_fee_ata),
        0,
        "no perf fee to protocol"
    );
}

#[test]
fn withdraw_rejects_zero_excess_and_cooldown() {
    let mut env = boot();
    let (live_vault, investor, investor_pool, investor_ata, vault_ata) =
        setup_with_deposit(&mut env);
    let manager_fee_ata = inject_token_account(
        &mut env,
        live_vault.mint,
        live_vault.money_manager.pubkey(),
        0,
    );
    let admin_key = env.admin.pubkey();
    let protocol_fee_ata = inject_token_account(&mut env, live_vault.mint, admin_key, 0);
    let route = vec![
        meta(live_vault.oracle_pool, false, true),
        meta(live_vault.price_update, false, false),
        meta(live_vault.mint, false, false),
        meta(vault_ata, false, true),
        meta(investor_ata, false, true),
        meta(manager_fee_ata, false, true),
        meta(protocol_fee_ata, false, true),
    ];
    // shares = 0 -> ZeroWithdrawShares
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("withdraw_token_fund"),
            0u64.to_le_bytes().to_vec(),
            withdraw_metas(&live_vault, investor.pubkey(), investor_pool, &route),
        ),
        &[&investor],
    )
    .unwrap_err();
    assert!(
        error.contains("ZeroWithdrawShares"),
        "expected ZeroWithdrawShares, got: {error}"
    );
    // requesting more shares than held -> InsufficientFunds (6007)
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("withdraw_token_fund"),
            999_999_999u64.to_le_bytes().to_vec(),
            withdraw_metas(&live_vault, investor.pubkey(), investor_pool, &route),
        ),
        &[&investor],
    )
    .unwrap_err();
    assert!(
        error.contains("InsufficientFunds") || error.contains("Insufficient funds"),
        "expected InsufficientFunds, got: {error}"
    );
    // within cooldown (no warp) -> WithdrawCooldownNotEnded
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("withdraw_token_fund"),
            100_000_000u64.to_le_bytes().to_vec(),
            withdraw_metas(&live_vault, investor.pubkey(), investor_pool, &route),
        ),
        &[&investor],
    )
    .unwrap_err();
    assert!(
        error.contains("WithdrawCooldownNotEnded"),
        "expected WithdrawCooldownNotEnded, got: {error}"
    );
}

#[test]
fn profitable_withdraw_charges_high_watermark_performance_fee() {
    let mut env = boot();
    let (live_vault, investor, investor_pool, investor_ata, vault_ata) = setup_with_deposit(&mut env);
    // deposit was 100 base @ $1.50 -> shares 150e6, high-watermark (cost basis) 150e6 micro-USD.

    // price doubles to $3.00 by withdrawal time (past cooldown); refresh the oracle price.
    let withdraw_time = BASE_TIME + 6_480_000 + 10; // raise_period + withdraw_cooldown (cooldown runs from fundraise end)
    set_clock(&mut env, withdraw_time);
    set_price_at(&mut env, live_vault.price_update, FEED, 300_000_000, -8, withdraw_time); // $3.00

    let manager_fee_ata = inject_token_account(&mut env, live_vault.mint, live_vault.money_manager.pubkey(), 0);
    let admin_key = env.admin.pubkey();
    let protocol_fee_ata = inject_token_account(&mut env, live_vault.mint, admin_key, 0);
    let route = vec![
        meta(live_vault.oracle_pool,false,true), meta(live_vault.price_update,false,false), meta(live_vault.mint,false,false),
        meta(vault_ata,false,true), meta(investor_ata,false,true), meta(manager_fee_ata,false,true), meta(protocol_fee_ata,false,true),
    ];
    send(&mut env, build_instruction(ix_disc("withdraw_token_fund"), 100_000_000u64.to_le_bytes().to_vec(), withdraw_metas(&live_vault, investor.pubkey(), investor_pool, &route)), &[&investor]).expect("withdraw ok");

    // value of the 100 base withdrawn = $300 (300e6 micro-USD); cost basis (hwm) = 150e6; gain = 150e6.
    // perf fee = gain * performance_fee(1500 bps) = 22.5e6 micro-USD = 7.5e6 base tokens @ $3.00.
    //   protocol cut = 7.5e6 * protocol_perf(2000 bps) = 1.5e6 ; manager = 6.0e6 ; investor = 92.5e6.
    assert_eq!(token_balance(&env, investor_ata), 92_500_000, "investor gets tokens minus perf fee");
    assert_eq!(token_balance(&env, manager_fee_ata), 6_000_000, "manager perf-fee cut (80%)");
    assert_eq!(token_balance(&env, protocol_fee_ata), 1_500_000, "protocol perf-fee cut (20%)");
    assert_eq!(token_balance(&env, vault_ata), 0, "vault drained");
    assert_eq!(investor_shares(&env, investor_pool), 0, "shares burned");
}
