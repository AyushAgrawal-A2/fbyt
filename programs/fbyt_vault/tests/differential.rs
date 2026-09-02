//! Differential tests: identical crafted transactions run against BOTH the reconstructed program
//! (local `.so`, id `3yw2g3V…`) and the DEPLOYED program (dumped `.so`, id `DNgg…`) inside LiteSVM.
//! A mismatch in accept/reject or resulting state is a real behavioral/constraint divergence.
mod common;
use common::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

// Thin aliases onto the shared differential harness in common.rs.
const LOCAL: &str = LOCAL_ID;
const DEPLOYED: &str = DEPLOYED_ID;
fn pid(s: &str) -> Address { pidof(s) }
fn pyth_receiver(_program: Address) -> Address { pyth_receiver_id() }

// ===================== SCENARIOS =====================
fn s_modify_fee(program: Address, so: &str, wrong_admin: bool, bad_fee: bool) -> (bool, u64, String) {
    let mut env = boot_env(program, so);
    let admin = env.admin.insecure_clone(); let op = env.operator.pubkey();
    let admin_pool = inject_admin_pool_p(&mut env, program, admin.pubkey(), op);
    let signer = if wrong_admin { let k=Keypair::new(); env.svm.airdrop(&k.pubkey(),1_000_000_000).unwrap(); k } else { admin.insecure_clone() };
    let mut args=Vec::new(); args.extend_from_slice(&5_000_000u64.to_le_bytes());
    args.extend_from_slice(&(if bad_fee{20000u16}else{1000}).to_le_bytes());
    args.extend_from_slice(&1000u16.to_le_bytes()); args.extend_from_slice(&2_000_000u64.to_le_bytes());
    args.extend_from_slice(&1200u16.to_le_bytes()); args.extend_from_slice(&1800u16.to_le_bytes());
    let r = sendp(&mut env, ixp(program, ix_disc("admin_modify_fee"), args, vec![meta(signer.pubkey(),true,true),meta(admin_pool,false,true)]), &[&signer]);
    let fee = read_u64(&env.svm.get_account(&admin_pool).unwrap().data, 113);
    (r.is_ok(), fee, r.err().map(|e|err_code(&e)).unwrap_or_default())
}
fn s_deposit(program: Address, so: &str) -> (bool, u64, u64, String) {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    let investor = Keypair::new(); env.svm.airdrop(&investor.pubkey(),5_000_000_000).unwrap();
    let (ip,_) = pda(program, &[b"InvestorPool", investor.pubkey().as_array(), v.admin_pool.as_array(), v.vault.as_array(), v.mint.as_array()]);
    sendp(&mut env, ixp(program, ix_disc("create_investor_pool"), vec![],
        vec![meta(investor.pubkey(),true,true),meta(v.admin_pool,false,false),meta(v.vault,false,true),meta(v.mint,false,true),meta(ip,false,true),meta(SYSTEM,false,false)]), &[&investor]).unwrap();
    let from = inject_token_account(&mut env, v.mint, investor.pubkey(), 100_000_000);
    let to = inject_token_account(&mut env, v.mint, v.vault, 0);
    let r = sendp(&mut env, ixp(program, ix_disc("deposit_token_fund"), 100_000_000u64.to_le_bytes().to_vec(),
        vec![meta(investor.pubkey(),true,true),meta(v.admin_pool,false,false),meta(v.vault,false,true),meta(v.registry,false,true),
             meta(ip,false,true),meta(v.oracle,false,true),meta(from,false,true),meta(to,false,true),meta(v.mint,false,true),
             meta(v.price,false,false),meta(spl_token_id(),false,false),meta(SYSTEM,false,false)]), &[&investor]);
    let (shares, total, raised) = if r.is_ok() {
        let vd = env.svm.get_account(&v.vault).unwrap().data;
        (read_u64(&env.svm.get_account(&ip).unwrap().data, 137), read_u64(&vd, 162), read_u64(&vd, 154))
    } else { (0,0,0) };
    println!("    (raised_amount_usd = {})", raised);
    (r.is_ok(), shares, total, r.err().map(|e|err_code(&e)).unwrap_or_default())
}
fn s_close_vault_status(program: Address, so: &str) -> (bool, u8) {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    let r = sendp(&mut env, ixp(program, ix_disc("close_vault"), vec![],
        vec![meta(v.admin_pool,false,false),meta(v.vault,false,true),meta(v.mm.pubkey(),true,true),meta(v.mint,false,true)]), &[&v.mm]);
    let status = env.svm.get_account(&v.vault).unwrap().data[145];
    (r.is_ok(), status)
}
fn s_mgmt_fee_wrong_operator(program: Address, so: &str) -> (bool, String) {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    set_clock(&mut env, BASE_TIME + 2_000_000);
    let vault_ata = inject_token_account(&mut env, v.mint, v.vault, 100_000_000);
    let mgr = inject_token_account(&mut env, v.mint, v.mm.pubkey(), 0);
    let admin_pk = env.admin.pubkey();
    let proto = inject_token_account(&mut env, v.mint, admin_pk, 0);
    let attacker = Keypair::new(); env.svm.airdrop(&attacker.pubkey(),1_000_000_000).unwrap();
    let mut metas = vec![meta(v.admin_pool,false,false),meta(attacker.pubkey(),true,true),meta(v.vault,false,true),
        meta(v.registry,false,false),meta(spl_token_id(),false,false),meta(token_2022_id(),false,false)];
    metas.extend_from_slice(&[meta(v.mint,false,false),meta(vault_ata,false,true),meta(mgr,false,true),meta(proto,false,true)]);
    let r = sendp(&mut env, ixp(program, ix_disc("withdraw_money_management_fee"), vec![], metas), &[&attacker]);
    (r.is_ok(), r.err().map(|e|err_code(&e)).unwrap_or_default())
}

