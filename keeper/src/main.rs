//! FBYT keeper (Rust) — the off-chain automation service. It trades vaults using their trading
//! delegate (a trade-only key that can never withdraw), running the DCA / grid / rebalance bots
//! registered in the app. Because it lives in the program's Cargo workspace it reuses the program's
//! own `state`, `accounts`, `instruction`, and seed constants — no hand-rolled byte offsets — so the
//! (de)serialization is exactly what the on-chain program expects.
//!
//!   RPC_URL=http://127.0.0.1:8899 cargo run -- [delegateKeypair.json] [--once]
//!
//! It reads the bots from the app's file DB (../app/.data/db/bots.json), runs each enabled bot this
//! key is the delegate for, sends the swap, and records executions back to the DB (botOrders.json,
//! and runCount/lastRunAt/state on the bot) so the UI reflects them.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::rc::Rc;
use std::str::FromStr;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anchor_client::{Client, Cluster};
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::{InstructionData, ToAccountMetas};
use serde_json::{json, Value};
use solana_keypair::{read_keypair_file, Keypair};
use solana_signer::Signer;

use fbyt_vault::constants::{ADMIN_POOL_SEED, ASSET_REGISTRY_SEED, ORACLE_POOL_SEED};
use fbyt_vault::state::{AdminPool, OraclePool, VaultPool};

const TOKEN_PROGRAM: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM: Pubkey = anchor_lang::pubkey!("11111111111111111111111111111111");
const JUPITER: Pubkey = anchor_lang::pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const PYTH_PUSH_ORACLE: Pubkey =
    anchor_lang::pubkey!("pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou");

type Rpc = solana_rpc_client::rpc_client::RpcClient;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn db_path() -> PathBuf {
    // the same SQLite database the app + indexer use (WAL makes concurrent access safe)
    std::env::var("FBYT_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../app/.data/fbyt.db"))
}
fn open_db() -> Result<rusqlite::Connection, Box<dyn std::error::Error>> {
    let conn = rusqlite::Connection::open(db_path())?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id))",
        [],
    )?;
    Ok(conn)
}
/// Read every document in a collection as (id, json).
fn read_collection(conn: &rusqlite::Connection, name: &str) -> Result<Vec<(String, Value)>, Box<dyn std::error::Error>> {
    let mut stmt = conn.prepare("SELECT id, data FROM docs WHERE collection = ?1")?;
    let rows = stmt.query_map([name], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = vec![];
    for row in rows {
        let (id, data) = row?;
        out.push((id, serde_json::from_str(&data).unwrap_or_else(|_| json!({}))));
    }
    Ok(out)
}
fn upsert(conn: &rusqlite::Connection, collection: &str, id: &str, v: &Value) -> Result<(), Box<dyn std::error::Error>> {
    conn.execute(
        "INSERT OR REPLACE INTO docs (collection, id, data) VALUES (?1, ?2, ?3)",
        rusqlite::params![collection, id, v.to_string()],
    )?;
    Ok(())
}
fn insert_ignore(conn: &rusqlite::Connection, collection: &str, id: &str, v: &Value) -> Result<(), Box<dyn std::error::Error>> {
    conn.execute(
        "INSERT OR IGNORE INTO docs (collection, id, data) VALUES (?1, ?2, ?3)",
        rusqlite::params![collection, id, v.to_string()],
    )?;
    Ok(())
}
/// Advisory leader lock so two keeper instances never trade the same bots concurrently (which would
/// double-execute). Acquired transactionally in SQLite; `holder` identifies this process and the lock
/// self-expires so a crashed keeper doesn't wedge the fleet. Returns true if we hold the lock.
fn acquire_lock(conn: &rusqlite::Connection, holder: &str, ttl_ms: u64) -> Result<bool, Box<dyn std::error::Error>> {
    let now = now_ms();
    let tx = conn.unchecked_transaction()?;
    let cur: Option<String> = tx
        .query_row("SELECT data FROM docs WHERE collection = 'keeperLocks' AND id = 'leader'", [], |r| r.get(0))
        .ok();
    if let Some(data) = cur {
        let v: Value = serde_json::from_str(&data).unwrap_or_else(|_| json!({}));
        let exp = v["exp"].as_u64().unwrap_or(0);
        let owner = v["holder"].as_str().unwrap_or("");
        if exp > now && owner != holder {
            return Ok(false); // another live keeper holds it
        }
    }
    let lock = json!({ "id": "leader", "holder": holder, "exp": now + ttl_ms });
    tx.execute(
        "INSERT OR REPLACE INTO docs (collection, id, data) VALUES ('keeperLocks', 'leader', ?1)",
        rusqlite::params![lock.to_string()],
    )?;
    tx.commit()?;
    Ok(true)
}
fn release_lock(conn: &rusqlite::Connection, holder: &str) {
    let _ = conn.execute(
        "DELETE FROM docs WHERE collection = 'keeperLocks' AND id = 'leader' AND json_extract(data,'$.holder') = ?1",
        rusqlite::params![holder],
    );
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}
fn oracle_pool_pda(program: &Pubkey, admin_pool: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[ORACLE_POOL_SEED, admin_pool.as_ref(), mint.as_ref()],
        program,
    )
    .0
}
fn asset_registry_pda(program: &Pubkey, vault: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[ASSET_REGISTRY_SEED, vault.as_ref()], program).0
}
fn admin_pool_pda(program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[ADMIN_POOL_SEED], program).0
}
fn jupiter_pool_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"pool"], &JUPITER).0
}

