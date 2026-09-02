//! Differential parity tests for crafted exploit and economic scenarios. Each runs the same
//! transaction against both the reconstruction and the dumped deployed `.so` and asserts they agree
//! on accept/reject, error code, and resulting state — pinning the checks and gates that make the
//! reconstruction faithful (recipient validation, cooldown/trading/fee timing, canonical-price and
//! signer construction in the swap CPI, and the absence of `dummy_swap`).
mod common;
use common::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn make_investor(env: &mut Env, program: Address, v: &DiffVault) -> (Keypair, Address) {
    let investor = Keypair::new(); env.svm.airdrop(&investor.pubkey(), 5_000_000_000).unwrap();
    let (ip, _) = pda(program, &[b"InvestorPool", investor.pubkey().as_array(), v.admin_pool.as_array(), v.vault.as_array(), v.mint.as_array()]);
    sendp(env, ixp(program, ix_disc("create_investor_pool"), vec![],
        vec![meta(investor.pubkey(),true,true),meta(v.admin_pool,false,false),meta(v.vault,false,true),meta(v.mint,false,true),meta(ip,false,true),meta(SYSTEM,false,false)]), &[&investor]).unwrap();
    (investor, ip)
}
fn deposit(env: &mut Env, program: Address, v: &DiffVault, investor: &Keypair, ip: Address, from: Address, to: Address, amount: u64) {
    sendp(env, ixp(program, ix_disc("deposit_token_fund"), amount.to_le_bytes().to_vec(),
        vec![meta(investor.pubkey(),true,true),meta(v.admin_pool,false,false),meta(v.vault,false,true),meta(v.registry,false,true),
             meta(ip,false,true),meta(v.oracle,false,true),meta(from,false,true),meta(to,false,true),meta(v.mint,false,true),
             meta(v.price,false,false),meta(spl_token_id(),false,false),meta(SYSTEM,false,false)]), &[investor]).unwrap();
}
fn withdraw_metas(v: &DiffVault, investor: &Keypair, ip: Address, route: &[solana_instruction::account_meta::AccountMeta]) -> Vec<solana_instruction::account_meta::AccountMeta> {
    let mut m = vec![
        meta(investor.pubkey(),true,true), meta(v.mm.pubkey(),false,true), meta(v.admin_pool,false,false),
        meta(v.vault,false,true), meta(v.registry,false,true), meta(ip,false,true),
        meta(spl_token_id(),false,false), meta(token_2022_id(),false,false), meta(SYSTEM,false,false),
    ];
    m.extend_from_slice(route); m
}

// Withdraw fee-recipient redirection is rejected: a redirected payout/fee ATA cannot steal funds.
fn withdraw_fee_redirect(program: Address, so: &str) -> (bool, u64) {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    let (investor, ip) = make_investor(&mut env, program, &v);
    let from = inject_token_account(&mut env, v.mint, investor.pubkey(), 100_000_000);
    let to = inject_token_account(&mut env, v.mint, v.vault, 0);
    deposit(&mut env, program, &v, &investor, ip, from, to, 100_000_000);
    let t = BASE_TIME + 6_480_000 + 10;
    set_clock(&mut env, t);
    let fresh = inject_price_owned(&mut env, pyth_receiver_id(), FEED, 300_000_000, -8, t);
    let fake_mgr = inject_token_account(&mut env, v.mint, Keypair::new().pubkey(), 0);
    let fake_proto = inject_token_account(&mut env, v.mint, Keypair::new().pubkey(), 0);
    let route = vec![meta(v.oracle,false,true), meta(fresh,false,false), meta(v.mint,false,false),
        meta(to,false,true), meta(from,false,true), meta(fake_mgr,false,true), meta(fake_proto,false,true)];
    let r = sendp(&mut env, ixp(program, ix_disc("withdraw_token_fund"), 100_000_000u64.to_le_bytes().to_vec(), withdraw_metas(&v,&investor,ip,&route)), &[&investor]);
    (r.is_ok(), token_balance(&env, fake_mgr) + token_balance(&env, fake_proto))
}
#[test]
fn withdraw_fee_recipient_redirect_rejected_on_both() {
    let [(lp,ls),(dp,ds)] = both_programs();
    assert_eq!(withdraw_fee_redirect(lp,ls), withdraw_fee_redirect(dp,ds), "must match deployed");
    let (ok, stolen) = withdraw_fee_redirect(lp, ls);
    assert!(!ok && stolen == 0, "fee redirection must be rejected (matches deployed)");
}

