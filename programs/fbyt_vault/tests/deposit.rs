mod common;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn deposit_metas(
    live_vault: &LiveVault,
    investor: solana_address::Address,
    investor_pool: solana_address::Address,
    investor_ata: solana_address::Address,
    vault_ata: solana_address::Address,
) -> Vec<solana_instruction::account_meta::AccountMeta> {
    vec![
        meta(investor, true, true),
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
    ]
}

#[test]
fn first_deposit_mints_shares_equal_to_token_amount() {
    let mut env = boot();
    let live_vault = bootstrap_vault(&mut env);
    let investor = Keypair::new();
    env.svm.airdrop(&investor.pubkey(), 5_000_000_000).unwrap();
    let investor_pool = make_investor_pool(&mut env, &live_vault, &investor);
    // 100 base tokens (6 decimals) @ $1.50 -> $150 = 150_000_000 micro-USD
    let investor_ata =
        inject_token_account(&mut env, live_vault.mint, investor.pubkey(), 100_000_000);
    let vault_ata = inject_token_account(&mut env, live_vault.mint, live_vault.vault_pool, 0);

    send(
        &mut env,
        build_instruction(
            ix_disc("deposit_token_fund"),
            100_000_000u64.to_le_bytes().to_vec(),
            deposit_metas(
                &live_vault,
                investor.pubkey(),
                investor_pool,
                investor_ata,
                vault_ata,
            ),
        ),
        &[&investor],
    )
    .expect("deposit ok");

    assert_eq!(
        token_balance(&env, investor_ata),
        0,
        "investor tokens moved out"
    );
    assert_eq!(
        token_balance(&env, vault_ata),
        100_000_000,
        "vault received tokens"
    );
    assert_eq!(
        investor_shares(&env, investor_pool),
        100_000_000,
        "shares == raw token amount on first deposit"
    );
    assert_eq!(vault_total_shares(&env, live_vault.vault_pool), 100_000_000);
    assert_eq!(
        vault_raised_usd(&env, live_vault.vault_pool),
        150_000_000,
        "raised_amount_usd still tracks the USD value ($150)"
    );
}

#[test]
fn deposit_rejects_zero_below_min_and_inactive_vault() {
    let mut env = boot();
    let live_vault = bootstrap_vault(&mut env);
    let investor = Keypair::new();
    env.svm.airdrop(&investor.pubkey(), 5_000_000_000).unwrap();
    let investor_pool = make_investor_pool(&mut env, &live_vault, &investor);
    let investor_ata =
        inject_token_account(&mut env, live_vault.mint, investor.pubkey(), 100_000_000);
    let vault_ata = inject_token_account(&mut env, live_vault.mint, live_vault.vault_pool, 0);

    // amount = 0 -> InvalidDepositAmount
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("deposit_token_fund"),
            0u64.to_le_bytes().to_vec(),
            deposit_metas(
                &live_vault,
                investor.pubkey(),
                investor_pool,
                investor_ata,
                vault_ata,
            ),
        ),
        &[&investor],
    )
    .unwrap_err();
    assert!(
        error.contains("InvalidDepositAmount"),
        "expected InvalidDepositAmount, got: {error}"
    );

    // below-min amount (1 < min_contribute 10_000) -> InvalidDepositAmount (matches deployed 6011)
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("deposit_token_fund"),
            1u64.to_le_bytes().to_vec(),
            deposit_metas(
                &live_vault,
                investor.pubkey(),
                investor_pool,
                investor_ata,
                vault_ata,
            ),
        ),
        &[&investor],
    )
    .unwrap_err();
    assert!(
        error.contains("InvalidDepositAmount"),
        "expected InvalidDepositAmount, got: {error}"
    );

    // close the vault (only allowed after the fundraise period), then deposit -> VaultNotActive
    set_clock(&mut env, BASE_TIME + 2_592_000 + 1);
    let money_manager = live_vault.money_manager.insecure_clone();
    let close_metas = vec![
        meta(live_vault.admin_pool, false, false),
        meta(live_vault.vault_pool, false, true),
        meta(money_manager.pubkey(), true, true),
        meta(live_vault.mint, false, true),
    ];
    send(
        &mut env,
        build_instruction(ix_disc("close_vault"), vec![], close_metas),
        &[&money_manager],
    )
    .expect("close");
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("deposit_token_fund"),
            100_000_000u64.to_le_bytes().to_vec(),
            deposit_metas(
                &live_vault,
                investor.pubkey(),
                investor_pool,
                investor_ata,
                vault_ata,
            ),
        ),
        &[&investor],
    )
    .unwrap_err();
    assert!(
        error.contains("VaultNotActive"),
        "expected VaultNotActive, got: {error}"
    );
}
