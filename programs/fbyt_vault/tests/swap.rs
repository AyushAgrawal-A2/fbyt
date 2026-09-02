mod common;
use common::*;
use solana_address::Address;
use solana_instruction::account_meta::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;

const OUTPUT_FEED: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const SECOND_OUTPUT_FEED: &str =
    "0x3333333333333333333333333333333333333333333333333333333333333333";

#[allow(clippy::too_many_arguments)]
fn swap_metas(
    live_vault: &LiveVault,
    admin: Address,
    trader: Address,
    output_mint: Address,
    vault_input_ata: Address,
    vault_output_ata: Address,
    output_oracle: Address,
    output_price: Address,
) -> Vec<AccountMeta> {
    vec![
        meta(live_vault.admin_pool, false, true),
        meta(admin, false, true),
        meta(trader, true, true),
        meta(live_vault.mint, false, true),
        meta(live_vault.vault_pool, false, true),
        meta(live_vault.asset_registry, false, true),
        meta(live_vault.mint, false, false),
        meta(spl_token_id(), false, false),
        meta(output_mint, false, false),
        meta(spl_token_id(), false, false),
        meta(vault_input_ata, false, true),
        meta(vault_output_ata, false, true),
        meta(live_vault.oracle_pool, false, true),
        meta(output_oracle, false, true),
        meta(live_vault.price_update, false, false),
        meta(output_price, false, false),
        meta(jupiter_program_id(), false, false),
        meta(SYSTEM, false, false),
    ]
}
fn empty_data() -> Vec<u8> {
    0u32.to_le_bytes().to_vec()
} // borsh Vec<u8> len=0

#[test]
fn swap_validations_reject_unauthorized_inactive_and_unapproved_oracle() {
    let mut env = boot();
    let live_vault = bootstrap_vault(&mut env);
    inject_jupiter_stub(&mut env);
    let admin = env.admin.pubkey();
    let money_manager = live_vault.money_manager.insecure_clone();
    let output_mint = inject_mint(&mut env, 6);
    let output_oracle = approved_oracle(&mut env, live_vault.admin_pool, output_mint, OUTPUT_FEED);
    let output_price = inject_price_update(&mut env, OUTPUT_FEED, 100_000_000, -8, BASE_TIME);
    let vault_input_ata =
        inject_token_account(&mut env, live_vault.mint, live_vault.vault_pool, 10_000_000);
    let vault_output_ata = inject_token_account(&mut env, output_mint, live_vault.vault_pool, 0);

    // NEGATIVE 1: unauthorized trader
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("swap"),
            empty_data(),
            swap_metas(
                &live_vault,
                admin,
                attacker.pubkey(),
                output_mint,
                vault_input_ata,
                vault_output_ata,
                output_oracle,
                output_price,
            ),
        ),
        &[&attacker],
    )
    .unwrap_err();
    assert!(
        error.contains("UnauthorizedTrader"),
        "expected UnauthorizedTrader, got: {error}"
    );

    // NEGATIVE 3: unapproved destination oracle (build before closing the vault)
    let second_output_mint = inject_mint(&mut env, 6);
    let unapproved_output_oracle = unapproved_oracle(
        &mut env,
        live_vault.admin_pool,
        second_output_mint,
        SECOND_OUTPUT_FEED,
    );
    let second_output_price =
        inject_price_update(&mut env, SECOND_OUTPUT_FEED, 100_000_000, -8, BASE_TIME);
    let second_vault_output_ata =
        inject_token_account(&mut env, second_output_mint, live_vault.vault_pool, 0);
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("swap"),
            empty_data(),
            swap_metas(
                &live_vault,
                admin,
                money_manager.pubkey(),
                second_output_mint,
                vault_input_ata,
                second_vault_output_ata,
                unapproved_output_oracle,
                second_output_price,
            ),
        ),
        &[&money_manager],
    )
    .unwrap_err();
    assert!(
        error.contains("OracleNotApproved"),
        "expected OracleNotApproved, got: {error}"
    );

    // NEGATIVE 2: vault not active (close it, then authorized trader tries to swap)
    set_clock(&mut env, BASE_TIME + 2_592_000 + 1); // close only allowed after the fundraise period
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
            ix_disc("swap"),
            empty_data(),
            swap_metas(
                &live_vault,
                admin,
                money_manager.pubkey(),
                output_mint,
                vault_input_ata,
                vault_output_ata,
                output_oracle,
                output_price,
            ),
        ),
        &[&money_manager],
    )
    .unwrap_err();
    assert!(
        error.contains("VaultNotActive"),
        "expected VaultNotActive, got: {error}"
    );
}