fn line(label:&str, l:String, d:String){ println!("[{label}]\n  local   : {l}\n  deployed: {d}"); }

#[test]
fn differential_local_vs_deployed() {
    // --- admin_modify_fee: authorization + validation ---
    let (la,lf,lc)=s_modify_fee(pid(LOCAL),local_so(),false,false); let (da,df,dc)=s_modify_fee(pid(DEPLOYED),deployed_so(),false,false);
    line("modify_fee correct admin", format!("ok={la} fee={lf} {lc}"), format!("ok={da} fee={df} {dc}"));
    assert_eq!((la,lf),(da,df), "modify_fee(correct) diverges");
    let (la,_,lc)=s_modify_fee(pid(LOCAL),local_so(),true,false); let (da,_,dc)=s_modify_fee(pid(DEPLOYED),deployed_so(),true,false);
    line("modify_fee WRONG admin", format!("ok={la} err={lc}"), format!("ok={da} err={dc}"));
    assert_eq!((la,&lc),(da,&dc), "diverges");
    let (la,_,lc)=s_modify_fee(pid(LOCAL),local_so(),false,true); let (da,_,dc)=s_modify_fee(pid(DEPLOYED),deployed_so(),false,true);
    line("modify_fee fee>10000", format!("ok={la} err={lc}"), format!("ok={da} err={dc}"));
    assert_eq!((la,&lc),(da,&dc), "diverges");

    // --- deposit economics (validates micro-USD + share formula against the real program) ---
    let (la,ls,lt,lc)=s_deposit(pid(LOCAL),local_so()); let (da,ds,dt,dc)=s_deposit(pid(DEPLOYED),deployed_so());
    line("deposit 100 base @ $1.50", format!("ok={la} shares={ls} total={lt} {lc}"), format!("ok={da} shares={ds} total={dt} {dc}"));
    assert_eq!((la,ls,lt),(da,ds,dt), "deposit economics diverge");

    // --- close_vault status byte (validates the assumed VaultStatus::Closed = 3) ---
    let (la,lst)=s_close_vault_status(pid(LOCAL),local_so()); let (da,dst)=s_close_vault_status(pid(DEPLOYED),deployed_so());
    line("close_vault -> status byte", format!("ok={la} status={lst}"), format!("ok={da} status={dst}"));
    assert_eq!((la,lst),(da,dst), "close_vault diverges");

    // --- mgmt-fee wrong operator (validates the operator guard vs deployed) ---
    let (la,lc)=s_mgmt_fee_wrong_operator(pid(LOCAL),local_so()); let (da,dc)=s_mgmt_fee_wrong_operator(pid(DEPLOYED),deployed_so());
    line("mgmt_fee WRONG operator", format!("ok={la} err={lc}"), format!("ok={da} err={dc}"));
    assert_eq!((la,&lc),(da,&dc), "mgmt_fee(wrong operator) diverges");
}

