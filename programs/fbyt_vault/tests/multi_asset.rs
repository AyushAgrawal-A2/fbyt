mod common;
use common::*;
use solana_address::Address;
use solana_instruction::account_meta::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;

const ASSET2_FEED: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";

/// A second asset acquired into the vault via a dummy_swap: base -> asset2.
struct SecondAsset { mint: Address, oracle: Address, price: Address, vault_ata: Address }

/// Acquire `output_amount` of a new asset2 (@ $1.00) into the vault, spending `input_amount` base.
/// Registers asset2 and leaves the vault holding it.
// dummy_swap does not exist in the deployed program (removed), so we set up the second-asset holding
// by direct state injection: register asset2, credit the vault its asset2 balance, and debit the base
// leg — the same observable vault state a base->asset2 trade would leave.
fn add_second_asset(env: &mut Env, live_vault: &LiveVault, input_base: u64, output_asset2: u64) -> SecondAsset {
    let mint = inject_mint(env, 6);
    let oracle = approved_oracle(env, live_vault.admin_pool, mint, ASSET2_FEED);
    let price = inject_price_update(env, ASSET2_FEED, 100_000_000, -8, BASE_TIME); // $1.00
    let vault_base_ata = get_ata(live_vault.vault_pool, live_vault.mint);
    let base_now = token_balance(env, vault_base_ata);
    inject_token_account(env, live_vault.mint, live_vault.vault_pool, base_now - input_base);
    let vault_ata = inject_token_account(env, mint, live_vault.vault_pool, output_asset2);
    inject_registry_with_asset(env, program_id(), live_vault.vault_pool, mint);
    set_vault_last_trade(env, live_vault.vault_pool, BASE_TIME as u64);
    SecondAsset { mint, oracle, price, vault_ata }
}

/// base-only deposit_token_fund metas (no per-asset remaining-account legs).
fn base_deposit_metas(live_vault: &LiveVault, investor: Address, investor_pool: Address, investor_ata: Address, vault_base_ata: Address) -> Vec<AccountMeta> {
    vec![
        meta(investor, true, true), meta(live_vault.admin_pool, false, false), meta(live_vault.vault_pool, false, true),
        meta(live_vault.asset_registry, false, true), meta(investor_pool, false, true), meta(live_vault.oracle_pool, false, true),
        meta(investor_ata, false, true), meta(vault_base_ata, false, true), meta(live_vault.mint, false, true),
        meta(live_vault.price_update, false, false), meta(spl_token_id(), false, false), meta(SYSTEM, false, false),
    ]
}

// Deposit share pricing is against the tracked cost basis `raised_amount_usd`, NOT the vault's live
// holdings (verified vs the deployed program). This test proves the vault's asset2 holdings — which
// would raise a holdings-based NAV to 165e6 and dilute the depositor to ~90.9M shares — are IGNORED:
// the second deposit is priced 1:1 on raised (150e6) and mints the full 100e6 shares. Equivalently,
// a raw token donation to a vault ATA cannot inflate the share price.
#[test]
fn deposit_prices_on_raised_not_holdings() {
    let mut env = boot();
    let live_vault = bootstrap_vault(&mut env);

    // investor #1: first deposit 100 base ($150) -> 100e6 shares, raised 150e6, vault base ATA = 100e6
    let investor1 = Keypair::new(); env.svm.airdrop(&investor1.pubkey(), 5_000_000_000).unwrap();
    let investor1_pool = make_investor_pool(&mut env, &live_vault, &investor1);
    let investor1_ata = inject_token_account(&mut env, live_vault.mint, investor1.pubkey(), 100_000_000);
    let vault_base_ata = inject_token_account(&mut env, live_vault.mint, live_vault.vault_pool, 0);
    send(&mut env, build_instruction(ix_disc("deposit_token_fund"), 100_000_000u64.to_le_bytes().to_vec(),
        base_deposit_metas(&live_vault, investor1.pubkey(), investor1_pool, investor1_ata, vault_base_ata)), &[&investor1]).expect("first deposit");
    assert_eq!(vault_total_shares(&env, live_vault.vault_pool), 100_000_000);

    // acquire asset2: spend 10 base, receive 30 asset2 ($30). vault: base 90e6, asset2 30e6.
    // A holdings-NAV would now be 90*1.5 + 30*1.0 = 165e6; raised_amount_usd stays 150e6.
    let asset2 = add_second_asset(&mut env, &live_vault, 10_000_000, 30_000_000);
    assert_eq!(token_balance(&env, vault_base_ata), 90_000_000, "base spent on swap");
    assert_eq!(token_balance(&env, asset2.vault_ata), 30_000_000, "asset2 acquired");
    assert_eq!(registry_len(&env, live_vault.asset_registry), 1, "asset2 registered");

    // investor #2 deposits 100 base ($150) with EMPTY remaining_accounts (no asset legs).
    // shares = amount_usd(150e6) * total_shares(100e6) / raised(150e6) = 100_000_000 (1:1, holdings ignored).
    let investor2 = Keypair::new(); env.svm.airdrop(&investor2.pubkey(), 5_000_000_000).unwrap();
    let investor2_pool = make_investor_pool(&mut env, &live_vault, &investor2);
    let investor2_ata = inject_token_account(&mut env, live_vault.mint, investor2.pubkey(), 100_000_000);
    send(&mut env, build_instruction(ix_disc("deposit_token_fund"), 100_000_000u64.to_le_bytes().to_vec(),
        base_deposit_metas(&live_vault, investor2.pubkey(), investor2_pool, investor2_ata, vault_base_ata)), &[&investor2]).expect("second deposit");

    assert_eq!(investor_shares(&env, investor2_pool), 100_000_000, "shares priced on raised (1:1), NOT the 165e6 holdings NAV");
    assert_eq!(vault_total_shares(&env, live_vault.vault_pool), 100_000_000 + 100_000_000);
}

