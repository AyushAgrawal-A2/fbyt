#![allow(dead_code)]
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{Instruction, account_meta::AccountMeta};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const SYSTEM: Address = Address::new_from_array([0u8; 32]);
/// Must equal the program's `declare_id!` or Anchor raises DeclaredProgramIdMismatch (4100).
pub fn program_id() -> Address {
    use std::str::FromStr;
    Address::from_str("3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y").unwrap()
}

/// Anchor 8-byte instruction discriminator: sha256("global:<name>")[..8]
pub fn ix_disc(name: &str) -> [u8; 8] {
    let hash = Sha256::digest(format!("global:{name}").as_bytes());
    let mut discriminator = [0u8; 8];
    discriminator.copy_from_slice(&hash[..8]);
    discriminator
}
/// Anchor 8-byte account discriminator: sha256("account:<Name>")[..8]
pub fn acct_disc(name: &str) -> [u8; 8] {
    let hash = Sha256::digest(format!("account:{name}").as_bytes());
    let mut discriminator = [0u8; 8];
    discriminator.copy_from_slice(&hash[..8]);
    discriminator
}

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub admin: Keypair,
    pub operator: Keypair,
}

pub fn boot() -> Env {
    let mut svm = LiteSVM::new();
    let program_elf = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/fbyt_vault.so"
    ))
    .expect("anchor build first");
    svm.add_program(program_id(), &program_elf).unwrap();
    let payer = Keypair::new();
    let admin = Keypair::new();
    let operator = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    Env {
        svm,
        payer,
        admin,
        operator,
    }
}

pub fn admin_pool_pda() -> (Address, u8) {
    Address::find_program_address(&[b"AdminPool"], &program_id())
}

/// Inject a ready-made AdminPool with the deployed program's real config values,
/// but `admin`/`operator` set to keypairs the tests control.
pub fn inject_admin_pool(env: &mut Env) -> Address {
    let (admin_pool_key, bump) = admin_pool_pda();
    let mut data = Vec::new();
    data.extend_from_slice(&acct_disc("AdminPool"));
    data.push(bump);
    data.extend_from_slice(env.admin.pubkey().as_array());
    data.extend_from_slice(&[0u8; 32]); // pending_admin
    data.extend_from_slice(env.operator.pubkey().as_array());
    data.extend_from_slice(&0u64.to_le_bytes()); // vault_pool_count
    data.extend_from_slice(&2_000_000u64.to_le_bytes()); // creation_fee
    data.extend_from_slice(&2000u16.to_le_bytes()); // protocol_performance_fee
    data.extend_from_slice(&2000u16.to_le_bytes()); // protocol_money_management_fee
    data.extend_from_slice(&1500u16.to_le_bytes()); // money_management_yearly_fee_max
    data.extend_from_slice(&2000u16.to_le_bytes()); // performance_fee_max
    data.extend_from_slice(&1_000_000u64.to_le_bytes()); // trading_fee
    data.extend_from_slice(&3_888_000u64.to_le_bytes()); // withdraw_cooldown_max
    data.extend_from_slice(&2_592_000u64.to_le_bytes()); // fundrising_period_max
    data.extend_from_slice(&10_000u64.to_le_bytes()); // raise_amount_min_usd
    data.extend_from_slice(&10_000u64.to_le_bytes()); // contribution_amount_min_usd
    data.extend_from_slice(&259_200u64.to_le_bytes()); // oracle_max_age
    data.extend_from_slice(&7_776_000u64.to_le_bytes()); // idle_period
    data.extend_from_slice(&10_000u64.to_le_bytes()); // dust_threshold_usd
    data.extend_from_slice(&30u16.to_le_bytes()); // max_asset_count
    data.extend_from_slice(&1000u16.to_le_bytes()); // max_slippage_bps
    data.extend_from_slice(&[0u8; 62]); // padding
    let account = Account {
        lamports: 5_000_000,
        data,
        owner: program_id(),
        executable: false,
        rent_epoch: 0,
    };
    env.svm.set_account(admin_pool_key, account).unwrap();
    admin_pool_key
}

/// Build+sign+send a single instruction; returns Ok(()) or the failed tx logs joined.
pub fn send(env: &mut Env, instruction: Instruction, signers: &[&Keypair]) -> Result<(), String> {
    env.svm.expire_blockhash(); // fresh blockhash so a re-sent identical instruction isn't rejected as a duplicate
    let blockhash = env.svm.latest_blockhash();
    let message = Message::new(&[instruction], Some(&env.payer.pubkey()));
    let mut all_signers: Vec<&Keypair> = vec![&env.payer];
    all_signers.extend_from_slice(signers);
    let transaction = Transaction::new(&all_signers, message, blockhash);
    env.svm
        .send_transaction(transaction)
        .map(|_| ())
        .map_err(|failure| failure.meta.logs.join("\n"))
}

pub fn meta(pubkey: Address, is_signer: bool, is_writable: bool) -> AccountMeta {
    AccountMeta {
        pubkey,
        is_signer,
        is_writable,
    }
}

