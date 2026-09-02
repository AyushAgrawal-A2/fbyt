#![allow(unused_imports)]
use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::*;
use crate::errors::*;
use crate::events::*;
use crate::state::*;
use crate::util::*;

#[derive(Accounts)]
pub struct WithdrawTokenFund<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    /// CHECK: the vault's money manager. Tied to `vault_pool` by its `has_one = money_manager`.
    #[account(mut)]
    pub money_manager: UncheckedAccount<'info>,

    #[account(
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,

    #[account(
        mut,
        has_one = money_manager,
        has_one = admin_pool
    )]
    pub vault_pool: Box<Account<'info, VaultPool>>,

    #[account(
        mut,
        seeds = [ASSET_REGISTRY_SEED, vault_pool.key().as_ref()],
        bump = asset_registry.bump,
        has_one = vault_pool
    )]
    pub asset_registry: Box<Account<'info, AssetRegistry>>,

    #[account(
        mut,
        seeds = [INVESTOR_POOL_SEED, investor.key().as_ref(), admin_pool.key().as_ref(), vault_pool.key().as_ref(), vault_pool.token_mint.as_ref()],
        bump = investor_pool.bump,
        has_one = investor,
        has_one = admin_pool,
        has_one = vault_pool
    )]
    pub investor_pool: Box<Account<'info, InvestorPool>>,

    pub token_program: Program<'info, Token>,

    pub token_program2022: Program<'info, Token2022>,

    pub system_program: Program<'info, System>,
}

