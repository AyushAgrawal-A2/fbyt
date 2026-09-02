mod common;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn trading_delegate_set_revoke_and_auth() {
    let mut env = boot();
    let live_vault = bootstrap_vault(&mut env);
    let money_manager = live_vault.money_manager.insecure_clone();
    let delegate = Keypair::new().pubkey();

    // NEGATIVE: wrong money_manager sets delegate -> has_one = money_manager
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let attacker_metas = vec![
        meta(live_vault.vault_pool, false, true),
        meta(attacker.pubkey(), true, false),
    ];
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("set_trading_delegate"),
            delegate.as_array().to_vec(),
            attacker_metas,
        ),
        &[&attacker],
    )
    .unwrap_err();
    assert!(
        error.contains("2001") || error.contains("HasOne") || error.contains("money_manager"),
        "expected has_one, got: {error}"
    );

    // POSITIVE: money_manager sets delegate
    let manager_metas = vec![
        meta(live_vault.vault_pool, false, true),
        meta(money_manager.pubkey(), true, false),
    ];
    send(
        &mut env,
        build_instruction(
            ix_disc("set_trading_delegate"),
            delegate.as_array().to_vec(),
            manager_metas.clone(),
        ),
        &[&money_manager],
    )
    .expect("set ok");
    assert_eq!(
        vault_trading_delegate(&env, live_vault.vault_pool),
        delegate
    );

    // POSITIVE: revoke
    send(
        &mut env,
        build_instruction(
            ix_disc("revoke_trading_delegate"),
            vec![],
            manager_metas.clone(),
        ),
        &[&money_manager],
    )
    .expect("revoke ok");
    assert_eq!(vault_trading_delegate(&env, live_vault.vault_pool), SYSTEM);

    // NEGATIVE: revoke again when none set -> NoTradingDelegate
    let error = send(
        &mut env,
        build_instruction(ix_disc("revoke_trading_delegate"), vec![], manager_metas),
        &[&money_manager],
    )
    .unwrap_err();
    assert!(
        error.contains("NoTradingDelegate"),
        "expected NoTradingDelegate, got: {error}"
    );
}

#[test]
fn close_vault_is_idempotent_guarded() {
    let mut env = boot();
    let live_vault = bootstrap_vault(&mut env);
    set_clock(&mut env, BASE_TIME + 2_592_000 + 1); // close is only allowed after the fundraise period
    let money_manager = live_vault.money_manager.insecure_clone();
    let metas = vec![
        meta(live_vault.admin_pool, false, false),
        meta(live_vault.vault_pool, false, true),
        meta(money_manager.pubkey(), true, true),
        meta(live_vault.mint, false, true),
    ];
    assert_eq!(
        vault_status(&env, live_vault.vault_pool),
        1,
        "Active before"
    );
    // POSITIVE
    send(
        &mut env,
        build_instruction(ix_disc("close_vault"), vec![], metas.clone()),
        &[&money_manager],
    )
    .expect("close ok");
    assert_eq!(vault_status(&env, live_vault.vault_pool), 3, "Closed after");
    // NEGATIVE: closing again -> VaultClosed
    let error = send(
        &mut env,
        build_instruction(ix_disc("close_vault"), vec![], metas),
        &[&money_manager],
    )
    .unwrap_err();
    assert!(
        error.contains("VaultClosed"),
        "expected VaultClosed, got: {error}"
    );
}

#[test]
fn get_price_info_ok_and_stale_rejected() {
    let mut env = boot();
    let admin_pool = inject_admin_pool(&mut env);
    set_clock(&mut env, BASE_TIME);
    let payer = env.payer.insecure_clone();
    // POSITIVE: fresh price
    let fresh_price = inject_price_update(&mut env, FEED, 150_000_000, -8, BASE_TIME);
    let mut feed_arg = (FEED.len() as u32).to_le_bytes().to_vec();
    feed_arg.extend_from_slice(FEED.as_bytes());
    let fresh_metas = vec![
        meta(payer.pubkey(), true, true),
        meta(admin_pool, false, false),
        meta(fresh_price, false, true),
        meta(SYSTEM, false, false),
    ];
    send(
        &mut env,
        build_instruction(ix_disc("get_price_info"), feed_arg.clone(), fresh_metas),
        &[&payer],
    )
    .expect("price ok");
    // NEGATIVE: stale price (published far in the past, beyond oracle_max_age=259200)
    let stale_price = inject_price_update(&mut env, FEED, 150_000_000, -8, BASE_TIME - 1_000_000);
    let stale_metas = vec![
        meta(payer.pubkey(), true, true),
        meta(admin_pool, false, false),
        meta(stale_price, false, true),
        meta(SYSTEM, false, false),
    ];
    let error = send(
        &mut env,
        build_instruction(ix_disc("get_price_info"), feed_arg, stale_metas),
        &[&payer],
    )
    .unwrap_err();
    // A stale feed surfaces the raw Pyth error (PriceTooOld, code 16000), not a remapped program error.
    assert!(
        error.contains("PriceTooOld") || error.contains("16000"),
        "expected Pyth PriceTooOld (16000), got: {error}"
    );
}

#[test]
fn create_investor_pool_ok_and_wrong_mint_rejected() {
    let mut env = boot();
    let live_vault = bootstrap_vault(&mut env);
    let investor = Keypair::new();
    env.svm.airdrop(&investor.pubkey(), 5_000_000_000).unwrap();
    let (investor_pool, _) = investor_pool_pda(
        investor.pubkey(),
        live_vault.admin_pool,
        live_vault.vault_pool,
        live_vault.mint,
    );

    // NEGATIVE: wrong token_mint -> vault_pool has_one = token_mint fails
    let wrong_mint = inject_mint(&mut env, 6);
    let (wrong_investor_pool, _) = investor_pool_pda(
        investor.pubkey(),
        live_vault.admin_pool,
        live_vault.vault_pool,
        wrong_mint,
    );
    let wrong_metas = vec![
        meta(investor.pubkey(), true, true),
        meta(live_vault.admin_pool, false, false),
        meta(live_vault.vault_pool, false, true),
        meta(wrong_mint, false, true),
        meta(wrong_investor_pool, false, true),
        meta(SYSTEM, false, false),
    ];
    let error = send(
        &mut env,
        build_instruction(ix_disc("create_investor_pool"), vec![], wrong_metas),
        &[&investor],
    )
    .unwrap_err();
    assert!(
        error.contains("2001") || error.contains("HasOne") || error.contains("token_mint"),
        "expected has_one=token_mint, got: {error}"
    );

    // POSITIVE
    let investor_count_before = vault_investor_count(&env, live_vault.vault_pool);
    let metas = vec![
        meta(investor.pubkey(), true, true),
        meta(live_vault.admin_pool, false, false),
        meta(live_vault.vault_pool, false, true),
        meta(live_vault.mint, false, true),
        meta(investor_pool, false, true),
        meta(SYSTEM, false, false),
    ];
    send(
        &mut env,
        build_instruction(ix_disc("create_investor_pool"), vec![], metas),
        &[&investor],
    )
    .expect("investor pool ok");
    assert_eq!(
        &env.svm.get_account(&investor_pool).unwrap().data[..8],
        &acct_disc("InvestorPool")
    );
    assert_eq!(
        vault_investor_count(&env, live_vault.vault_pool),
        investor_count_before + 1,
        "investor_count incremented"
    );
}