// Withdraw cooldown baseline: unlock at created_at + raise_period + withdraw_cooldown.
fn withdraw_unlocked_at(program: Address, so: &str, offset: i64) -> bool {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    let (investor, ip) = make_investor(&mut env, program, &v);
    let from = inject_token_account(&mut env, v.mint, investor.pubkey(), 100_000_000);
    let to = inject_token_account(&mut env, v.mint, v.vault, 0);
    deposit(&mut env, program, &v, &investor, ip, from, to, 100_000_000);
    let t = BASE_TIME + offset;
    set_clock(&mut env, t);
    let fresh = inject_price_owned(&mut env, pyth_receiver_id(), FEED, 150_000_000, -8, t);
    let mgr = inject_token_account(&mut env, v.mint, v.mm.pubkey(), 0);
    let admin_pk = env.admin.pubkey();
    let proto = inject_token_account(&mut env, v.mint, admin_pk, 0);
    let route = vec![meta(v.oracle,false,true), meta(fresh,false,false), meta(v.mint,false,false),
        meta(to,false,true), meta(from,false,true), meta(mgr,false,true), meta(proto,false,true)];
    sendp(&mut env, ixp(program, ix_disc("withdraw_token_fund"), 100_000_000u64.to_le_bytes().to_vec(), withdraw_metas(&v,&investor,ip,&route)), &[&investor]).is_ok()
}
#[test]
fn withdraw_cooldown_baseline_matches_deployed() {
    let [(lp,ls),(dp,ds)] = both_programs();
    assert_eq!(withdraw_unlocked_at(lp,ls,6_480_000-1), withdraw_unlocked_at(dp,ds,6_480_000-1));
    assert_eq!(withdraw_unlocked_at(lp,ls,6_480_000), withdraw_unlocked_at(dp,ds,6_480_000));
    assert!(!withdraw_unlocked_at(lp,ls,6_480_000-1) && withdraw_unlocked_at(lp,ls,6_480_000),
        "unlock exactly at created_at+raise_period+withdraw_cooldown");
}

// Swap gates: trading is allowed only after the fundraise ends and once the minimum raise is reached.
fn swap_during_fundraise(program: Address, so: &str) -> String {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    load_jupiter_mock(&mut env);
    let mm = v.mm.insecure_clone(); let admin = env.admin.insecure_clone(); let admin_pk = admin.pubkey();
    let out_mint = inject_mint(&mut env, 6);
    let out_oracle = approved_oracle_for(&mut env, program, v.admin_pool, &admin, out_mint, FEED2);
    let vin = inject_token_account(&mut env, v.mint, v.vault, 100_000_000);
    let vout = inject_token_account(&mut env, out_mint, v.vault, 0);
    let (registry,_) = pda(program, &[b"AssetRegistry", v.vault.as_array()]);
    let out_price = inject_price_owned(&mut env, pyth_receiver_id(), FEED2, 100_000_000, -8, BASE_TIME);
    let mut data = 1_000_000u64.to_le_bytes().to_vec(); data.extend_from_slice(&1_000_000u64.to_le_bytes());
    let mut args = (data.len() as u32).to_le_bytes().to_vec(); args.extend_from_slice(&data);
    let mm_in = inject_token_account(&mut env, v.mint, mm.pubkey(), 0);
    let mm_out = inject_token_account(&mut env, out_mint, mm.pubkey(), 5_000_000);
    let mut metas = vec![
        meta(v.admin_pool,false,true), meta(admin_pk,false,true), meta(mm.pubkey(),true,true), meta(v.mint,false,true),
        meta(v.vault,false,true), meta(registry,false,true),
        meta(v.mint,false,false), meta(spl_token_id(),false,false), meta(out_mint,false,false), meta(spl_token_id(),false,false),
        meta(vin,false,true), meta(vout,false,true),
        meta(v.oracle,false,true), meta(out_oracle,false,true), meta(v.price,false,false), meta(out_price,false,false),
        meta(jupiter_program_id(),false,false), meta(SYSTEM,false,false),
    ];
    metas.extend_from_slice(&[meta(spl_token_id(),false,false), meta(vin,false,true), meta(mm_in,false,true),
        meta(mm_out,false,true), meta(vout,false,true), meta(v.vault,false,false), meta(mm.pubkey(),true,false)]);
    // clock is BASE_TIME (during the fundraise period) => trading-period gate fires first
    sendp(&mut env, ixp(program, ix_disc("swap"), args, metas), &[&mm]).err().map(|e| err_code(&e)).unwrap_or("ACCEPT".into())
}
#[test]
fn swap_trading_period_gate_matches_deployed() {
    let [(lp,ls),(dp,ds)] = both_programs();
    let (l, d) = (swap_during_fundraise(lp, ls), swap_during_fundraise(dp, ds));
    assert_eq!(l, d, "swap during fundraise must be rejected identically");
    assert_eq!(l, "6040", "InvalidTradingPeriod during fundraise (matches deployed)");
}