// ---- account field readers (offsets from the struct layout) ----
pub fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}
pub fn read_u16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(data[offset..offset + 2].try_into().unwrap())
}
pub fn read_pubkey(data: &[u8], offset: usize) -> Address {
    Address::new_from_array(data[offset..offset + 32].try_into().unwrap())
}
pub struct AdminPoolView {
    pub admin: Address,
    pub pending_admin: Address,
    pub operator: Address,
    pub creation_fee: u64,
    pub max_slippage_bps: u16,
}
pub fn read_admin_pool(env: &Env) -> AdminPoolView {
    let (admin_pool_key, _) = admin_pool_pda();
    let data = env.svm.get_account(&admin_pool_key).unwrap().data;
    AdminPoolView {
        admin: read_pubkey(&data, 9),
        pending_admin: read_pubkey(&data, 41),
        operator: read_pubkey(&data, 73),
        creation_fee: read_u64(&data, 113),
        max_slippage_bps: read_u16(&data, 195),
    }
}
pub fn build_instruction(
    discriminator: [u8; 8],
    args: Vec<u8>,
    metas: Vec<AccountMeta>,
) -> Instruction {
    let mut data = discriminator.to_vec();
    data.extend_from_slice(&args);
    Instruction {
        program_id: program_id(),
        accounts: metas,
        data,
    }
}

// ---- SPL token mint injection ----
pub fn spl_token_id() -> Address {
    use std::str::FromStr;
    Address::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
}
/// Inject an initialized SPL Mint (82-byte layout) with the given decimals; returns its key.
pub fn inject_mint(env: &mut Env, decimals: u8) -> Address {
    let mint = Keypair::new().pubkey();
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes()); // mint_authority = Some
    data[4..36].copy_from_slice(env.admin.pubkey().as_array()); // authority
    // supply (36..44) = 0
    data[44] = decimals; // decimals
    data[45] = 1; // is_initialized
    // freeze_authority (46..50) tag = None (0)
    let account = Account {
        lamports: 2_000_000,
        data,
        owner: spl_token_id(),
        executable: false,
        rent_epoch: 0,
    };
    env.svm.set_account(mint, account).unwrap();
    mint
}
pub fn oracle_pool_pda(admin_pool: Address, token_mint: Address) -> (Address, u8) {
    Address::find_program_address(
        &[b"oracle_pool", admin_pool.as_array(), token_mint.as_array()],
        &program_id(),
    )
}
pub fn oracle_is_approved(env: &Env, oracle_pool: Address) -> bool {
    env.svm.get_account(&oracle_pool).unwrap().data[139] != 0
}
pub fn oracle_feed_id(env: &Env, oracle_pool: Address) -> Vec<u8> {
    env.svm.get_account(&oracle_pool).unwrap().data[73..139].to_vec()
}

// ---- Pyth PriceUpdateV2 fixture + clock ----
use solana_clock::Clock;
pub fn pyth_receiver_id() -> Address {
    use std::str::FromStr;
    // The program is built with the pyth `pro-compatible` feature, so PriceUpdateV2 accounts
    // must be owned by this receiver (matches the deployed program).
    Address::from_str("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp").unwrap()
}
pub fn hex32(feed: &str) -> [u8; 32] {
    let hex_digits = feed.strip_prefix("0x").unwrap_or(feed);
    let mut bytes = [0u8; 32];
    for index in 0..32 {
        bytes[index] = u8::from_str_radix(&hex_digits[index * 2..index * 2 + 2], 16).unwrap();
    }
    bytes
}
pub fn set_clock(env: &mut Env, timestamp: i64) {
    let mut clock: Clock = env.svm.get_sysvar();
    clock.unix_timestamp = timestamp;
    env.svm.set_sysvar(&clock);
}
/// Inject a Full-verified PriceUpdateV2 owned by the Pyth receiver, at a random address.
pub fn inject_price_update(
    env: &mut Env,
    feed_hex: &str,
    price: i64,
    exponent: i32,
    publish_time: i64,
) -> Address {
    let price_account_key = Keypair::new().pubkey();
    set_price_at(
        env,
        price_account_key,
        feed_hex,
        price,
        exponent,
        publish_time,
    );
    price_account_key
}
/// Write/overwrite a Full-verified PriceUpdateV2 at a specific address (e.g. to refresh publish_time).
pub fn set_price_at(
    env: &mut Env,
    price_account_key: Address,
    feed_hex: &str,
    price: i64,
    exponent: i32,
    publish_time: i64,
) {
    let mut data = Vec::new();
    data.extend_from_slice(&acct_disc("PriceUpdateV2"));
    data.extend_from_slice(&[0u8; 32]); // write_authority
    data.push(1u8); // verification_level = Full
    data.extend_from_slice(&hex32(feed_hex)); // price_message.feed_id
    data.extend_from_slice(&price.to_le_bytes()); // price i64
    data.extend_from_slice(&1u64.to_le_bytes()); // conf
    data.extend_from_slice(&exponent.to_le_bytes()); // exponent i32
    data.extend_from_slice(&publish_time.to_le_bytes()); // publish_time i64
    data.extend_from_slice(&publish_time.to_le_bytes()); // prev_publish_time
    data.extend_from_slice(&price.to_le_bytes()); // ema_price
    data.extend_from_slice(&1u64.to_le_bytes()); // ema_conf
    data.extend_from_slice(&0u64.to_le_bytes()); // posted_slot
    let account = Account {
        lamports: 5_000_000,
        data,
        owner: pyth_receiver_id(),
        executable: false,
        rent_epoch: 0,
    };
    env.svm.set_account(price_account_key, account).unwrap();
}
pub fn money_manager_pool_pda(admin_pool: Address, money_manager: Address) -> (Address, u8) {
    Address::find_program_address(
        &[
            b"MoneyManagerPool",
            admin_pool.as_array(),
            money_manager.as_array(),
        ],
        &program_id(),
    )
}
pub fn vault_pool_pda(admin_pool: Address, money_manager: Address, index: u64) -> (Address, u8) {
    Address::find_program_address(
        &[
            b"VaultPool",
            admin_pool.as_array(),
            money_manager.as_array(),
            &index.to_le_bytes(),
        ],
        &program_id(),
    )
}
pub fn asset_registry_pda(vault: Address) -> (Address, u8) {
    Address::find_program_address(&[b"AssetRegistry", vault.as_array()], &program_id())
}
pub fn lamports(env: &Env, key: Address) -> u64 {
    env.svm
        .get_account(&key)
        .map(|account| account.lamports)
        .unwrap_or(0)
}