pub fn withdraw_token_fund<'info>(
    ctx: Context<'info, WithdrawTokenFund<'info>>,
    shares: u64,
) -> Result<()> {
    use pyth_solana_receiver_sdk::price_update::get_feed_id_from_hex;

    // ---- validations first ----
    require!(shares > 0, FbytError::ZeroWithdrawShares);
    // Requesting more shares than the investor owns rejects with the generic `InsufficientFunds`.
    require!(
        shares <= ctx.accounts.investor_pool.shares,
        FbytError::InsufficientFunds
    );
    let total_shares = ctx.accounts.vault_pool.total_shares;
    require!(total_shares > 0, FbytError::InsufficientFunds);
    let now = Clock::get()?.unix_timestamp as u64;
    // The withdraw cooldown runs from the fundraise end, not from the investor's last action:
    // withdrawals unlock at `created_at + raise_period + withdraw_cooldown`, independent of when the
    // investor deposited.
    require!(
        now >= ctx
            .accounts
            .vault_pool
            .created_at
            .saturating_add(ctx.accounts.vault_pool.raise_period)
            .saturating_add(ctx.accounts.vault_pool.withdraw_cooldown),
        FbytError::WithdrawCooldownNotEnded
    );
    // per-asset groups of 7: [oracle_pool, price_update, mint, vault_ata, investor_ata, manager_fee_ata, protocol_fee_ata]
    require!(
        !ctx.remaining_accounts.is_empty() && ctx.remaining_accounts.len() % 7 == 0,
        FbytError::InvalidAccountLength
    );

    let vault_key = ctx.accounts.vault_pool.key();
    let admin_pool_key = ctx.accounts.vault_pool.admin_pool;
    let money_manager_key = ctx.accounts.vault_pool.money_manager;
    let index_le = ctx.accounts.vault_pool.index.to_le_bytes();
    let bump = ctx.accounts.vault_pool.bump;
    let performance_fee_bps = ctx.accounts.vault_pool.performance_fee as u128;
    let protocol_performance_bps = ctx.accounts.admin_pool.protocol_performance_fee as u128;
    let max_age = ctx.accounts.admin_pool.oracle_max_age;
    let investor_shares = ctx.accounts.investor_pool.shares as u128;
    let high_watermark = ctx.accounts.investor_pool.hight_watermark as u128;
    let seeds: &[&[u8]] = &[
        VAULT_POOL_SEED,
        admin_pool_key.as_ref(),
        money_manager_key.as_ref(),
        index_le.as_ref(),
        &[bump],
    ];
    let vault_info = ctx.accounts.vault_pool.to_account_info();

    // ---- pass 1: value the withdrawn slice (Σ pro-rata × price) + capture base token_price for the event ----
    let mut value_usd: u128 = 0;
    let mut token_price: i64 = 0;
    let mut token_exponent: i32 = 0;
    for group in ctx.remaining_accounts.chunks(7) {
        let (oracle_info, price_info, mint_info, vault_ata) =
            (&group[0], &group[1], &group[2], &group[3]);
        let mint = mint_info.key();
        {
            let token_account_data = vault_ata.try_borrow_data()?;
            require!(
                token_account_data.len() >= 72,
                FbytError::InvalidAccountLength
            );
            require!(
                token_account_data[0..32] == mint.to_bytes(),
                FbytError::InvalidTokenMint
            );
            require!(
                token_account_data[32..64] == vault_key.to_bytes(),
                FbytError::InvalidTokenOwner
            );
        }
        let balance = read_token_amount(vault_ata)? as u128;
        let pro_rata_amount = balance * (shares as u128) / (total_shares as u128);
        let oracle = Account::<OraclePool>::try_from(oracle_info)?;
        require!(oracle.token_mint == mint, FbytError::InvalidOraclePool);
        let price = Account::<PriceUpdateV2>::try_from(price_info)?;
        let decimals = {
            let mint_data = mint_info.try_borrow_data()?;
            require!(mint_data.len() > 44, FbytError::InvalidTokenMint);
            mint_data[44]
        };
        value_usd = value_usd
            .checked_add(oracle_value_usd(
                &price,
                &oracle,
                max_age,
                decimals,
                pro_rata_amount as u64,
            )?)
            .ok_or(error!(FbytError::CalculateOverflow))?;
        if token_price == 0 {
            let feed_hex = core::str::from_utf8(&oracle.feed_id)
                .unwrap_or("")
                .trim_end_matches('\0');
            let feed =
                get_feed_id_from_hex(feed_hex).map_err(|_| error!(FbytError::InvalidPriceFeed))?;
            // A Pyth `GetPriceError` propagates unmapped (a stale feed surfaces as Anchor code 16000).
            let latest_price = price.get_price_no_older_than(&Clock::get()?, max_age, &feed)?;
            token_price = latest_price.price;
            token_exponent = latest_price.exponent;
        }
    }

    // High-watermark performance fee: `hight_watermark` is the investor's contributed cost basis in
    // micro-USD, and the fee is charged only on value above the pro-rata slice of it. The fee is 0 when
    // the withdrawn slice is worth no more than its cost.
    //
    // Known divergence from the deployed program: the deployed program does not mark held base tokens
    // to market (a pure base-price rise yields no fee) and its realized fee on trading gains is smaller
    // than this straightforward oracle-NAV gain. The exact model is not fully recovered; see
    // RPC_FINDINGS.md ("performance-fee model").
    let high_watermark_slice = if investor_shares > 0 {
        high_watermark * (shares as u128) / investor_shares
    } else {
        0
    };
    let gain = value_usd.saturating_sub(high_watermark_slice);
    let performance_fee_usd = gain * performance_fee_bps / 10_000u128;

    // ---- pass 2: pay the investor pro-rata in-kind; perf fee split manager/protocol per asset ----
    let investor_key = ctx.accounts.investor.key();
    let protocol_admin = ctx.accounts.admin_pool.admin;
    for group in ctx.remaining_accounts.chunks(7) {
        let (mint_info, vault_ata, investor_ata, manager_ata, protocol_ata) =
            (&group[2], &group[3], &group[4], &group[5], &group[6]);
        let _ = mint_info;
        // The payout and fee-recipient ATAs must belong to the investor, money_manager, and protocol
        // admin respectively; otherwise a profiting investor could redirect the performance fee (and
        // their own payout) to accounts they control.
        {
            let data = investor_ata.try_borrow_data()?;
            require!(data.len() >= 64 && data[32..64] == investor_key.to_bytes(), FbytError::InvalidToAccount);
        }
        {
            let data = manager_ata.try_borrow_data()?;
            require!(data.len() >= 64 && data[32..64] == money_manager_key.to_bytes(), FbytError::InvalidMoneyManagerAccount);
        }
        {
            let data = protocol_ata.try_borrow_data()?;
            require!(data.len() >= 64 && data[32..64] == protocol_admin.to_bytes(), FbytError::InvalidAdminAccount);
        }
        let balance = read_token_amount(vault_ata)? as u128;
        let pro_rata_amount = balance * (shares as u128) / (total_shares as u128);
        if pro_rata_amount == 0 {
            continue;
        }
        let asset_fee = if value_usd > 0 {
            pro_rata_amount * performance_fee_usd / value_usd
        } else {
            0
        };
        let protocol_cut = asset_fee * protocol_performance_bps / 10_000u128;
        let manager_cut = asset_fee.saturating_sub(protocol_cut);
        let investor_amount = pro_rata_amount.saturating_sub(asset_fee);
        let token_program_info = if vault_ata.owner == &ctx.accounts.token_program.key() {
            ctx.accounts.token_program.to_account_info()
        } else {
            ctx.accounts.token_program2022.to_account_info()
        };
        if investor_amount > 0 {
            spl_transfer_signed(
                &token_program_info,
                vault_ata,
                investor_ata,
                &vault_info,
                investor_amount as u64,
                seeds,
            )?;
        }
        if manager_cut > 0 {
            spl_transfer_signed(
                &token_program_info,
                vault_ata,
                manager_ata,
                &vault_info,
                manager_cut as u64,
                seeds,
            )?;
        }
        if protocol_cut > 0 {
            spl_transfer_signed(
                &token_program_info,
                vault_ata,
                protocol_ata,
                &vault_info,
                protocol_cut as u64,
                seeds,
            )?;
        }
    }

    // ---- burn shares & update accounting ----
    let investor_prev = ctx.accounts.investor_pool.shares;
    let raised_reduce: u64 = ((ctx.accounts.vault_pool.raised_amount_usd as u128)
        * (shares as u128)
        / (total_shares as u128))
        .try_into()
        .map_err(|_| error!(FbytError::CalculateOverflow))?;
    ctx.accounts.investor_pool.shares = ctx.accounts.investor_pool.shares.saturating_sub(shares);
    ctx.accounts.investor_pool.hight_watermark =
        (high_watermark.saturating_sub(high_watermark_slice)) as u64;
    ctx.accounts.investor_pool.updated_at = now;
    let investor_updated = ctx.accounts.investor_pool.shares;
    ctx.accounts.vault_pool.total_shares =
        ctx.accounts.vault_pool.total_shares.saturating_sub(shares);
    ctx.accounts.vault_pool.raised_amount_usd = ctx
        .accounts
        .vault_pool
        .raised_amount_usd
        .saturating_sub(raised_reduce);
    if investor_updated == 0 {
        ctx.accounts.vault_pool.investor_count =
            ctx.accounts.vault_pool.investor_count.saturating_sub(1);
    }
    ctx.accounts.vault_pool.updated_at = now;

    let admin_fee: u64 = (performance_fee_usd * protocol_performance_bps / 10_000u128)
        .try_into()
        .map_err(|_| error!(FbytError::CalculateOverflow))?;
    let performance_fee: u64 = performance_fee_usd
        .try_into()
        .map_err(|_| error!(FbytError::CalculateOverflow))?;
    let money_manager_fee = performance_fee.saturating_sub(admin_fee);
    emit!(WithdrawTokenFundEvent {
        investor: ctx.accounts.investor.key(),
        investor_pool: ctx.accounts.investor_pool.key(),
        vault_pool: vault_key,
        token_mint: ctx.accounts.vault_pool.token_mint,
        token_price,
        token_exponent,
        amount: value_usd.try_into().unwrap_or(u64::MAX),
        money_manager_fee,
        performance_fee,
        admin_fee,
    });
    emit!(WithdrawTokenFundResultEvent {
        investor: ctx.accounts.investor.key(),
        money_manager: money_manager_key,
        admin_pool: admin_pool_key,
        vault_pool: vault_key,
        investor_pool: ctx.accounts.investor_pool.key(),
        vault_prev_value: total_shares,
        vault_updated_value: ctx.accounts.vault_pool.total_shares,
        investor_prev_value: investor_prev,
        investor_updated_value: investor_updated,
    });
    Ok(())
}