// Management fee on a never-traded vault is refused with NoTradesYet.
fn mgmt_fee_untraded(program: Address, so: &str) -> String {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    let operator = env.operator.insecure_clone(); env.svm.airdrop(&operator.pubkey(),1_000_000_000).unwrap();
    let vault_ata = inject_token_account(&mut env, v.mint, v.vault, 100_000_000);
    let mgr = inject_token_account(&mut env, v.mint, v.mm.pubkey(), 0);
    let admin_pk = env.admin.pubkey();
    let proto = inject_token_account(&mut env, v.mint, admin_pk, 0);
    set_clock(&mut env, BASE_TIME + 10_000_000);
    let mut metas = vec![meta(v.admin_pool,false,false), meta(operator.pubkey(),true,true), meta(v.vault,false,true),
        meta(v.registry,false,false), meta(spl_token_id(),false,false), meta(token_2022_id(),false,false)];
    metas.extend_from_slice(&[meta(v.mint,false,false), meta(vault_ata,false,true), meta(mgr,false,true), meta(proto,false,true)]);
    sendp(&mut env, ixp(program, ix_disc("withdraw_money_management_fee"), vec![], metas), &[&operator]).err().map(|e| err_code(&e)).unwrap_or("ACCEPT".into())
}
#[test]
fn mgmt_fee_no_trades_gate_matches_deployed() {
    let [(lp,ls),(dp,ds)] = both_programs();
    assert_eq!(mgmt_fee_untraded(lp,ls), mgmt_fee_untraded(dp,ds), "untraded mgmt-fee must match");
    assert_eq!(mgmt_fee_untraded(lp,ls), "6064", "NoTradesYet on an untraded vault");
}
// Management-fee recipient validation: a redirected fee-recipient ATA is rejected identically on both
// programs. A real trade (via the mock) leaves the registry as [base, asset2], so the fee call needs
// both asset groups; this redirects the base leg's recipients.
fn mgmt_fee_redirect(program: Address, so: &str) -> (String, u64) {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    let admin = env.admin.insecure_clone();
    let mm = v.mm.insecure_clone();
    let (base_ata, asset2, _, _, asset2_ata) =
        trade_vault(&mut env, program, v.admin_pool, &admin, &mm, v.mint, v.vault, v.registry, v.oracle, v.price, 100_000_000);
    let operator = env.operator.insecure_clone();
    env.svm.airdrop(&operator.pubkey(), 1_000_000_000).unwrap();
    // 8 days after the trade: past the mm_withdraw_period minimum, before the dormancy window — the
    // clean window that isolates the recipient check from the period and dormancy gates.
    set_clock(&mut env, BASE_TIME + 2_592_000 + 1 + 691_200);
    let admin_pk = admin.pubkey();
    // base leg: REDIRECTED recipients; asset2 leg: correct recipients
    let fake_mgr = inject_token_account(&mut env, v.mint, Keypair::new().pubkey(), 0);
    let fake_proto = inject_token_account(&mut env, v.mint, Keypair::new().pubkey(), 0);
    let a2_mgr = inject_token_account(&mut env, asset2, mm.pubkey(), 0);
    let a2_proto = inject_token_account(&mut env, asset2, admin_pk, 0);
    let mut metas = vec![meta(v.admin_pool, false, false), meta(operator.pubkey(), true, true), meta(v.vault, false, true),
        meta(v.registry, false, false), meta(spl_token_id(), false, false), meta(token_2022_id(), false, false)];
    metas.extend_from_slice(&[
        meta(v.mint, false, false), meta(base_ata, false, true), meta(fake_mgr, false, true), meta(fake_proto, false, true),
        meta(asset2, false, false), meta(asset2_ata, false, true), meta(a2_mgr, false, true), meta(a2_proto, false, true),
    ]);
    let r = sendp(&mut env, ixp(program, ix_disc("withdraw_money_management_fee"), vec![], metas), &[&operator]);
    let stolen = token_balance(&env, fake_mgr) + token_balance(&env, fake_proto);
    (r.map(|_| "ACCEPT".to_string()).unwrap_or_else(|e| format!("reject {}", err_code(&e))), stolen)
}
#[test]
fn mgmt_fee_recipient_redirect_rejected_on_both() {
    let [(lp, ls), (dp, ds)] = both_programs();
    assert_eq!(mgmt_fee_redirect(lp, ls), mgmt_fee_redirect(dp, ds),
        "redirected mgmt-fee recipient must be rejected identically to the deployed");
    let (outcome, stolen) = mgmt_fee_redirect(lp, ls);
    assert!(outcome.starts_with("reject"), "must reject a redirected recipient, got {outcome}");
    assert_eq!(stolen, 0, "no fee redirected");
}