// ---- Full live-vault bootstrap (admin_pool + oracle approved + mm pool + vault) ----
pub const FEED: &str = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
pub const BASE_TIME: i64 = 1_700_000_000;
pub struct LiveVault {
    pub money_manager: Keypair,
    pub admin_pool: Address,
    pub mint: Address,
    pub oracle_pool: Address,
    pub vault_pool: Address,
    pub asset_registry: Address,
    pub price_update: Address,
}
fn borsh_string(text: &str) -> Vec<u8> {
    let mut bytes = (text.len() as u32).to_le_bytes().to_vec();
    bytes.extend_from_slice(text.as_bytes());
    bytes
}
pub fn bootstrap_vault(env: &mut Env) -> LiveVault {
    set_clock(env, BASE_TIME);
    let admin_pool = inject_admin_pool(env);
    let mint = inject_mint(env, 6);
    let (oracle_pool, _) = oracle_pool_pda(admin_pool, mint);
    let admin = env.admin.insecure_clone();
    let requester = Keypair::new();
    env.svm.airdrop(&requester.pubkey(), 5_000_000_000).unwrap();
    send(
        env,
        build_instruction(
            ix_disc("create_oracle_pool"),
            borsh_string(FEED),
            vec![
                meta(requester.pubkey(), true, true),
                meta(admin_pool, false, true),
                meta(mint, false, true),
                meta(oracle_pool, false, true),
                meta(SYSTEM, false, false),
            ],
        ),
        &[&requester],
    )
    .unwrap();
    send(
        env,
        build_instruction(
            ix_disc("approve_oracle_pool"),
            vec![],
            vec![
                meta(admin.pubkey(), true, true),
                meta(admin_pool, false, true),
                meta(mint, false, true),
                meta(oracle_pool, false, true),
            ],
        ),
        &[&admin],
    )
    .unwrap();
    let money_manager = Keypair::new();
    env.svm
        .airdrop(&money_manager.pubkey(), 50_000_000_000)
        .unwrap();
    let (money_manager_pool, _) = money_manager_pool_pda(admin_pool, money_manager.pubkey());
    send(
        env,
        build_instruction(
            ix_disc("create_money_manager_pool"),
            vec![],
            vec![
                meta(admin_pool, false, false),
                meta(money_manager.pubkey(), true, true),
                meta(money_manager_pool, false, true),
                meta(SYSTEM, false, false),
            ],
        ),
        &[&money_manager],
    )
    .unwrap();
    let price_update = inject_price_update(env, FEED, 150_000_000, -8, BASE_TIME);
    let (vault_pool, _) = vault_pool_pda(admin_pool, money_manager.pubkey(), 0);
    let (asset_registry, _) = asset_registry_pda(vault_pool);
    let mut args = Vec::new();
    args.extend_from_slice(&10_000u64.to_le_bytes());
    args.extend_from_slice(&2_592_000u64.to_le_bytes());
    args.extend_from_slice(&10_000u64.to_le_bytes());
    args.extend_from_slice(&1_000_000u64.to_le_bytes());
    args.extend_from_slice(&3_888_000u64.to_le_bytes());
    args.extend_from_slice(&1000u16.to_le_bytes());
    args.extend_from_slice(&1500u16.to_le_bytes());
    args.push(1u8);
    send(
        env,
        build_instruction(
            ix_disc("create_vault"),
            args,
            vec![
                meta(admin_pool, false, true),
                meta(admin.pubkey(), false, true),
                meta(money_manager.pubkey(), true, true),
                meta(money_manager_pool, false, true),
                meta(vault_pool, false, true),
                meta(asset_registry, false, true),
                meta(oracle_pool, false, false),
                meta(price_update, false, false),
                meta(mint, false, true),
                meta(SYSTEM, false, false),
            ],
        ),
        &[&money_manager],
    )
    .unwrap();
    LiveVault {
        money_manager,
        admin_pool,
        mint,
        oracle_pool,
        vault_pool,
        asset_registry,
        price_update,
    }
}
pub fn vault_status(env: &Env, vault_pool: Address) -> u8 {
    env.svm.get_account(&vault_pool).unwrap().data[145]
}
pub fn vault_trading_delegate(env: &Env, vault_pool: Address) -> Address {
    // layout: disc8 bump1 index8 admin_pool32 money_manager32 token_mint32 asset_registry32 status1 investor_count8
    // raised8 total_shares8 min_contrib8 raise_period8 min_raise8 mm_wd8 wd_cd8 created8 updated8 last_trade8
    // last_mm8 mm_yearly_fee2 perf_fee2 is_open1 padding1[7] trading_delegate32 ...
    let data = env.svm.get_account(&vault_pool).unwrap().data;
    let trading_delegate_offset = 254usize; // disc8+bump1+index8+4*32+status1+investor_count8(u64)+11*u64+2+2+1+pad7
    read_pubkey(&data, trading_delegate_offset)
}
pub fn vault_investor_count(env: &Env, vault_pool: Address) -> u32 {
    let data = env.svm.get_account(&vault_pool).unwrap().data;
    u32::from_le_bytes(data[146..150].try_into().unwrap())
}
pub fn investor_pool_pda(
    investor: Address,
    admin_pool: Address,
    vault_pool: Address,
    mint: Address,
) -> (Address, u8) {
    Address::find_program_address(
        &[
            b"InvestorPool",
            investor.as_array(),
            admin_pool.as_array(),
            vault_pool.as_array(),
            mint.as_array(),
        ],
        &program_id(),
    )
}