#[test]
fn debug_deployed_bootstrap_steps() {
    let program = pid(DEPLOYED);
    let mut env = boot_env(program, deployed_so());
    set_clock(&mut env, BASE_TIME);
    let admin = env.admin.insecure_clone();
    let operator_pk = env.operator.pubkey();
    let admin_pool = inject_admin_pool_p(&mut env, program, admin.pubkey(), operator_pk);
    let mint = inject_mint(&mut env, 6);
    let (oracle,_) = pda(program, &[b"oracle_pool", admin_pool.as_array(), mint.as_array()]);
    let requester = Keypair::new(); env.svm.airdrop(&requester.pubkey(),5_000_000_000).unwrap();
    let mut feed=(FEED.len() as u32).to_le_bytes().to_vec(); feed.extend_from_slice(FEED.as_bytes());
    let r1 = sendp(&mut env, ixp(program, ix_disc("create_oracle_pool"), feed,
        vec![meta(requester.pubkey(),true,true),meta(admin_pool,false,true),meta(mint,false,true),meta(oracle,false,true),meta(SYSTEM,false,false)]), &[&requester]);
    println!("create_oracle_pool: {:?}", r1.as_ref().err().map(|e|e.lines().rev().take(3).collect::<Vec<_>>()));
    let r2 = sendp(&mut env, ixp(program, ix_disc("approve_oracle_pool"), vec![],
        vec![meta(admin.pubkey(),true,true),meta(admin_pool,false,true),meta(mint,false,true),meta(oracle,false,true)]), &[&admin]);
    println!("approve_oracle_pool: {:?}", r2.as_ref().err().map(|e|e.lines().rev().take(3).collect::<Vec<_>>()));
    let mm = Keypair::new(); env.svm.airdrop(&mm.pubkey(),50_000_000_000).unwrap();
    let (mmp,_) = pda(program, &[b"MoneyManagerPool", admin_pool.as_array(), mm.pubkey().as_array()]);
    let r3 = sendp(&mut env, ixp(program, ix_disc("create_money_manager_pool"), vec![],
        vec![meta(admin_pool,false,false),meta(mm.pubkey(),true,true),meta(mmp,false,true),meta(SYSTEM,false,false)]), &[&mm]);
    println!("create_money_manager_pool: {:?}", r3.as_ref().err().map(|e|e.lines().rev().take(3).collect::<Vec<_>>()));
    let price = inject_price_owned(&mut env, pyth_receiver(program), FEED, 150_000_000, -8, BASE_TIME);
    let (vault,_) = pda(program, &[b"VaultPool", admin_pool.as_array(), mm.pubkey().as_array(), &0u64.to_le_bytes()]);
    let (registry,_) = pda(program, &[b"AssetRegistry", vault.as_array()]);
    let mut a=Vec::new();
    for v in [10_000u64,2_592_000,10_000,604_800,3_888_000] { a.extend_from_slice(&v.to_le_bytes()); }
    for v in [1000u16,1500] { a.extend_from_slice(&v.to_le_bytes()); } a.push(1u8);
    let r4 = sendp(&mut env, ixp(program, ix_disc("create_vault"), a,
        vec![meta(admin_pool,false,true),meta(admin.pubkey(),false,true),meta(mm.pubkey(),true,true),meta(mmp,false,true),
             meta(vault,false,true),meta(registry,false,true),meta(oracle,false,false),meta(price,false,false),meta(mint,false,true),meta(SYSTEM,false,false)]), &[&mm]);
    if let Err(e)=&r4 { println!("=== create_vault FULL LOGS (deployed) ==="); for l in e.lines() { println!("LOG| {l}"); } }
}