// Deposits are only accepted during the raise period (now <= created_at + raise_period); a late
// deposit is rejected identically on both programs.
fn deposit_at_offset(program: Address, so: &str, offset: i64) -> String {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program); // bootstrap_p vaults are open-ended
    let (investor, ip) = make_investor(&mut env, program, &v);
    let from = inject_token_account(&mut env, v.mint, investor.pubkey(), 100_000_000);
    let to = inject_token_account(&mut env, v.mint, v.vault, 0);
    let t = BASE_TIME + offset;
    set_clock(&mut env, t);
    let fresh = inject_price_owned(&mut env, pyth_receiver_id(), FEED, 150_000_000, -8, t);
    sendp(&mut env, ixp(program, ix_disc("deposit_token_fund"), 100_000_000u64.to_le_bytes().to_vec(),
        vec![meta(investor.pubkey(),true,true),meta(v.admin_pool,false,false),meta(v.vault,false,true),meta(v.registry,false,true),
             meta(ip,false,true),meta(v.oracle,false,true),meta(from,false,true),meta(to,false,true),meta(v.mint,false,true),
             meta(fresh,false,false),meta(spl_token_id(),false,false),meta(SYSTEM,false,false)]), &[&investor])
        .map(|_| "ACCEPT".to_string()).unwrap_or_else(|e| format!("reject {}", err_code(&e)))
}
#[test]
fn deposit_raise_period_gate_matches_deployed() {
    let [(lp,ls),(dp,ds)] = both_programs();
    // during the raise -> accepted on both
    assert_eq!(deposit_at_offset(lp,ls,1_000_000), deposit_at_offset(dp,ds,1_000_000));
    assert_eq!(deposit_at_offset(lp,ls,1_000_000), "ACCEPT");
    // after the raise (raise_period = 2_592_000) -> rejected identically on both
    assert_eq!(deposit_at_offset(lp,ls,2_592_001), deposit_at_offset(dp,ds,2_592_001),
        "late deposit must be rejected identically to deployed");
    assert_ne!(deposit_at_offset(lp,ls,2_592_001), "ACCEPT", "late deposit must be rejected");
}

// Deposit minimum: the raw `amount` must be >= min_contribute (10_000); a below-minimum deposit is
// rejected with InvalidDepositAmount (6011) on both programs.
fn first_deposit_amount(program: Address, so: &str, amount: u64) -> String {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    let (investor, ip) = make_investor(&mut env, program, &v);
    let from = inject_token_account(&mut env, v.mint, investor.pubkey(), amount.max(1));
    let to = inject_token_account(&mut env, v.mint, v.vault, 0);
    sendp(&mut env, ixp(program, ix_disc("deposit_token_fund"), amount.to_le_bytes().to_vec(),
        vec![meta(investor.pubkey(),true,true),meta(v.admin_pool,false,false),meta(v.vault,false,true),meta(v.registry,false,true),
             meta(ip,false,true),meta(v.oracle,false,true),meta(from,false,true),meta(to,false,true),meta(v.mint,false,true),
             meta(v.price,false,false),meta(spl_token_id(),false,false),meta(SYSTEM,false,false)]), &[&investor])
        .map(|_| "ACCEPT".to_string()).unwrap_or_else(|e| format!("reject {}", err_code(&e)))
}
#[test]
fn deposit_minimum_matches_deployed() {
    let [(lp,ls),(dp,ds)] = both_programs();
    for amount in [9_999u64, 10_000, 20_000] {
        assert_eq!(first_deposit_amount(lp,ls,amount), first_deposit_amount(dp,ds,amount),
            "deposit amount={amount} must adjudicate identically to deployed");
    }
    assert_eq!(first_deposit_amount(lp,ls,9_999), "reject 6011", "below-min -> InvalidDepositAmount");
    assert_eq!(first_deposit_amount(lp,ls,10_000), "ACCEPT", "at-min -> accepted");
}

// Deposit share pricing is against the tracked `raised_amount_usd` (cost basis), not live holdings, so
// it is donation-resistant and reads no per-asset legs from remaining_accounts. This donates tokens
// into a vault ATA before a victim deposit and asserts the victim still receives fair shares on both.

// (a) donation-resistance: attacker tiny-deposits, DONATES 100 tokens to the vault ATA, victim
// deposits fairly. A holdings NAV would dilute the victim; both programs mint the victim fair shares.
fn inflation_victim_shares(program: Address, so: &str) -> u64 {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    let (attacker, aip) = make_investor(&mut env, program, &v);
    let afrom = inject_token_account(&mut env, v.mint, attacker.pubkey(), 10_000);
    let vault_ata = inject_token_account(&mut env, v.mint, v.vault, 0);
    deposit(&mut env, program, &v, &attacker, aip, afrom, vault_ata, 10_000);
    // donate 100 tokens straight into the vault ATA (would inflate a holdings NAV)
    inject_token_account(&mut env, v.mint, v.vault, 10_000 + 100_000_000);
    let (victim, vip) = make_investor(&mut env, program, &v);
    let vfrom = inject_token_account(&mut env, v.mint, victim.pubkey(), 100_000_000);
    deposit(&mut env, program, &v, &victim, vip, vfrom, vault_ata, 100_000_000);
    read_u64(&env.svm.get_account(&vip).unwrap().data, 137)
}
#[test]
fn deposit_donation_resistant_on_both() {
    let [(lp,ls),(dp,ds)] = both_programs();
    let (local_shares, deployed_shares) = (inflation_victim_shares(lp,ls), inflation_victim_shares(dp,ds));
    assert_eq!(local_shares, deployed_shares, "victim shares must match deployed");
    assert_eq!(local_shares, 100_000_000,
        "victim gets fair shares despite the donation (raised-based NAV, donation-resistant)");
}

