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
pub struct DepositTokenFund<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,

    #[account(
        mut,
        has_one = admin_pool,
        has_one = token_mint
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
        seeds = [INVESTOR_POOL_SEED, investor.key().as_ref(), admin_pool.key().as_ref(), vault_pool.key().as_ref(), token_mint.key().as_ref()],
        bump = investor_pool.bump,
        has_one = investor,
        has_one = admin_pool,
        has_one = vault_pool,
        has_one = token_mint
    )]
    pub investor_pool: Box<Account<'info, InvestorPool>>,

    #[account(
        mut,
        has_one = admin_pool,
        has_one = token_mint
    )]
    pub oracle_pool: Box<Account<'info, OraclePool>>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = investor,
        associated_token::token_program = token_program
    )]
    pub from_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = vault_pool,
        associated_token::token_program = token_program
    )]
    pub to_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub fn deposit_token_fund<'info>(
    ctx: Context<'info, DepositTokenFund<'info>>,
    amount: u64,
) -> Result<()> {
    use anchor_spl::token_interface::{TransferChecked, transfer_checked};
    use pyth_solana_receiver_sdk::price_update::get_feed_id_from_hex;

    // ---- validations first ----
    // Both the raw deposit `amount` and (below, after pricing) its USD value must clear
    // `min_contribute_amount_usd`; either shortfall is `InvalidDepositAmount`.
    require!(
        amount >= ctx.accounts.vault_pool.min_contribute_amount_usd,
        FbytError::InvalidDepositAmount
    );
    require!(
        ctx.accounts.vault_pool.vault_pool_status == VaultStatus::Active as u8,
        FbytError::VaultNotActive
    );
    require!(
        ctx.accounts.oracle_pool.is_approved,
        FbytError::OracleNotApproved
    );
    // Deposits are only accepted during the raise window (`now <= created_at + raise_period`). The
    // rejection code differs by vault type: `InvalidAccountData` for open-ended vaults,
    // `OutsideRaisePeriod` for fixed-term ones.
    {
        let now = Clock::get()?.unix_timestamp as u64;
        let raise_end = ctx.accounts.vault_pool.created_at.saturating_add(ctx.accounts.vault_pool.raise_period);
        if ctx.accounts.vault_pool.is_open_ended {
            require!(now <= raise_end, FbytError::InvalidAccountData);
        } else {
            require!(now <= raise_end, FbytError::OutsideRaisePeriod);
        }
    }

    // ---- price the deposit in micro-USD (6 dp) ----
    let feed_hex = core::str::from_utf8(&ctx.accounts.oracle_pool.feed_id)
        .unwrap_or("")
        .trim_end_matches('\0');
    let feed = get_feed_id_from_hex(feed_hex).map_err(|_| error!(FbytError::InvalidPriceFeed))?;
    // A Pyth `GetPriceError` propagates unmapped (a stale feed surfaces as Anchor code 16000).
    let price = ctx.accounts.price_update.get_price_no_older_than(
        &Clock::get()?,
        ctx.accounts.admin_pool.oracle_max_age,
        &feed,
    )?;
    require!(price.price > 0, FbytError::InvalidPrice);
    let net_exponent = 6i32 + price.exponent - ctx.accounts.token_mint.decimals as i32;
    let scaled = (amount as u128)
        .checked_mul(price.price as u128)
        .ok_or(error!(FbytError::CalculateOverflow))?;
    let amount_usd: u64 = if net_exponent >= 0 {
        scaled
            .checked_mul(10u128.pow(net_exponent as u32))
            .ok_or(error!(FbytError::CalculateOverflow))?
    } else {
        scaled / 10u128.pow((-net_exponent) as u32)
    }
    .try_into()
    .map_err(|_| error!(FbytError::CalculateOverflow))?;
    require!(
        amount_usd >= ctx.accounts.vault_pool.min_contribute_amount_usd,
        FbytError::InvalidDepositAmount
    );

    // Shares are priced against the vault's tracked cumulative cost basis `raised_amount_usd`, NOT its
    // live token holdings. This has two important properties:
    //   1. No asset legs are read from `remaining_accounts`; a deposit is accepted with an empty
    //      `remaining_accounts` even when the asset registry is non-empty.
    //   2. The denominator is the tracked raised total rather than summed balances, so a raw token
    //      donation into a vault ATA cannot inflate the share price — the classic first-depositor
    //      inflation attack does not apply. Do NOT rewrite this to a live-holdings NAV: that would both
    //      change the share economics and reintroduce the donation vulnerability.
    // The first deposit mints shares equal to the raw token `amount` (share unit = base-token units);
    // subsequent deposits are pro-rated as `amount_usd * total_shares / raised_amount_usd`.
    let shares: u64 = if ctx.accounts.vault_pool.total_shares == 0
        || ctx.accounts.vault_pool.raised_amount_usd == 0
    {
        amount
    } else {
        ((amount_usd as u128) * (ctx.accounts.vault_pool.total_shares as u128)
            / (ctx.accounts.vault_pool.raised_amount_usd as u128))
            .try_into()
            .map_err(|_| error!(FbytError::CalculateOverflow))?
    };
    require!(shares > 0, FbytError::InvalidDepositAmount);

    // ---- effects: move tokens, then update state ----
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.from_account.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.to_account.to_account_info(),
                authority: ctx.accounts.investor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.token_mint.decimals,
    )?;

    let now = Clock::get()?.unix_timestamp as u64;
    ctx.accounts.vault_pool.raised_amount_usd = ctx
        .accounts
        .vault_pool
        .raised_amount_usd
        .checked_add(amount_usd)
        .ok_or(error!(FbytError::Overflow))?;
    ctx.accounts.vault_pool.total_shares = ctx
        .accounts
        .vault_pool
        .total_shares
        .checked_add(shares)
        .ok_or(error!(FbytError::Overflow))?;
    ctx.accounts.vault_pool.updated_at = now;
    ctx.accounts.investor_pool.shares = ctx
        .accounts
        .investor_pool
        .shares
        .checked_add(shares)
        .ok_or(error!(FbytError::Overflow))?;
    ctx.accounts.investor_pool.hight_watermark = ctx
        .accounts
        .investor_pool
        .hight_watermark
        .checked_add(amount_usd)
        .ok_or(error!(FbytError::Overflow))?;
    ctx.accounts.investor_pool.updated_at = now;

    emit!(DepositTokenFundEvent {
        investor: ctx.accounts.investor.key(),
        admin_pool: ctx.accounts.admin_pool.key(),
        vault_pool: ctx.accounts.vault_pool.key(),
        investor_pool: ctx.accounts.investor_pool.key(),
        token_mint: ctx.accounts.token_mint.key(),
        amount,
        amount_usd,
        shares,
    });
    Ok(())
}