// ---- Associated token accounts ----
pub fn ata_program_id() -> Address {
    use std::str::FromStr;
    Address::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap()
}
pub fn get_ata(owner: Address, mint: Address) -> Address {
    Address::find_program_address(
        &[owner.as_array(), spl_token_id().as_array(), mint.as_array()],
        &ata_program_id(),
    )
    .0
}
/// Inject an initialized SPL token account (165-byte layout) at the ATA of (owner, mint).
pub fn inject_token_account(env: &mut Env, mint: Address, owner: Address, amount: u64) -> Address {
    let associated_token_account = get_ata(owner, mint);
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_array());
    data[32..64].copy_from_slice(owner.as_array());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // state = Initialized
    let account = Account {
        lamports: 3_000_000,
        data,
        owner: spl_token_id(),
        executable: false,
        rent_epoch: 0,
    };
    env.svm
        .set_account(associated_token_account, account)
        .unwrap();
    associated_token_account
}
pub fn token_balance(env: &Env, associated_token_account: Address) -> u64 {
    read_u64(
        &env.svm.get_account(&associated_token_account).unwrap().data,
        64,
    )
}
pub fn investor_shares(env: &Env, investor_pool: Address) -> u64 {
    read_u64(&env.svm.get_account(&investor_pool).unwrap().data, 137)
}
pub fn vault_total_shares(env: &Env, vault_pool: Address) -> u64 {
    read_u64(&env.svm.get_account(&vault_pool).unwrap().data, 162)
}
pub fn vault_raised_usd(env: &Env, vault_pool: Address) -> u64 {
    read_u64(&env.svm.get_account(&vault_pool).unwrap().data, 154)
}

/// Create the investor_pool PDA for `investor` on the bootstrapped vault.
pub fn make_investor_pool(env: &mut Env, live_vault: &LiveVault, investor: &Keypair) -> Address {
    let (investor_pool, _) = investor_pool_pda(
        investor.pubkey(),
        live_vault.admin_pool,
        live_vault.vault_pool,
        live_vault.mint,
    );
    let metas = vec![
        meta(investor.pubkey(), true, true),
        meta(live_vault.admin_pool, false, false),
        meta(live_vault.vault_pool, false, true),
        meta(live_vault.mint, false, true),
        meta(investor_pool, false, true),
        meta(SYSTEM, false, false),
    ];
    send(
        env,
        build_instruction(ix_disc("create_investor_pool"), vec![], metas),
        &[investor],
    )
    .expect("investor pool");
    investor_pool
}

// ---- Upgradeable loader / ProgramData (for create_admin_pool's upgrade-authority gate) ----
pub fn bpf_upgradeable_id() -> Address {
    Address::new_from_array(solana_sdk_ids::bpf_loader_upgradeable::id().to_bytes())
}
pub fn program_data_addr() -> Address {
    Address::find_program_address(&[program_id().as_array()], &bpf_upgradeable_id()).0
}
/// Point the loaded program's ProgramData.upgrade_authority at `authority`.
/// ProgramData layout: [3,0,0,0] slot:u64 tag:u8 (Some) pubkey:32 <elf...>
pub fn set_upgrade_authority(env: &mut Env, authority: Address) {
    let program_data_key = program_data_addr();
    let mut program_data_account = env
        .svm
        .get_account(&program_data_key)
        .expect("programdata exists (upgradeable load)");
    assert_eq!(
        &program_data_account.data[0..4],
        &3u32.to_le_bytes(),
        "expected ProgramData variant"
    );
    program_data_account.data[12] = 1; // Option tag = Some
    program_data_account.data[13..45].copy_from_slice(authority.as_array());
    env.svm
        .set_account(program_data_key, program_data_account)
        .unwrap();
}

pub fn token_2022_id() -> Address {
    use std::str::FromStr;
    Address::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap()
}
pub fn vault_last_management_fee_at(env: &Env, vault_pool: Address) -> u64 {
    read_u64(&env.svm.get_account(&vault_pool).unwrap().data, 234)
}