// (b) no legs required: with a registered asset held by the vault, a deposit with EMPTY
// remaining_accounts is accepted on both, and the second depositor's shares reflect the raised
// denominator (150e6 -> 100e6 shares), NOT the holdings that include the extra asset.
fn deposit_registered_asset_no_legs(program: Address, so: &str) -> (String, u64) {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    let (d1, ip1) = make_investor(&mut env, program, &v);
    let from1 = inject_token_account(&mut env, v.mint, d1.pubkey(), 100_000_000);
    let vault_ata = inject_token_account(&mut env, v.mint, v.vault, 0);
    deposit(&mut env, program, &v, &d1, ip1, from1, vault_ata, 100_000_000);
    let asset2 = inject_mint(&mut env, 6);
    inject_token_account(&mut env, asset2, v.vault, 50_000_000);
    inject_registry_with_asset(&mut env, program, v.vault, asset2);
    let (d2, ip2) = make_investor(&mut env, program, &v);
    let from2 = inject_token_account(&mut env, v.mint, d2.pubkey(), 100_000_000);
    let r = sendp(&mut env, ixp(program, ix_disc("deposit_token_fund"), 100_000_000u64.to_le_bytes().to_vec(),
        vec![meta(d2.pubkey(),true,true),meta(v.admin_pool,false,false),meta(v.vault,false,true),meta(v.registry,false,true),
             meta(ip2,false,true),meta(v.oracle,false,true),meta(from2,false,true),meta(vault_ata,false,true),meta(v.mint,false,true),
             meta(v.price,false,false),meta(spl_token_id(),false,false),meta(SYSTEM,false,false)]), &[&d2]);
    let shares2 = if r.is_ok() { read_u64(&env.svm.get_account(&ip2).unwrap().data, 137) } else { 0 };
    (r.map(|_| "ACCEPT".to_string()).unwrap_or_else(|e| format!("reject {}", err_code(&e))), shares2)
}
#[test]
fn deposit_ignores_asset_legs_on_both() {
    let [(lp,ls),(dp,ds)] = both_programs();
    assert_eq!(deposit_registered_asset_no_legs(lp,ls), deposit_registered_asset_no_legs(dp,ds),
        "no-legs deposit with a registered asset must adjudicate identically to deployed");
    assert_eq!(deposit_registered_asset_no_legs(lp,ls), ("ACCEPT".to_string(), 100_000_000),
        "accepted with empty remaining_accounts; shares priced on raised (150e6 -> 100e6), not holdings");
}

// Withdraw error-code fidelity on two reject paths: over-withdraw returns InsufficientFunds (6007) and
// a stale price surfaces the raw Pyth error (16000) — identically on both programs. Helper deposits,
// warps past cooldown, then withdraws.
fn withdraw_reject(program: Address, so: &str, withdraw_shares: u64, price_stamp: i64) -> String {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    let (investor, ip) = make_investor(&mut env, program, &v);
    let from = inject_token_account(&mut env, v.mint, investor.pubkey(), 100_000_000);
    let vault_ata = inject_token_account(&mut env, v.mint, v.vault, 0);
    deposit(&mut env, program, &v, &investor, ip, from, vault_ata, 100_000_000);
    let t = BASE_TIME + 6_480_000 + 10;
    set_clock(&mut env, t);
    let price = inject_price_owned(&mut env, pyth_receiver_id(), FEED, 150_000_000, -8, price_stamp);
    let mgr = inject_token_account(&mut env, v.mint, v.mm.pubkey(), 0);
    let admin_pk = env.admin.pubkey();
    let proto = inject_token_account(&mut env, v.mint, admin_pk, 0);
    let route = vec![meta(v.oracle,false,true), meta(price,false,false), meta(v.mint,false,false),
        meta(vault_ata,false,true), meta(from,false,true), meta(mgr,false,true), meta(proto,false,true)];
    sendp(&mut env, ixp(program, ix_disc("withdraw_token_fund"), withdraw_shares.to_le_bytes().to_vec(), withdraw_metas(&v,&investor,ip,&route)), &[&investor])
        .map(|_| "ACCEPT".to_string()).unwrap_or_else(|e| format!("reject {}", err_code(&e)))
}
#[test]
fn withdraw_over_amount_error_matches_deployed() {
    let [(lp,ls),(dp,ds)] = both_programs();
    // request more shares than owned (100e6) at a fresh price
    assert_eq!(withdraw_reject(lp,ls,100_000_001,BASE_TIME+6_480_000+10), withdraw_reject(dp,ds,100_000_001,BASE_TIME+6_480_000+10));
    assert_eq!(withdraw_reject(lp,ls,100_000_001,BASE_TIME+6_480_000+10), "reject 6007", "over-withdraw -> InsufficientFunds");
}
#[test]
fn withdraw_stale_price_error_matches_deployed() {
    let [(lp,ls),(dp,ds)] = both_programs();
    // valid share count but a price stamped at BASE_TIME (>72 days stale vs the withdraw clock)
    assert_eq!(withdraw_reject(lp,ls,100_000_000,BASE_TIME), withdraw_reject(dp,ds,100_000_000,BASE_TIME));
    assert_eq!(withdraw_reject(lp,ls,100_000_000,BASE_TIME), "reject 16000", "stale price -> raw Pyth PriceTooOld (16000)");
}