#[test]
fn swap_executes_jupiter_cpi_and_records_trade() {
    let mut env = boot();
    let live_vault = bootstrap_vault(&mut env);
    load_jupiter_mock(&mut env); // real program at the Jupiter id
    let admin = env.admin.pubkey();
    let money_manager = live_vault.money_manager.insecure_clone();
    // swap gates: min-raise reached + past the fundraise period.
    set_vault_raised(&mut env, live_vault.vault_pool, 150_000_000);
    let trade_time = BASE_TIME + 2_592_000 + 1;
    set_clock(&mut env, trade_time);
    // swap requires each price account to be the canonical Pyth sponsored-feed account.
    let base_price = inject_canonical_price(&mut env, FEED, 150_000_000, -8, trade_time); // fresh base price
    let output_mint = inject_mint(&mut env, 6);
    let output_oracle = approved_oracle(&mut env, live_vault.admin_pool, output_mint, OUTPUT_FEED);
    let output_price = inject_canonical_price(&mut env, OUTPUT_FEED, 100_000_000, -8, trade_time); // $1.00

    // vault holds 10 input tokens ($15); manager holds 15 output tokens ($15) to deliver
    let vault_input_ata =
        inject_token_account(&mut env, live_vault.mint, live_vault.vault_pool, 10_000_000);
    let vault_output_ata = inject_token_account(&mut env, output_mint, live_vault.vault_pool, 0);
    let manager_input_ata =
        inject_token_account(&mut env, live_vault.mint, money_manager.pubkey(), 0);
    // output source is owned by the mock's [b"pool"] PDA (the mock signs for it via invoke_signed),
    // matching the deployed swap, which grants signer to the vault PDA only — no external authority.
    let pool_pda = jupiter_pool_pda();
    let pool_output_ata = inject_token_account(&mut env, output_mint, pool_pda, 15_000_000);

    // data passed verbatim to the mock: [input_amount, output_amount]
    let mut route_data = 10_000_000u64.to_le_bytes().to_vec();
    route_data.extend_from_slice(&15_000_000u64.to_le_bytes());
    let mut args = (route_data.len() as u32).to_le_bytes().to_vec(); // borsh Vec<u8> prefix
    args.extend_from_slice(&route_data);

    let mut metas = vec![
        meta(live_vault.admin_pool, false, true),
        meta(admin, false, true),
        meta(money_manager.pubkey(), true, true),
        meta(live_vault.mint, false, true),
        meta(live_vault.vault_pool, false, true),
        meta(live_vault.asset_registry, false, true),
        meta(live_vault.mint, false, false),
        meta(spl_token_id(), false, false),
        meta(output_mint, false, false),
        meta(spl_token_id(), false, false),
        meta(vault_input_ata, false, true),
        meta(vault_output_ata, false, true),
        meta(live_vault.oracle_pool, false, true),
        meta(output_oracle, false, true),
        meta(base_price, false, false),
        meta(output_price, false, false),
        meta(jupiter_program_id(), false, false),
        meta(SYSTEM, false, false),
    ];
    // route (remaining_accounts) the mock consumes: token_program, vault_input, input_sink,
    // output_source, vault_output, vault_authority (PDA, swap marks it signer), source_authority (money_manager)
    metas.extend_from_slice(&[
        meta(spl_token_id(), false, false),
        meta(vault_input_ata, false, true),
        meta(manager_input_ata, false, true),
        meta(pool_output_ata, false, true),
        meta(vault_output_ata, false, true),
        meta(live_vault.vault_pool, false, false),
        meta(pool_pda, false, false),
    ]);

    let admin_lamports_before = lamports(&env, admin);
    send(
        &mut env,
        build_instruction(ix_disc("swap"), args, metas),
        &[&money_manager],
    )
    .expect("swap ok");

    assert_eq!(token_balance(&env, vault_input_ata), 0, "vault input spent");
    assert_eq!(
        token_balance(&env, vault_output_ata),
        15_000_000,
        "vault received output"
    );
    assert_eq!(
        token_balance(&env, manager_input_ata),
        10_000_000,
        "counterparty received input"
    );
    assert_eq!(
        token_balance(&env, pool_output_ata),
        0,
        "counterparty delivered output"
    );
    assert_eq!(
        registry_len(&env, live_vault.asset_registry),
        2,
        "both swap legs registered: input (base) + output"
    );
    assert_eq!(
        lamports(&env, admin) - admin_lamports_before,
        1_000_000,
        "trading fee paid to admin"
    );
    assert_eq!(
        vault_last_trade_at(&env, live_vault.vault_pool),
        trade_time as u64,
        "last_trade_at recorded"
    );
}