/// Decode an OraclePool's 66-byte ASCII-hex feed_id into the 32-byte Pyth feed id.
fn feed32(feed_id: &[u8; 66]) -> [u8; 32] {
    let s: String = feed_id
        .iter()
        .take_while(|&&b| b != 0)
        .map(|&b| b as char)
        .collect();
    let hex = s.trim_start_matches("0x");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
    }
    out
}
fn price_account(feed: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[&[0u8, 0u8], feed], &PYTH_PUSH_ORACLE).0
}
/// Read a Pyth PriceUpdateV2 account: price (i64 @ 73), exponent (i32 @ 89).
fn read_price(rpc: &Rpc, acct: &Pubkey) -> Result<(i128, i32), Box<dyn std::error::Error>> {
    let data = rpc.get_account_data(acct)?;
    let price = i64::from_le_bytes(data[73..81].try_into()?) as i128;
    let expo = i32::from_le_bytes(data[89..93].try_into()?);
    Ok((price, expo))
}
fn token_balance(rpc: &Rpc, acct: &Pubkey) -> u128 {
    rpc.get_token_account_balance(acct)
        .ok()
        .and_then(|b| b.amount.parse::<u128>().ok())
        .unwrap_or(0)
}

struct PriceInfo {
    price: i128,
    expo: i32,
    oracle_pool: Pubkey,
    price_acct: Pubkey,
}
fn price_of(
    rpc: &Rpc,
    program_id: &Pubkey,
    admin_pool: &Pubkey,
    mint: &Pubkey,
    oracle: &OraclePool,
) -> Result<PriceInfo, Box<dyn std::error::Error>> {
    let oracle_pool = oracle_pool_pda(program_id, admin_pool, mint);
    let feed = feed32(&oracle.feed_id);
    let price_acct = price_account(&feed);
    let (price, expo) = read_price(rpc, &price_acct)?;
    Ok(PriceInfo {
        price,
        expo,
        oracle_pool,
        price_acct,
    })
}

/// Compute a fair output amount for `input_amount` from -> to at oracle mid, minus slippage.
fn fair_output(
    input_amount: u128,
    from: &PriceInfo,
    to: &PriceInfo,
    max_slippage_bps: u64,
) -> u128 {
    let shift = from.expo - to.expo; // demo assets are 6dp
    let mut fair = input_amount * from.price as u128;
    if shift >= 0 {
        fair *= 10u128.pow(shift as u32);
    } else {
        fair /= 10u128.pow((-shift) as u32);
    }
    fair /= to.price as u128;
    fair * (10_000 - max_slippage_bps as u128) / 10_000
}