// The full swap executes identically on both programs, exercising the Jupiter CPI (only the vault PDA
// is granted signer), the canonical Pyth price-account check (the sponsored push-oracle feed account),
// and both-leg registry tracking (input + output registered). The jupiter-mock sources output from its
// own [b"pool"] PDA.
fn execute_swap(program: Address, so: &str) -> (String, u64, u64, u32) {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    load_jupiter_mock(&mut env);
    set_vault_raised(&mut env, v.vault, 150_000_000);
    let t = BASE_TIME + 2_592_000 + 1;
    set_clock(&mut env, t);
    let base_price = inject_canonical_price(&mut env, FEED, 150_000_000, -8, t);
    let asset2 = inject_mint(&mut env, 6);
    let admin = env.admin.insecure_clone();
    let asset2_oracle = approved_oracle_for(&mut env, program, v.admin_pool, &admin, asset2, FEED2);
    let asset2_price = inject_canonical_price(&mut env, FEED2, 100_000_000, -8, t);
    let (registry, _) = pda(program, &[b"AssetRegistry", v.vault.as_array()]);
    let vin = inject_token_account(&mut env, v.mint, v.vault, 100_000_000);
    let vout = inject_token_account(&mut env, asset2, v.vault, 0);
    let mm = v.mm.insecure_clone();
    let mm_base = inject_token_account(&mut env, v.mint, mm.pubkey(), 0);
    let pool = jupiter_pool_pda();
    let pool_asset2 = inject_token_account(&mut env, asset2, pool, 15_000_000);
    let admin_pk = admin.pubkey();
    let mut route = 10_000_000u64.to_le_bytes().to_vec();
    route.extend_from_slice(&15_000_000u64.to_le_bytes());
    let mut args = (route.len() as u32).to_le_bytes().to_vec();
    args.extend_from_slice(&route);
    let mut metas = vec![
        meta(v.admin_pool, false, true), meta(admin_pk, false, true), meta(mm.pubkey(), true, true), meta(v.mint, false, true),
        meta(v.vault, false, true), meta(registry, false, true),
        meta(v.mint, false, false), meta(spl_token_id(), false, false), meta(asset2, false, false), meta(spl_token_id(), false, false),
        meta(vin, false, true), meta(vout, false, true),
        meta(v.oracle, false, true), meta(asset2_oracle, false, true), meta(base_price, false, false), meta(asset2_price, false, false),
        meta(jupiter_program_id(), false, false), meta(SYSTEM, false, false),
    ];
    metas.extend_from_slice(&[
        meta(spl_token_id(), false, false), meta(vin, false, true), meta(mm_base, false, true),
        meta(pool_asset2, false, true), meta(vout, false, true), meta(v.vault, false, false), meta(pool, false, false),
    ]);
    match sendp(&mut env, ixp(program, ix_disc("swap"), args, metas), &[&mm]) {
        Ok(()) => ("ACCEPT".into(), token_balance(&env, vin), token_balance(&env, vout), registry_len(&env, registry)),
        Err(e) => (format!("reject {}", err_code(&e)), 0, 0, 0),
    }
}
#[test]
fn swap_executes_identically_on_both() {
    let [(lp, ls), (dp, ds)] = both_programs();
    let (local, deployed) = (execute_swap(lp, ls), execute_swap(dp, ds));
    assert_eq!(local, deployed, "swap must execute identically to the deployed program");
    assert_eq!(local, ("ACCEPT".into(), 90_000_000, 15_000_000, 2),
        "spent 10 input, received 15 output, registry = [input, output]");
}