#[test]
fn probe_deployed_mm_withdraw_period_bound() {
    let program = pid(DEPLOYED);
    let mut env = boot_env(program, deployed_so());
    set_clock(&mut env, BASE_TIME);
    let admin = env.admin.insecure_clone();
    let operator_pk = env.operator.pubkey();
    let admin_pool = inject_admin_pool_p(&mut env, program, admin.pubkey(), operator_pk);
    let mint = inject_mint(&mut env, 6);
    let (oracle,_) = pda(program, &[b"oracle_pool", admin_pool.as_array(), mint.as_array()]);
    let requester = Keypair::new(); env.svm.airdrop(&requester.pubkey(),5_000_000_000).unwrap();
    let mut feed=(FEED.len() as u32).to_le_bytes().to_vec(); feed.extend_from_slice(FEED.as_bytes());
    sendp(&mut env, ixp(program, ix_disc("create_oracle_pool"), feed, vec![meta(requester.pubkey(),true,true),meta(admin_pool,false,true),meta(mint,false,true),meta(oracle,false,true),meta(SYSTEM,false,false)]), &[&requester]).unwrap();
    sendp(&mut env, ixp(program, ix_disc("approve_oracle_pool"), vec![], vec![meta(admin.pubkey(),true,true),meta(admin_pool,false,true),meta(mint,false,true),meta(oracle,false,true)]), &[&admin]).unwrap();
    let mm = Keypair::new(); env.svm.airdrop(&mm.pubkey(),50_000_000_000).unwrap();
    let (mmp,_) = pda(program, &[b"MoneyManagerPool", admin_pool.as_array(), mm.pubkey().as_array()]);
    sendp(&mut env, ixp(program, ix_disc("create_money_manager_pool"), vec![], vec![meta(admin_pool,false,false),meta(mm.pubkey(),true,true),meta(mmp,false,true),meta(SYSTEM,false,false)]), &[&mm]).unwrap();
    let price = inject_price_owned(&mut env, pyth_receiver(program), FEED, 150_000_000, -8, BASE_TIME);
    let (vault,_) = pda(program, &[b"VaultPool", admin_pool.as_array(), mm.pubkey().as_array(), &0u64.to_le_bytes()]);
    let (registry,_) = pda(program, &[b"AssetRegistry", vault.as_array()]);
    // admin_pool config: withdraw_cooldown_max=3_888_000, fundrising_period_max=2_592_000, idle_period=7_776_000
    for wp in [259_200u64, 345_600, 432_000, 518_400, 604_800] {
        let mut a=Vec::new();
        a.extend_from_slice(&10_000u64.to_le_bytes()); a.extend_from_slice(&2_592_000u64.to_le_bytes());
        a.extend_from_slice(&10_000u64.to_le_bytes()); a.extend_from_slice(&wp.to_le_bytes());        // mm_withdraw_period = wp
        a.extend_from_slice(&3_888_000u64.to_le_bytes()); a.extend_from_slice(&1000u16.to_le_bytes());
        a.extend_from_slice(&1500u16.to_le_bytes()); a.push(1u8);
        let r = sendp(&mut env, ixp(program, ix_disc("create_vault"), a,
            vec![meta(admin_pool,false,true),meta(admin.pubkey(),false,true),meta(mm.pubkey(),true,true),meta(mmp,false,true),
                 meta(vault,false,true),meta(registry,false,true),meta(oracle,false,false),meta(price,false,false),meta(mint,false,true),meta(SYSTEM,false,false)]), &[&mm]);
        let ec = r.as_ref().err().map(|e| err_code(e)).unwrap_or_default();
        println!("mm_withdraw_period={:>10} -> {}", wp, if r.is_ok(){"ACCEPT".into()}else{format!("reject {}", ec)});
        if r.is_ok() { break; } // first accept creates the vault (index advances); stop
    }
}

#[test]
fn debug_deployed_close_vault() {
    let program = pid(DEPLOYED);
    let mut env = boot_env(program, deployed_so());
    let v = bootstrap_p(&mut env, program);
    let r = sendp(&mut env, ixp(program, ix_disc("close_vault"), vec![],
        vec![meta(v.admin_pool,false,false),meta(v.vault,false,true),meta(v.mm.pubkey(),true,true),meta(v.mint,false,true)]), &[&v.mm]);
    println!("=== deployed close_vault (fresh Active vault, total_shares=0) ===");
    if let Err(e)=&r { for l in e.lines().filter(|l|l.contains("AnchorError")||l.contains("Error")||l.contains("thrown")) { println!("LOG| {l}"); } }
    else { println!("ACCEPTED"); }
}