struct Ctx {
    program_id: Pubkey,
    vault: Pubkey,
    vaultpool: VaultPool,
    admin: AdminPool,
}

#[allow(clippy::too_many_arguments)]
fn send_swap(
    program: &anchor_client::Program<Rc<Keypair>>,
    ctx: &Ctx,
    delegate: &Pubkey,
    input_mint: Pubkey,
    output_mint: Pubkey,
    input_amount: u128,
    output_amount: u128,
    from: &PriceInfo,
    to: &PriceInfo,
) -> Result<String, Box<dyn std::error::Error>> {
    let pool = jupiter_pool_pda();
    let vault_input = ata(&ctx.vault, &input_mint);
    let vault_output = ata(&ctx.vault, &output_mint);
    let input_sink = ata(&pool, &input_mint);
    let output_source = ata(&pool, &output_mint);

    let accts = fbyt_vault::accounts::Swap {
        admin_pool: ctx.vaultpool.admin_pool,
        admin: ctx.admin.admin,
        trader: *delegate,
        token_mint: ctx.vaultpool.token_mint,
        vault_pool: ctx.vault,
        asset_registry: asset_registry_pda(&ctx.program_id, &ctx.vault),
        input_mint,
        input_mint_program: TOKEN_PROGRAM,
        output_mint,
        output_mint_program: TOKEN_PROGRAM,
        vault_input_token_account: vault_input,
        vault_output_token_account: vault_output,
        oracle_pool_from: from.oracle_pool,
        oracle_pool_to: to.oracle_pool,
        input_price_update: from.price_acct,
        output_price_update: to.price_acct,
        jupiter_program: JUPITER,
        system_program: SYSTEM_PROGRAM,
    };
    let mut metas = accts.to_account_metas(None);
    metas.extend([
        AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        AccountMeta::new(vault_input, false),
        AccountMeta::new(input_sink, false),
        AccountMeta::new(output_source, false),
        AccountMeta::new(vault_output, false),
        AccountMeta::new_readonly(ctx.vault, false),
        AccountMeta::new_readonly(pool, false),
    ]);
    let mut data = (input_amount as u64).to_le_bytes().to_vec();
    data.extend_from_slice(&(output_amount as u64).to_le_bytes());
    let ix = Instruction {
        program_id: ctx.program_id,
        accounts: metas,
        data: fbyt_vault::instruction::Swap { data }.data(),
    };
    let sig = program.request().instruction(ix).send()?;
    Ok(sig.to_string())
}