// The swap rejects a non-canonical price account: a randomly-addressed price account is
// InvalidPriceOracle (6038) on both programs.
fn swap_noncanonical_price(program: Address, so: &str) -> String {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    load_jupiter_mock(&mut env);
    set_vault_raised(&mut env, v.vault, 150_000_000);
    let t = BASE_TIME + 2_592_000 + 1;
    set_clock(&mut env, t);
    // base price at a NON-canonical (random) address -> should be rejected
    let base_price = inject_price_owned(&mut env, pyth_receiver_id(), FEED, 150_000_000, -8, t);
    let asset2 = inject_mint(&mut env, 6);
    let admin = env.admin.insecure_clone();
    let asset2_oracle = approved_oracle_for(&mut env, program, v.admin_pool, &admin, asset2, FEED2);
    let asset2_price = inject_canonical_price(&mut env, FEED2, 100_000_000, -8, t);
    let (registry, _) = pda(program, &[b"AssetRegistry", v.vault.as_array()]);
    let vin = inject_token_account(&mut env, v.mint, v.vault, 100_000_000);
    let vout = inject_token_account(&mut env, asset2, v.vault, 0);
    let mm = v.mm.insecure_clone();
    let mm_base = inject_token_account(&mut env, v.mint, mm.pubkey(), 0);
    let pool = jupiter_pool_pda();
    let pool_asset2 = inject_token_account(&mut env, asset2, pool, 15_000_000);
    let admin_pk = admin.pubkey();
    let mut route = 10_000_000u64.to_le_bytes().to_vec();
    route.extend_from_slice(&15_000_000u64.to_le_bytes());
    let mut args = (route.len() as u32).to_le_bytes().to_vec();
    args.extend_from_slice(&route);
    let mut metas = vec![
        meta(v.admin_pool, false, true), meta(admin_pk, false, true), meta(mm.pubkey(), true, true), meta(v.mint, false, true),
        meta(v.vault, false, true), meta(registry, false, true),
        meta(v.mint, false, false), meta(spl_token_id(), false, false), meta(asset2, false, false), meta(spl_token_id(), false, false),
        meta(vin, false, true), meta(vout, false, true),
        meta(v.oracle, false, true), meta(asset2_oracle, false, true), meta(base_price, false, false), meta(asset2_price, false, false),
        meta(jupiter_program_id(), false, false), meta(SYSTEM, false, false),
    ];
    metas.extend_from_slice(&[
        meta(spl_token_id(), false, false), meta(vin, false, true), meta(mm_base, false, true),
        meta(pool_asset2, false, true), meta(vout, false, true), meta(v.vault, false, false), meta(pool, false, false),
    ]);
    sendp(&mut env, ixp(program, ix_disc("swap"), args, metas), &[&mm])
        .map(|_| "ACCEPT".to_string()).unwrap_or_else(|e| format!("reject {}", err_code(&e)))
}
#[test]
fn swap_noncanonical_price_rejected_on_both() {
    let [(lp, ls), (dp, ds)] = both_programs();
    assert_eq!(swap_noncanonical_price(lp, ls), swap_noncanonical_price(dp, ds),
        "a non-canonical price account must be rejected identically to the deployed");
    assert_eq!(swap_noncanonical_price(lp, ls), "reject 6038", "InvalidPriceOracle");
}