/// Create + approve an oracle pool for `mint` under `admin_pool`; returns the oracle_pool address.
pub fn approved_oracle(env: &mut Env, admin_pool: Address, mint: Address, feed: &str) -> Address {
    let (oracle_pool, _) = oracle_pool_pda(admin_pool, mint);
    let admin = env.admin.insecure_clone();
    let requester = Keypair::new();
    env.svm.airdrop(&requester.pubkey(), 5_000_000_000).unwrap();
    send(
        env,
        build_instruction(
            ix_disc("create_oracle_pool"),
            borsh_string(feed),
            vec![
                meta(requester.pubkey(), true, true),
                meta(admin_pool, false, true),
                meta(mint, false, true),
                meta(oracle_pool, false, true),
                meta(SYSTEM, false, false),
            ],
        ),
        &[&requester],
    )
    .expect("oracle create");
    send(
        env,
        build_instruction(
            ix_disc("approve_oracle_pool"),
            vec![],
            vec![
                meta(admin.pubkey(), true, true),
                meta(admin_pool, false, true),
                meta(mint, false, true),
                meta(oracle_pool, false, true),
            ],
        ),
        &[&admin],
    )
    .expect("oracle approve");
    oracle_pool
}
pub fn registry_len(env: &Env, asset_registry: Address) -> u32 {
    u32::from_le_bytes(
        env.svm.get_account(&asset_registry).unwrap().data[41..45]
            .try_into()
            .unwrap(),
    )
}

pub fn jupiter_program_id() -> Address {
    use std::str::FromStr;
    Address::from_str("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4").unwrap()
}
/// The jupiter-mock's own `[b"pool"]` PDA — authority of the mock's output-source token account.
/// The mock signs for it via invoke_signed, so it needs no outer signer (mirrors a Jupiter pool PDA).
pub fn jupiter_pool_pda() -> Address {
    pda(jupiter_program_id(), &[b"pool"]).0
}
/// Place a minimal (system-owned) account at the Jupiter id so the address-checked UncheckedAccount resolves.
pub fn inject_jupiter_stub(env: &mut Env) {
    let account = Account {
        lamports: 1,
        data: vec![],
        owner: SYSTEM,
        executable: false,
        rent_epoch: 0,
    };
    env.svm.set_account(jupiter_program_id(), account).unwrap();
}
/// Create (but do NOT approve) an oracle pool for `mint`; returns the oracle_pool address.
pub fn unapproved_oracle(env: &mut Env, admin_pool: Address, mint: Address, feed: &str) -> Address {
    let (oracle_pool, _) = oracle_pool_pda(admin_pool, mint);
    let requester = Keypair::new();
    env.svm.airdrop(&requester.pubkey(), 5_000_000_000).unwrap();
    send(
        env,
        build_instruction(
            ix_disc("create_oracle_pool"),
            borsh_string(feed),
            vec![
                meta(requester.pubkey(), true, true),
                meta(admin_pool, false, true),
                meta(mint, false, true),
                meta(oracle_pool, false, true),
                meta(SYSTEM, false, false),
            ],
        ),
        &[&requester],
    )
    .expect("oracle create");
    oracle_pool
}

/// Load the compiled Jupiter mock at the Jupiter program id (for swap's positive path).
pub fn load_jupiter_mock(env: &mut Env) {
    let mock_elf = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/jupiter-mock/target/deploy/jupiter_mock.so"
    ))
    .expect("build the mock first: (cd programs/fbyt_vault/tests/jupiter-mock && cargo build-sbf)");
    env.svm
        .add_program(jupiter_program_id(), &mock_elf)
        .unwrap();
}
pub fn vault_last_trade_at(env: &Env, vault_pool: Address) -> u64 {
    read_u64(&env.svm.get_account(&vault_pool).unwrap().data, 226)
}

/// Inject an initialized SPL Mint at a SPECIFIC address (e.g. the real wSOL mint) with given decimals.
pub fn inject_mint_at(env: &mut Env, mint: Address, decimals: u8) {
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(env.admin.pubkey().as_array());
    data[44] = decimals;
    data[45] = 1;
    let account = Account { lamports: 2_000_000, data, owner: spl_token_id(), executable: false, rent_epoch: 0 };
    env.svm.set_account(mint, account).unwrap();
}
pub fn wsol_mint() -> Address {
    use std::str::FromStr;
    Address::from_str("So11111111111111111111111111111111111111112").unwrap()
}