// The deposit does NOT read remaining_accounts asset legs — an empty remaining_accounts is accepted
// even when the asset registry is non-empty (verified vs the deployed program, which ACCEPTs it).
#[test]
fn deposit_ignores_registry_asset_legs() {
    let mut env = boot();
    let live_vault = bootstrap_vault(&mut env);
    let investor = Keypair::new(); env.svm.airdrop(&investor.pubkey(), 5_000_000_000).unwrap();
    let investor_pool = make_investor_pool(&mut env, &live_vault, &investor);
    let investor_ata = inject_token_account(&mut env, live_vault.mint, investor.pubkey(), 100_000_000);
    let vault_base_ata = inject_token_account(&mut env, live_vault.mint, live_vault.vault_pool, 0);
    // seed the vault with a first deposit, then register asset2
    send(&mut env, build_instruction(ix_disc("deposit_token_fund"), 50_000_000u64.to_le_bytes().to_vec(),
        base_deposit_metas(&live_vault, investor.pubkey(), investor_pool, investor_ata, vault_base_ata)), &[&investor]).expect("seed deposit");
    add_second_asset(&mut env, &live_vault, 10_000_000, 30_000_000);

    // deposit WITHOUT any asset legs (empty remaining_accounts) is ACCEPTED despite the registered asset2.
    let another = Keypair::new(); env.svm.airdrop(&another.pubkey(), 5_000_000_000).unwrap();
    let another_pool = make_investor_pool(&mut env, &live_vault, &another);
    let another_ata = inject_token_account(&mut env, live_vault.mint, another.pubkey(), 100_000_000);
    send(&mut env, build_instruction(ix_disc("deposit_token_fund"), 50_000_000u64.to_le_bytes().to_vec(),
        base_deposit_metas(&live_vault, another.pubkey(), another_pool, another_ata, vault_base_ata)), &[&another]).expect("deposit with no asset legs is accepted");
    assert!(investor_shares(&env, another_pool) > 0, "shares minted despite empty remaining_accounts");
}