// Management-fee timing gates. A fee withdrawal is refused (a) before one
// mm_withdraw_period has elapsed since last_mm_fee_withdraw_at (initialized to created_at+raise_period)
// -> OutsideWithdrawPeriod(6035), and (b) once the vault is dormant, i.e. > idle_period after the last
// trade -> VaultIsDormant(6053). Returns the outcome (with fee split on accept, to also check amounts).
fn mgmt_fee_at(program: Address, so: &str, warp: i64) -> String {
    let mut env = boot_env(program, so);
    let v = bootstrap_p(&mut env, program);
    let admin = env.admin.insecure_clone();
    let mm = v.mm.insecure_clone();
    let (base_ata, asset2, _, _, asset2_ata) =
        trade_vault(&mut env, program, v.admin_pool, &admin, &mm, v.mint, v.vault, v.registry, v.oracle, v.price, 100_000_000);
    let operator = env.operator.insecure_clone();
    env.svm.airdrop(&operator.pubkey(), 1_000_000_000).unwrap();
    set_clock(&mut env, warp);
    let admin_pk = admin.pubkey();
    let bmgr = inject_token_account(&mut env, v.mint, mm.pubkey(), 0);
    let bproto = inject_token_account(&mut env, v.mint, admin_pk, 0);
    let a2mgr = inject_token_account(&mut env, asset2, mm.pubkey(), 0);
    let a2proto = inject_token_account(&mut env, asset2, admin_pk, 0);
    let mut metas = vec![meta(v.admin_pool, false, false), meta(operator.pubkey(), true, true), meta(v.vault, false, true),
        meta(v.registry, false, false), meta(spl_token_id(), false, false), meta(token_2022_id(), false, false)];
    metas.extend_from_slice(&[meta(v.mint, false, false), meta(base_ata, false, true), meta(bmgr, false, true), meta(bproto, false, true),
        meta(asset2, false, false), meta(asset2_ata, false, true), meta(a2mgr, false, true), meta(a2proto, false, true)]);
    match sendp(&mut env, ixp(program, ix_disc("withdraw_money_management_fee"), vec![], metas), &[&operator]) {
        Ok(()) => format!("ACCEPT mgr={} proto={}", token_balance(&env, bmgr), token_balance(&env, bproto)),
        Err(e) => format!("reject {}", err_code(&e)),
    }
}
#[test]
fn mgmt_fee_timing_gates_match_deployed() {
    let [(lp, ls), (dp, ds)] = both_programs();
    let t0 = BASE_TIME + 2_592_000 + 1; // last_trade_at set by trade_vault
    let period_boundary = BASE_TIME + 2_592_000 + 604_800; // created_at + raise_period + mm_withdraw_period
    for (label, warp) in [
        ("before period", period_boundary - 1),
        ("at period", period_boundary),
        ("well within", t0 + 2_592_000),
        ("at dormancy edge", t0 + 7_776_000),
        ("past dormancy", t0 + 7_776_001),
    ] {
        assert_eq!(mgmt_fee_at(lp, ls, warp), mgmt_fee_at(dp, ds, warp),
            "mgmt-fee at '{label}' must match the deployed (outcome + fee amounts)");
    }
    // exact edge behaviors
    assert_eq!(mgmt_fee_at(lp, ls, period_boundary - 1), "reject 6035", "too-soon -> OutsideWithdrawPeriod");
    assert!(mgmt_fee_at(lp, ls, period_boundary).starts_with("ACCEPT"), "claimable at the period boundary");
    assert!(mgmt_fee_at(lp, ls, t0 + 7_776_000).starts_with("ACCEPT"), "still active at the dormancy edge");
    assert_eq!(mgmt_fee_at(lp, ls, t0 + 7_776_001), "reject 6053", "past idle_period -> VaultIsDormant");
}

// NOTE: there is intentionally no large-profit performance-fee parity test here, because the withdraw
// perf-fee model is a known open divergence (see RPC_FINDINGS.md "Known divergences"). What is known:
//   * base-token appreciation alone charges no perf fee on the deployed program (it does not mark held
//     base to market), whereas the reconstruction charges on the full oracle gain;
//   * on a real trading gain both charge, same 20/80 protocol/manager split, but the deployed program's
//     total is ≈ 90% of the reconstruction's — the gain/value formula differs;
//   * the deployed program's withdraw valuation also applies a canonical-price account check once the
//     registry holds a non-base asset, which the reconstruction does not.

// `dummy_swap` is absent from both programs: its discriminator returns InstructionFallbackNotFound.
#[test]
fn dummy_swap_absent_from_both_programs() {
    for (program, so) in both_programs() {
        let mut env = boot_env(program, so);
        let signer = Keypair::new(); env.svm.airdrop(&signer.pubkey(), 1_000_000_000).unwrap();
        let e = sendp(&mut env, ixp(program, ix_disc("dummy_swap"), vec![], vec![meta(signer.pubkey(),true,true)]), &[&signer]).unwrap_err();
        assert!(e.contains("InstructionFallbackNotFound") || e.contains("Error Number: 101"),
            "dummy_swap must be absent on {program}");
    }
}

// Conversely, every other instruction the recovered IDL lists must actually dispatch on the deployed
// bytecode. A present instruction fails deserialization/accounts validation; an absent one returns
// InstructionFallbackNotFound. This drives each discriminator that no other test exercises against the
// deployed program with empty data and asserts it is not absent.
#[test]
fn all_idl_instructions_dispatch_on_deployed() {
    let program = pidof(DEPLOYED_ID);
    let names = [
        "admin_accept_ownership", "admin_transfer_ownership",
        "admin_update_contribution_amount_min_usd", "admin_update_dust_threshold_usd",
        "admin_update_fundrising_period_max", "admin_update_idle_period",
        "admin_update_max_asset_count", "admin_update_max_slippage_bps",
        "admin_update_operator", "admin_update_oracle_max_age",
        "admin_update_raise_amount_min_usd", "admin_update_withdraw_cooldown_max",
        "close_oracle_pool", "update_oracle_pool",
        "set_trading_delegate", "revoke_trading_delegate", "create_admin_pool",
    ];
    for name in names {
        let mut env = boot_env(program, deployed_so());
        let signer = Keypair::new(); env.svm.airdrop(&signer.pubkey(), 1_000_000_000).unwrap();
        let err = sendp(&mut env, ixp(program, ix_disc(name), vec![],
            vec![meta(signer.pubkey(), true, true)]), &[&signer]).unwrap_err();
        let absent = err.contains("InstructionFallbackNotFound") || err.contains("Error Number: 101");
        assert!(!absent, "{name} is absent from the deployed program");
    }
}