// ================= Dual-program (local vs deployed) differential harness =================
pub const LOCAL_ID: &str = "3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y";
pub const DEPLOYED_ID: &str = "DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm";
pub fn local_so() -> &'static str { concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/fbyt_vault.so") }
pub fn deployed_so() -> &'static str { concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/deployed_fbyt_vault.so") }
pub fn pidof(s: &str) -> Address { use std::str::FromStr; Address::from_str(s).unwrap() }
/// The two (program_id, .so) pairs, for running a scenario against both.
pub fn both_programs() -> [(Address, &'static str); 2] {
    [(pidof(LOCAL_ID), local_so()), (pidof(DEPLOYED_ID), deployed_so())]
}
pub fn boot_env(program: Address, so: &str) -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(program, &std::fs::read(so).expect("so")).unwrap();
    let payer = Keypair::new(); svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    Env { svm, payer, admin: Keypair::new(), operator: Keypair::new() }
}
pub fn pda(program: Address, seeds: &[&[u8]]) -> (Address, u8) { Address::find_program_address(seeds, &program) }
pub fn inject_price_at(env: &mut Env, key: Address, owner: Address, feed_hex: &str, price: i64, expo: i32, publish_time: i64) {
    let mut d = Vec::new();
    d.extend_from_slice(&acct_disc("PriceUpdateV2"));
    d.extend_from_slice(&[0u8; 32]); d.push(1u8);
    d.extend_from_slice(&hex32(feed_hex));
    d.extend_from_slice(&price.to_le_bytes()); d.extend_from_slice(&1u64.to_le_bytes());
    d.extend_from_slice(&expo.to_le_bytes());
    d.extend_from_slice(&publish_time.to_le_bytes()); d.extend_from_slice(&publish_time.to_le_bytes());
    d.extend_from_slice(&price.to_le_bytes()); d.extend_from_slice(&1u64.to_le_bytes()); d.extend_from_slice(&0u64.to_le_bytes());
    env.svm.set_account(key, Account { lamports: 5_000_000, data: d, owner, executable: false, rent_epoch: 0 }).unwrap();
}
pub fn inject_price_owned(env: &mut Env, owner: Address, feed_hex: &str, price: i64, expo: i32, publish_time: i64) -> Address {
    let key = Keypair::new().pubkey();
    inject_price_at(env, key, owner, feed_hex, price, expo, publish_time);
    key
}
/// The pro Pyth push-oracle program id (`pyt2F414…`), matching the `pro-compatible` receiver.
pub fn pyth_push_oracle_id() -> Address {
    use std::str::FromStr;
    Address::from_str("pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou").unwrap()
}
/// Canonical Pyth sponsored price account for a feed: PDA [shard=0u16 LE, feed_id] under the push oracle.
/// The `swap` handler requires its price accounts to be exactly these (InvalidPriceOracle otherwise).
pub fn canonical_price_account(feed_hex: &str) -> Address {
    pda(pyth_push_oracle_id(), &[&0u16.to_le_bytes(), &hex32(feed_hex)]).0
}
/// Inject a PriceUpdateV2 (receiver-owned) AT the canonical sponsored-feed address for `feed_hex`.
pub fn inject_canonical_price(env: &mut Env, feed_hex: &str, price: i64, expo: i32, publish_time: i64) -> Address {
    let key = canonical_price_account(feed_hex);
    inject_price_at(env, key, pyth_receiver_id(), feed_hex, price, expo, publish_time);
    key
}
pub fn ixp(program: Address, disc: [u8; 8], args: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
    let mut data = disc.to_vec(); data.extend_from_slice(&args);
    Instruction { program_id: program, accounts: metas, data }
}
pub fn sendp(env: &mut Env, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
    env.svm.expire_blockhash();
    let bh = env.svm.latest_blockhash();
    let msg = Message::new(&[ix], Some(&env.payer.pubkey()));
    let mut all: Vec<&Keypair> = vec![&env.payer]; all.extend_from_slice(signers);
    env.svm.send_transaction(Transaction::new(&all, msg, bh)).map(|_| ()).map_err(|e| e.meta.logs.join("\n"))
}
/// A ComputeBudget `SetComputeUnitLimit` instruction. The deployed program's multi-asset withdraw does
/// many CPI transfers and exceeds the 200k default budget, so those txs must raise the limit.
pub fn compute_budget_ix(units: u32) -> Instruction {
    use std::str::FromStr;
    let mut data = vec![2u8]; // SetComputeUnitLimit
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: Address::from_str("ComputeBudget111111111111111111111111111111").unwrap(),
        accounts: vec![],
        data,
    }
}
/// Like `sendp`, but prepends a compute-budget instruction raising the CU limit.
pub fn sendp_cu(env: &mut Env, ix: Instruction, signers: &[&Keypair], units: u32) -> Result<(), String> {
    env.svm.expire_blockhash();
    let bh = env.svm.latest_blockhash();
    let msg = Message::new(&[compute_budget_ix(units), ix], Some(&env.payer.pubkey()));
    let mut all: Vec<&Keypair> = vec![&env.payer]; all.extend_from_slice(signers);
    env.svm.send_transaction(Transaction::new(&all, msg, bh)).map(|_| ()).map_err(|e| e.meta.logs.join("\n"))
}
/// Program-agnostic error class: the Anchor error number / custom code, for comparing across programs.
pub fn err_code(e: &str) -> String {
    if let Some(i) = e.find("Error Number: ") { return e[i + 14..].split(|c: char| !c.is_ascii_digit()).next().unwrap_or("").into(); }
    if let Some(i) = e.find("custom program error: ") { return e[i + 22..].split_whitespace().next().unwrap_or("").into(); }
    if e.to_lowercase().contains("in use") { return "in_use".into(); }
    if e.is_empty() { "".into() } else { "other".into() }
}
pub fn inject_admin_pool_p(env: &mut Env, program: Address, admin: Address, operator: Address) -> Address {
    let (p, bump) = pda(program, &[b"AdminPool"]);
    let mut d = Vec::new();
    d.extend_from_slice(&acct_disc("AdminPool")); d.push(bump);
    d.extend_from_slice(admin.as_array()); d.extend_from_slice(&[0u8; 32]); d.extend_from_slice(operator.as_array());
    d.extend_from_slice(&0u64.to_le_bytes());
    d.extend_from_slice(&2_000_000u64.to_le_bytes());
    for v in [2000u16, 2000] { d.extend_from_slice(&v.to_le_bytes()); }
    for v in [1500u16, 2000] { d.extend_from_slice(&v.to_le_bytes()); }
    d.extend_from_slice(&1_000_000u64.to_le_bytes());
    for v in [3_888_000u64, 2_592_000, 10_000, 10_000, 259_200, 7_776_000, 10_000] { d.extend_from_slice(&v.to_le_bytes()); }
    for v in [30u16, 1000] { d.extend_from_slice(&v.to_le_bytes()); }
    d.extend_from_slice(&[0u8; 62]);
    env.svm.set_account(p, Account { lamports: 5_000_000, data: d, owner: program, executable: false, rent_epoch: 0 }).unwrap();
    p
}
pub struct DiffVault { pub mm: Keypair, pub admin_pool: Address, pub mint: Address, pub oracle: Address, pub vault: Address, pub registry: Address, pub price: Address }
/// Bootstrap a full vault under `program` (admin_pool + approved oracle + mm pool + vault @ $1.50 base).
pub fn bootstrap_p(env: &mut Env, program: Address) -> DiffVault {
    set_clock(env, BASE_TIME);
    let admin = env.admin.insecure_clone();
    let operator_pk = env.operator.pubkey();
    let admin_pool = inject_admin_pool_p(env, program, admin.pubkey(), operator_pk);
    let mint = inject_mint(env, 6);
    let (oracle, _) = pda(program, &[b"oracle_pool", admin_pool.as_array(), mint.as_array()]);
    let requester = Keypair::new(); env.svm.airdrop(&requester.pubkey(), 5_000_000_000).unwrap();
    let mut feed = (FEED.len() as u32).to_le_bytes().to_vec(); feed.extend_from_slice(FEED.as_bytes());
    sendp(env, ixp(program, ix_disc("create_oracle_pool"), feed,
        vec![meta(requester.pubkey(), true, true), meta(admin_pool, false, true), meta(mint, false, true), meta(oracle, false, true), meta(SYSTEM, false, false)]), &[&requester]).unwrap();
    sendp(env, ixp(program, ix_disc("approve_oracle_pool"), vec![],
        vec![meta(admin.pubkey(), true, true), meta(admin_pool, false, true), meta(mint, false, true), meta(oracle, false, true)]), &[&admin]).unwrap();
    let mm = Keypair::new(); env.svm.airdrop(&mm.pubkey(), 50_000_000_000).unwrap();
    let (mmp, _) = pda(program, &[b"MoneyManagerPool", admin_pool.as_array(), mm.pubkey().as_array()]);
    sendp(env, ixp(program, ix_disc("create_money_manager_pool"), vec![],
        vec![meta(admin_pool, false, false), meta(mm.pubkey(), true, true), meta(mmp, false, true), meta(SYSTEM, false, false)]), &[&mm]).unwrap();
    let price = inject_price_owned(env, pyth_receiver_id(), FEED, 150_000_000, -8, BASE_TIME);
    let (vault, _) = pda(program, &[b"VaultPool", admin_pool.as_array(), mm.pubkey().as_array(), &0u64.to_le_bytes()]);
    let (registry, _) = pda(program, &[b"AssetRegistry", vault.as_array()]);
    let mut a = Vec::new();
    for v in [10_000u64, 2_592_000, 10_000, 604_800, 3_888_000] { a.extend_from_slice(&v.to_le_bytes()); }
    for v in [1000u16, 1500] { a.extend_from_slice(&v.to_le_bytes()); } a.push(1u8);
    sendp(env, ixp(program, ix_disc("create_vault"), a,
        vec![meta(admin_pool, false, true), meta(admin.pubkey(), false, true), meta(mm.pubkey(), true, true), meta(mmp, false, true),
             meta(vault, false, true), meta(registry, false, true), meta(oracle, false, false), meta(price, false, false), meta(mint, false, true), meta(SYSTEM, false, false)]), &[&mm]).unwrap();
    DiffVault { mm, admin_pool, mint, oracle, vault, registry, price }
}

