mod common;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const SOL_FEED: &str = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/// A vault whose base mint is native wSOL (9 decimals). wSOL wrap/unwrap is the CLIENT's job
/// (wrap SOL -> wSOL ATA before deposit, unwrap after withdraw); the program treats the vault's
/// base as an ordinary SPL token account, so a wSOL-base vault flows exactly like any other.
/// This also exercises the 9-decimal micro-USD scaling path (net_exponent = 6 + expo - 9).
#[test]
fn native_sol_vault_deposit_and_withdraw_as_spl_wsol() {
    let mut env = boot();
    set_clock(&mut env, BASE_TIME);
    let admin = env.admin.insecure_clone();
    let admin_pool = inject_admin_pool(&mut env);
    inject_mint_at(&mut env, wsol_mint(), 9);           // native wSOL, 9 decimals
    let mint = wsol_mint();

    // oracle for wSOL @ $150.00  (price 150e8, exponent -8)
    let oracle_pool = approved_oracle(&mut env, admin_pool, mint, SOL_FEED);
    let price_update = inject_price_update(&mut env, SOL_FEED, 15_000_000_000, -8, BASE_TIME);

    // money-manager pool + vault (base = wSOL)
    let money_manager = Keypair::new(); env.svm.airdrop(&money_manager.pubkey(), 50_000_000_000).unwrap();
    let (mm_pool, _) = money_manager_pool_pda(admin_pool, money_manager.pubkey());
    send(&mut env, build_instruction(ix_disc("create_money_manager_pool"), vec![],
        vec![meta(admin_pool,false,false),meta(money_manager.pubkey(),true,true),meta(mm_pool,false,true),meta(SYSTEM,false,false)]), &[&money_manager]).unwrap();
    let (vault_pool, _) = vault_pool_pda(admin_pool, money_manager.pubkey(), 0);
    let (asset_registry, _) = asset_registry_pda(vault_pool);
    let mut create_args = Vec::new();
    create_args.extend_from_slice(&10_000u64.to_le_bytes()); create_args.extend_from_slice(&2_592_000u64.to_le_bytes());
    create_args.extend_from_slice(&10_000u64.to_le_bytes()); create_args.extend_from_slice(&1_000_000u64.to_le_bytes());
    create_args.extend_from_slice(&3_888_000u64.to_le_bytes()); create_args.extend_from_slice(&1000u16.to_le_bytes());
    create_args.extend_from_slice(&1500u16.to_le_bytes()); create_args.push(1u8);
    send(&mut env, build_instruction(ix_disc("create_vault"), create_args,
        vec![meta(admin_pool,false,true),meta(admin.pubkey(),false,true),meta(money_manager.pubkey(),true,true),meta(mm_pool,false,true),
             meta(vault_pool,false,true),meta(asset_registry,false,true),meta(oracle_pool,false,false),meta(price_update,false,false),meta(mint,false,true),meta(SYSTEM,false,false)]), &[&money_manager]).unwrap();

    // investor + client-wrapped wSOL ATA holding 1 SOL (1e9). Deposit it.
    let investor = Keypair::new(); env.svm.airdrop(&investor.pubkey(), 5_000_000_000).unwrap();
    let (investor_pool, _) = investor_pool_pda(investor.pubkey(), admin_pool, vault_pool, mint);
    send(&mut env, build_instruction(ix_disc("create_investor_pool"), vec![],
        vec![meta(investor.pubkey(),true,true),meta(admin_pool,false,false),meta(vault_pool,false,true),meta(mint,false,true),meta(investor_pool,false,true),meta(SYSTEM,false,false)]), &[&investor]).unwrap();
    let investor_ata = inject_token_account(&mut env, mint, investor.pubkey(), 1_000_000_000); // 1 wSOL
    let vault_ata = inject_token_account(&mut env, mint, vault_pool, 0);

    let deposit_metas = vec![
        meta(investor.pubkey(),true,true),meta(admin_pool,false,false),meta(vault_pool,false,true),
        meta(asset_registry,false,true),meta(investor_pool,false,true),meta(oracle_pool,false,true),
        meta(investor_ata,false,true),meta(vault_ata,false,true),meta(mint,false,true),
        meta(price_update,false,false),meta(spl_token_id(),false,false),meta(SYSTEM,false,false),
    ];
    send(&mut env, build_instruction(ix_disc("deposit_token_fund"), 1_000_000_000u64.to_le_bytes().to_vec(), deposit_metas), &[&investor]).expect("wSOL deposit");

    // 1 wSOL @ $150 with 9 decimals -> amount_usd = 150_000_000 micro-USD; first deposit shares == that.
    assert_eq!(investor_shares(&env, investor_pool), 1_000_000_000, "first-deposit shares = token amount (1 wSOL); raised_usd tracks $150");
    assert_eq!(token_balance(&env, vault_ata), 1_000_000_000, "vault holds wSOL");
    assert_eq!(token_balance(&env, investor_ata), 0, "investor wSOL moved into vault");

    // withdraw all: past cooldown, refresh price. Investor gets wSOL back (client would then unwrap).
    let withdraw_time = BASE_TIME + 6_480_000 + 10; // raise_period + withdraw_cooldown (cooldown runs from fundraise end)
    set_clock(&mut env, withdraw_time);
    set_price_at(&mut env, price_update, SOL_FEED, 15_000_000_000, -8, withdraw_time);
    let manager_fee_ata = inject_token_account(&mut env, mint, money_manager.pubkey(), 0);
    let protocol_fee_ata = inject_token_account(&mut env, mint, admin.pubkey(), 0);
    let mut withdraw_metas = vec![
        meta(investor.pubkey(),true,true), meta(money_manager.pubkey(),false,true), meta(admin_pool,false,false),
        meta(vault_pool,false,true), meta(asset_registry,false,true), meta(investor_pool,false,true),
        meta(spl_token_id(),false,false), meta(token_2022_id(),false,false), meta(SYSTEM,false,false),
    ];
    withdraw_metas.extend_from_slice(&[
        meta(oracle_pool,false,true), meta(price_update,false,false), meta(mint,false,false),
        meta(vault_ata,false,true), meta(investor_ata,false,true), meta(manager_fee_ata,false,true), meta(protocol_fee_ata,false,true),
    ]);
    send(&mut env, build_instruction(ix_disc("withdraw_token_fund"), 1_000_000_000u64.to_le_bytes().to_vec(), withdraw_metas), &[&investor]).expect("wSOL withdraw");

    assert_eq!(token_balance(&env, investor_ata), 1_000_000_000, "investor got wSOL back (no profit => no fee)");
    assert_eq!(token_balance(&env, vault_ata), 0, "vault drained");
    assert_eq!(investor_shares(&env, investor_pool), 0, "shares burned");
}