fn run_once(delegate_path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let rpc_url = std::env::var("RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8899".to_string());
    let program_id = Pubkey::from_str(
        &std::env::var("FBYT_PROGRAM_ID").unwrap_or_else(|_| fbyt_vault::ID.to_string()),
    )?;
    let delegate = read_keypair_file(delegate_path)
        .map_err(|e| format!("read keypair {delegate_path}: {e}"))?;
    let delegate_pk = delegate.pubkey();
    let payer = Rc::new(delegate);
    let client = Client::new(Cluster::Custom(rpc_url.clone(), rpc_url), payer);
    let program = client.program(program_id)?;
    let rpc = program.rpc();
    let conn = open_db()?;

    // only one keeper trades at a time (leader lock); a crashed holder's lock self-expires
    let holder = format!("{}-{}", std::process::id(), now_ms());
    if !acquire_lock(&conn, &holder, 120_000)? {
        println!("[keeper] another keeper holds the lock; skipping this tick");
        return Ok(());
    }

    let bots_obj: HashMap<String, Value> = read_collection(&conn, "bots")?.into_iter().collect();
    // group enabled bots for this delegate by vault
    let mut by_vault: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, b) in &bots_obj {
        let enabled = b["enabled"].as_bool().unwrap_or(false);
        let deleted = b["deleted"].as_bool().unwrap_or(false);
        let del = b["delegate"].as_str().unwrap_or("");
        if enabled && !deleted && del == delegate_pk.to_string() {
            by_vault
                .entry(b["vault"].as_str().unwrap_or("").to_string())
                .or_default()
                .push(id.clone());
        }
    }
    let total: usize = by_vault.values().map(|v| v.len()).sum();
    println!(
        "[keeper] {delegate_pk}: {total} enabled bot(s) across {} vault(s)",
        by_vault.len()
    );

    for (vault_str, ids) in by_vault {
        let vault = match Pubkey::from_str(&vault_str) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let vaultpool: VaultPool = program.account(vault)?;
        let admin: AdminPool = program.account(admin_pool_pda(&program_id))?;
        if vaultpool.trading_delegate != delegate_pk {
            eprintln!("  vault {vault_str}: delegate mismatch, skipping");
            continue;
        }
        // preload oracle pools per mint on demand
        let oracle_of = |mint: &Pubkey| -> Result<OraclePool, Box<dyn std::error::Error>> {
            Ok(program.account(oracle_pool_pda(&program_id, &vaultpool.admin_pool, mint))?)
        };
        let ctx = Ctx {
            program_id,
            vault,
            vaultpool: vaultpool.clone(),
            admin: admin.clone(),
        };
        let default_slip = admin.max_slippage_bps as u64;

        for id in ids {
            let bot = &bots_obj[&id];
            let s = &bot["strategy"];
            let kind = s["type"].as_str().unwrap_or("");
            let slip = s["maxSlippageBps"].as_u64().unwrap_or(default_slip);
            println!("bot {id} ({kind}) on {}…", &vault_str[..6]);
            let mut execs: Vec<Value> = vec![];
            let mut new_state: Option<Value> = None;

            let do_trade = |input_mint: Pubkey,
                            output_mint: Pubkey,
                            input_amount: u128|
             -> Result<Option<Value>, Box<dyn std::error::Error>> {
                if input_amount == 0 {
                    return Ok(None);
                }
                let from = price_of(
                    &rpc,
                    &program_id,
                    &vaultpool.admin_pool,
                    &input_mint,
                    &oracle_of(&input_mint)?,
                )?;
                let to = price_of(
                    &rpc,
                    &program_id,
                    &vaultpool.admin_pool,
                    &output_mint,
                    &oracle_of(&output_mint)?,
                )?;
                let output_amount = fair_output(input_amount, &from, &to, slip);
                if output_amount == 0 {
                    return Ok(None);
                }
                let sig = send_swap(
                    &program,
                    &ctx,
                    &delegate_pk,
                    input_mint,
                    output_mint,
                    input_amount,
                    output_amount,
                    &from,
                    &to,
                )?;
                println!(
                    "  swap {input_amount} {}… -> {output_amount} {}…  {}",
                    &input_mint.to_string()[..4],
                    &output_mint.to_string()[..4],
                    &sig[..12]
                );
                Ok(Some(
                    json!({ "inputMint": input_mint.to_string(), "outputMint": output_mint.to_string(), "inputAmount": input_amount.to_string(), "outputAmount": output_amount.to_string(), "signature": sig }),
                ))
            };

            match kind {
                "dca" => {
                    let inp = Pubkey::from_str(s["inputMint"].as_str().unwrap_or(""))?;
                    let out = Pubkey::from_str(s["outputMint"].as_str().unwrap_or(""))?;
                    let amt: u128 = s["inputAmount"]
                        .as_str()
                        .unwrap_or("0")
                        .parse()
                        .unwrap_or(0);
                    if let Some(e) = do_trade(inp, out, amt)? {
                        execs.push(e);
                    }
                }
                "rebalance" => {
                    let a = Pubkey::from_str(s["assetA"].as_str().unwrap_or(""))?;
                    let b = Pubkey::from_str(s["assetB"].as_str().unwrap_or(""))?;
                    let target_bps = s["targetABps"].as_u64().unwrap_or(5000) as u128;
                    let cap: u128 = s["maxTradeAmount"]
                        .as_str()
                        .unwrap_or("0")
                        .parse()
                        .unwrap_or(0);
                    let pa = price_of(
                        &rpc,
                        &program_id,
                        &vaultpool.admin_pool,
                        &a,
                        &oracle_of(&a)?,
                    )?;
                    let pb = price_of(
                        &rpc,
                        &program_id,
                        &vaultpool.admin_pool,
                        &b,
                        &oracle_of(&b)?,
                    )?;
                    let usd = |amt: u128, p: &PriceInfo| {
                        amt * p.price as u128 / 10u128.pow((-p.expo) as u32)
                    };
                    let va = usd(token_balance(&rpc, &ata(&vault, &a)), &pa);
                    let vb = usd(token_balance(&rpc, &ata(&vault, &b)), &pb);
                    let total = va + vb;
                    if total > 0 {
                        let target_a = total * target_bps / 10_000;
                        if va > target_a {
                            let mut size =
                                (va - target_a) * 10u128.pow((-pa.expo) as u32) / pa.price as u128;
                            if size > cap {
                                size = cap;
                            }
                            if let Some(e) = do_trade(a, b, size)? {
                                execs.push(e);
                            }
                        } else if vb > total - target_a {
                            let mut size = (vb - (total - target_a))
                                * 10u128.pow((-pb.expo) as u32)
                                / pb.price as u128;
                            if size > cap {
                                size = cap;
                            }
                            if let Some(e) = do_trade(b, a, size)? {
                                execs.push(e);
                            }
                        } else {
                            println!("  rebalance: within band");
                        }
                    }
                }
                "grid" => {
                    let base = Pubkey::from_str(s["baseMint"].as_str().unwrap_or(""))?;
                    let quote = Pubkey::from_str(s["quoteMint"].as_str().unwrap_or(""))?;
                    let step_bps = s["stepBps"].as_u64().unwrap_or(200) as i128;
                    let amt: u128 = s["tradeAmount"]
                        .as_str()
                        .unwrap_or("0")
                        .parse()
                        .unwrap_or(0);
                    let pb = price_of(
                        &rpc,
                        &program_id,
                        &vaultpool.admin_pool,
                        &base,
                        &oracle_of(&base)?,
                    )?;
                    let cur = pb.price;
                    let last: i128 = bot["state"]["lastGridPrice"]
                        .as_str()
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(cur);
                    let step = last * step_bps / 10_000;
                    if cur <= last - step {
                        if let Some(e) = do_trade(quote, base, amt)? {
                            execs.push(e);
                        }
                        new_state = Some(json!({ "lastGridPrice": cur.to_string() }));
                    } else if cur >= last + step {
                        if let Some(e) = do_trade(base, quote, amt)? {
                            execs.push(e);
                        }
                        new_state = Some(json!({ "lastGridPrice": cur.to_string() }));
                    } else {
                        println!("  grid: within a step");
                        new_state = Some(json!({ "lastGridPrice": last.to_string() }));
                    }
                }
                other => eprintln!("  unknown strategy {other}"),
            }

            // record executions + update the bot doc, preserving all existing fields
            for e in &execs {
                let oid = format!("{}-{}", now_ms(), &id);
                let mut order = e.clone();
                order["id"] = json!(oid);
                order["botId"] = json!(id);
                order["vault"] = json!(vault_str);
                order["t"] = json!(now_ms());
                insert_ignore(&conn, "botOrders", &oid, &order)?;
            }
            let mut slot = bots_obj[&id].clone();
            slot["runCount"] = json!(slot["runCount"].as_u64().unwrap_or(0) + 1);
            slot["lastRunAt"] = json!(now_ms());
            if let Some(st) = new_state {
                slot["state"] = st;
            }
            upsert(&conn, "bots", &id, &slot)?;
        }
    }

    release_lock(&conn, &holder);
    println!("[keeper] done");
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let once = args.iter().any(|a| a == "--once");
    let delegate_path = args
        .iter()
        .find(|a| a.ends_with(".json"))
        .cloned()
        .unwrap_or_else(|| {
            format!(
                "{}/../app/scripts/.keys/delegate.json",
                env!("CARGO_MANIFEST_DIR")
            )
        });
    let interval = std::env::var("KEEPER_INTERVAL_SEC")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30u64);

    loop {
        if let Err(e) = run_once(&delegate_path) {
            eprintln!("[keeper] tick error: {e}");
        }
        if once {
            break;
        }
        sleep(Duration::from_secs(interval));
    }
    Ok(())
}