pub const FEED2: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
/// Execute one dummy_swap so the vault has `last_trade_at != 0` (and holds base + a 2nd asset).
/// Injects the vault's base ATA with `base_start` base tokens; swaps 10 base -> 30 asset2.
/// Returns (vault_base_ata, asset2_mint, asset2_oracle, asset2_price, vault_asset2_ata).
#[allow(clippy::too_many_arguments)]
// ---- direct state injection (dummy_swap was removed to match the deployed program) ----
/// Set `vault_pool.last_trade_at` (offset 226) so the vault counts as "traded".
pub fn set_vault_raised(env: &mut Env, vault: Address, raised_usd: u64) {
    let mut account = env.svm.get_account(&vault).expect("vault_pool");
    account.data[154..162].copy_from_slice(&raised_usd.to_le_bytes()); // raised_amount_usd @154
    env.svm.set_account(vault, account).unwrap();
}
pub fn set_vault_last_trade(env: &mut Env, vault: Address, ts: u64) {
    let mut account = env.svm.get_account(&vault).expect("vault_pool");
    account.data[226..234].copy_from_slice(&ts.to_le_bytes());
    env.svm.set_account(vault, account).unwrap();
}
/// Overwrite the AssetRegistry PDA so it lists exactly `[asset_mint]` (1 registered asset).
pub fn inject_registry_with_asset(env: &mut Env, program: Address, vault: Address, asset_mint: Address) {
    let (registry, bump) = pda(program, &[b"AssetRegistry", vault.as_array()]);
    let mut d = Vec::new();
    d.extend_from_slice(&acct_disc("AssetRegistry"));
    d.push(bump);
    d.extend_from_slice(vault.as_array());
    d.extend_from_slice(&1u32.to_le_bytes());   // Vec<Pubkey> len = 1
    d.extend_from_slice(asset_mint.as_array());
    d.extend_from_slice(&[0u8; 64]);            // padding [u64; 8]
    env.svm.set_account(registry, Account { lamports: 5_000_000, data: d, owner: program, executable: false, rent_epoch: 0 }).unwrap();
}
/// Trade the vault ONCE for real via `swap` + the Jupiter mock (dummy_swap was removed), so the
/// vault genuinely has `last_trade_at != 0` and holds base + a registered 2nd asset. Works on both
/// programs. Returns (vault_base_ata, asset2_mint, asset2_oracle, asset2_price, vault_asset2_ata).
#[allow(clippy::too_many_arguments)]
pub fn trade_vault(env: &mut Env, program: Address, admin_pool: Address, admin: &Keypair,
                   money_manager: &Keypair, base_mint: Address, vault: Address, _registry: Address,
                   base_oracle: Address, _base_price: Address, base_start: u64)
    -> (Address, Address, Address, Address, Address) {
    load_jupiter_mock(env);
    // satisfy the deployed swap's gates: min-raise reached + past the fundraise period.
    set_vault_raised(env, vault, 150_000_000);
    let trade_time = BASE_TIME + 2_592_000 + 1;
    set_clock(env, trade_time);
    // swap validates that each price account is the canonical Pyth sponsored-feed account.
    let base_price = inject_canonical_price(env, FEED, 150_000_000, -8, trade_time);
    let asset2 = inject_mint(env, 6);
    let asset2_oracle = approved_oracle_for(env, program, admin_pool, admin, asset2, FEED2);
    let asset2_price = inject_canonical_price(env, FEED2, 100_000_000, -8, trade_time);
    let (registry, _) = pda(program, &[b"AssetRegistry", vault.as_array()]);
    let vault_base_ata = inject_token_account(env, base_mint, vault, base_start);
    let vault_asset2_ata = inject_token_account(env, asset2, vault, 0);
    let mm_base_ata = inject_token_account(env, base_mint, money_manager.pubkey(), 0);       // input sink
    // output source is owned by the mock's own pool PDA (the mock signs for it via invoke_signed),
    // matching how the deployed swap authorizes the CPI: only the vault PDA is granted signer.
    let pool_pda = jupiter_pool_pda();
    let pool_asset2_ata = inject_token_account(env, asset2, pool_pda, 30_000_000);           // output source
    let admin_pk = admin.pubkey();
    // swap data (verbatim to the Jupiter mock): [input_amount, output_amount]
    let mut route_data = 10_000_000u64.to_le_bytes().to_vec(); route_data.extend_from_slice(&30_000_000u64.to_le_bytes());
    let mut args = (route_data.len() as u32).to_le_bytes().to_vec(); args.extend_from_slice(&route_data);
    let mut metas = vec![
        meta(admin_pool,false,true), meta(admin_pk,false,true), meta(money_manager.pubkey(),true,true), meta(base_mint,false,true),
        meta(vault,false,true), meta(registry,false,true),
        meta(base_mint,false,false), meta(spl_token_id(),false,false), meta(asset2,false,false), meta(spl_token_id(),false,false),
        meta(vault_base_ata,false,true), meta(vault_asset2_ata,false,true),
        meta(base_oracle,false,true), meta(asset2_oracle,false,true), meta(base_price,false,false), meta(asset2_price,false,false),
        meta(jupiter_program_id(),false,false), meta(SYSTEM,false,false),
    ];
    // route the mock consumes: token_program, vault_input, input_sink, output_source, vault_output,
    // vault(authority for input leg), pool_pda(authority for output leg, mock signs). No external
    // signer is granted to the route (only the vault PDA, forced signer by the swap).
    metas.extend_from_slice(&[
        meta(spl_token_id(),false,false), meta(vault_base_ata,false,true), meta(mm_base_ata,false,true),
        meta(pool_asset2_ata,false,true), meta(vault_asset2_ata,false,true), meta(vault,false,false), meta(pool_pda,false,false),
    ]);
    sendp(env, ixp(program, ix_disc("swap"), args, metas), &[money_manager]).expect("trade_vault swap");
    (vault_base_ata, asset2, asset2_oracle, asset2_price, vault_asset2_ata)
}
/// create+approve an oracle for `mint` under an arbitrary `program` (dual-program aware).
pub fn approved_oracle_for(env: &mut Env, program: Address, admin_pool: Address, admin: &Keypair, mint: Address, feed: &str) -> Address {
    let (oracle, _) = pda(program, &[b"oracle_pool", admin_pool.as_array(), mint.as_array()]);
    let requester = Keypair::new(); env.svm.airdrop(&requester.pubkey(), 5_000_000_000).unwrap();
    let mut f = (feed.len() as u32).to_le_bytes().to_vec(); f.extend_from_slice(feed.as_bytes());
    sendp(env, ixp(program, ix_disc("create_oracle_pool"), f,
        vec![meta(requester.pubkey(),true,true),meta(admin_pool,false,true),meta(mint,false,true),meta(oracle,false,true),meta(SYSTEM,false,false)]), &[&requester]).unwrap();
    sendp(env, ixp(program, ix_disc("approve_oracle_pool"), vec![],
        vec![meta(admin.pubkey(),true,true),meta(admin_pool,false,true),meta(mint,false,true),meta(oracle,false,true)]), &[admin]).unwrap();
    oracle
}