#[test]
fn withdraw_pays_full_basket_with_per_asset_perf_fee() {
    let mut env = boot();
    let live_vault = bootstrap_vault(&mut env);
    let money_manager = live_vault.money_manager.insecure_clone();

    // investor deposits 100 base ($150) -> 150e6 shares (all of them), high-watermark 150e6.
    let investor = Keypair::new(); env.svm.airdrop(&investor.pubkey(), 5_000_000_000).unwrap();
    let investor_pool = make_investor_pool(&mut env, &live_vault, &investor);
    let investor_base_ata = inject_token_account(&mut env, live_vault.mint, investor.pubkey(), 100_000_000);
    let vault_base_ata = inject_token_account(&mut env, live_vault.mint, live_vault.vault_pool, 0);
    let deposit_metas = vec![
        meta(investor.pubkey(),true,true),meta(live_vault.admin_pool,false,false),meta(live_vault.vault_pool,false,true),
        meta(live_vault.asset_registry,false,true),meta(investor_pool,false,true),meta(live_vault.oracle_pool,false,true),
        meta(investor_base_ata,false,true),meta(vault_base_ata,false,true),meta(live_vault.mint,false,true),
        meta(live_vault.price_update,false,false),meta(spl_token_id(),false,false),meta(SYSTEM,false,false),
    ];
    send(&mut env, build_instruction(ix_disc("deposit_token_fund"), 100_000_000u64.to_le_bytes().to_vec(), deposit_metas), &[&investor]).expect("deposit");

    // favorable swap: 10 base ($15) -> 30 asset2 ($30). vault now holds base 90e6 + asset2 30e6.
    let asset2 = add_second_asset(&mut env, &live_vault, 10_000_000, 30_000_000);

    // past cooldown; refresh both oracle prices to the new time
    let withdraw_time = BASE_TIME + 6_480_000 + 10; // raise_period + withdraw_cooldown (cooldown runs from fundraise end)
    set_clock(&mut env, withdraw_time);
    set_price_at(&mut env, live_vault.price_update, FEED, 150_000_000, -8, withdraw_time);        // base $1.50
    set_price_at(&mut env, asset2.price, ASSET2_FEED, 100_000_000, -8, withdraw_time);            // asset2 $1.00

    // investor's receiving ATAs + per-asset fee recipient ATAs
    let investor_asset2_ata = inject_token_account(&mut env, asset2.mint, investor.pubkey(), 0);
    let mm = money_manager.pubkey();
    let base_mgr_fee = inject_token_account(&mut env, live_vault.mint, mm, 0);
    let admin_key = env.admin.pubkey();
    let base_proto_fee = inject_token_account(&mut env, live_vault.mint, admin_key, 0);
    let a2_mgr_fee = inject_token_account(&mut env, asset2.mint, mm, 0);
    let a2_proto_fee = inject_token_account(&mut env, asset2.mint, admin_key, 0);

    let mut metas = vec![
        meta(investor.pubkey(),true,true), meta(mm,false,true), meta(live_vault.admin_pool,false,false),
        meta(live_vault.vault_pool,false,true), meta(live_vault.asset_registry,false,true), meta(investor_pool,false,true),
        meta(spl_token_id(),false,false), meta(token_2022_id(),false,false), meta(SYSTEM,false,false),
    ];
    // group per asset: [oracle, price, mint, vault_ata, investor_ata, manager_fee_ata, protocol_fee_ata]
    metas.extend_from_slice(&[
        meta(live_vault.oracle_pool,false,true), meta(live_vault.price_update,false,false), meta(live_vault.mint,false,false),
        meta(vault_base_ata,false,true), meta(investor_base_ata,false,true), meta(base_mgr_fee,false,true), meta(base_proto_fee,false,true),
        meta(asset2.oracle,false,true), meta(asset2.price,false,false), meta(asset2.mint,false,false),
        meta(asset2.vault_ata,false,true), meta(investor_asset2_ata,false,true), meta(a2_mgr_fee,false,true), meta(a2_proto_fee,false,true),
    ]);
    send(&mut env, build_instruction(ix_disc("withdraw_token_fund"), 100_000_000u64.to_le_bytes().to_vec(), metas), &[&investor]).expect("multi-asset withdraw");

    // NAV = 90*1.5 + 30*1.0 = 165e6 ; hwm = 150e6 ; gain 15e6 ; perf_fee_usd = 2.25e6.
    // base leg (pro 90e6): fee 1_227_272 -> proto 245_454 / mgr 981_818 ; investor 88_772_728.
    assert_eq!(token_balance(&env, investor_base_ata), 88_772_728, "investor base minus perf fee");
    assert_eq!(token_balance(&env, base_mgr_fee), 981_818);
    assert_eq!(token_balance(&env, base_proto_fee), 245_454);
    // asset2 leg (pro 30e6): fee 409_090 -> proto 81_818 / mgr 327_272 ; investor 29_590_910.
    assert_eq!(token_balance(&env, investor_asset2_ata), 29_590_910, "investor asset2 minus perf fee");
    assert_eq!(token_balance(&env, a2_mgr_fee), 327_272);
    assert_eq!(token_balance(&env, a2_proto_fee), 81_818);
    // conservation: each vault leg fully distributed
    assert_eq!(token_balance(&env, vault_base_ata), 0, "vault base drained");
    assert_eq!(token_balance(&env, asset2.vault_ata), 0, "vault asset2 drained");
    assert_eq!(88_772_728 + 981_818 + 245_454, 90_000_000);
    assert_eq!(29_590_910 + 327_272 + 81_818, 30_000_000);
    assert_eq!(vault_total_shares(&env, live_vault.vault_pool), 0, "shares burned");
}
