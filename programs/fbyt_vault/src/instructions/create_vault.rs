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

#[derive(Accounts)]
pub struct CreateVault<'info> {
    #[account(
        mut,
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump,
        has_one = admin
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,

    /// CHECK: protocol admin; receives the SOL creation fee. Tied to `admin_pool` by its `has_one = admin`.
    #[account(mut)]
    pub admin: UncheckedAccount<'info>,

    #[account(mut)]
    pub money_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [MONEY_MANAGER_POOL_SEED, admin_pool.key().as_ref(), money_manager.key().as_ref()],
        bump = money_manager_pool.bump,
        has_one = admin_pool,
        has_one = money_manager
    )]
    pub money_manager_pool: Box<Account<'info, MoneyManagerPool>>,

    #[account(
        init,
        payer = money_manager,
        space = VaultPool::DISCRIMINATOR.len() + VaultPool::INIT_SPACE,
        seeds = [VAULT_POOL_SEED, admin_pool.key().as_ref(), money_manager.key().as_ref(), money_manager_pool.vaults_amount.to_le_bytes().as_ref()],
        bump
    )]
    pub vault_pool: Box<Account<'info, VaultPool>>,

    #[account(
        init,
        payer = money_manager,
        space = AssetRegistry::DISCRIMINATOR.len() + AssetRegistry::INIT_SPACE,
        seeds = [ASSET_REGISTRY_SEED, vault_pool.key().as_ref()],
        bump
    )]
    pub asset_registry: Box<Account<'info, AssetRegistry>>,

    #[account(
        has_one = admin_pool,
        has_one = token_mint
    )]
    pub oracle_pool: Box<Account<'info, OraclePool>>,

    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    #[account(mut)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    pub system_program: Program<'info, System>,
}

pub fn create_vault(
    ctx: Context<CreateVault>,
    min_contribute_amount: u64,
    raise_period: u64,
    min_raise_amount: u64,
    mm_withdraw_period: u64,
    withdraw_cooldown: u64,
    money_management_fee: u16,
    performance_fee: u16,
    is_open_ended: bool,
) -> Result<()> {
    use pyth_solana_receiver_sdk::price_update::get_feed_id_from_hex;
    // ---- validations first (no writes yet) ----
    require!(
        money_management_fee <= ctx.accounts.admin_pool.money_management_yearly_fee_max,
        FbytError::InvalidFee
    );
    require!(
        performance_fee <= ctx.accounts.admin_pool.performance_fee_max,
        FbytError::InvalidFee
    );
    require!(
        withdraw_cooldown <= ctx.accounts.admin_pool.withdraw_cooldown_max,
        FbytError::InvalidWithdrawCooldown
    );
    // The money-manager fee-withdrawal cadence must be at least one week.
    require!(
        mm_withdraw_period >= MIN_MM_WITHDRAW_PERIOD,
        FbytError::InvalidWithdrawPeriod
    );
    require!(
        raise_period <= ctx.accounts.admin_pool.fundrising_period_max,
        FbytError::InvalidRaisePeriod
    );
    require!(
        min_raise_amount >= ctx.accounts.admin_pool.raise_amount_min_usd,
        FbytError::InvalidRaiseAmount
    );
    require!(
        min_contribute_amount >= ctx.accounts.admin_pool.contribution_amount_min_usd,
        FbytError::InvalidContributionAmount
    );
    require!(
        ctx.accounts.oracle_pool.is_approved,
        FbytError::OracleNotApproved
    );
    // record the base-token price at creation
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
    // creation fee: SOL money_manager -> admin
    let creation_fee = ctx.accounts.admin_pool.creation_fee;
    if creation_fee > 0 {
        anchor_lang::solana_program::program::invoke(
            &anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.money_manager.key(),
                &ctx.accounts.admin.key(),
                creation_fee,
            ),
            &[
                ctx.accounts.money_manager.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }
    let now = Clock::get()?.unix_timestamp as u64;
    let index = ctx.accounts.money_manager_pool.vaults_amount;
    let admin_pool = ctx.accounts.admin_pool.key();
    let money_manager = ctx.accounts.money_manager.key();
    let token_mint = ctx.accounts.token_mint.key();
    let asset_registry = ctx.accounts.asset_registry.key();
    ctx.accounts.vault_pool.set_inner(VaultPool {
        bump: ctx.bumps.vault_pool,
        index,
        admin_pool,
        money_manager,
        token_mint,
        asset_registry,
        vault_pool_status: VaultStatus::Active as u8,
        investor_count: 0,
        raised_amount_usd: 0,
        total_shares: 0,
        // Known divergence from the deployed program: the deployed program converts these minimums to
        // USD via the base price at creation (and checks/stores the converted value), whereas this
        // reconstruction stores the raw token amounts. See RPC_FINDINGS.md ("token→USD conversion").
        min_contribute_amount_usd: min_contribute_amount,
        raise_period,
        min_raise_amount_usd: min_raise_amount,
        mm_withdraw_period,
        withdraw_cooldown,
        created_at: now,
        updated_at: now,
        // `last_trade_at` starts at `created_at`: a vault that has never traded reads
        // `last_trade_at == created_at`, which is the NoTradesYet sentinel (not 0). `last_mm_fee_withdraw_at`
        // starts at `created_at + raise_period`, so the first management fee is claimable one
        // `mm_withdraw_period` after the fundraise ends.
        last_trade_at: now,
        last_mm_fee_withdraw_at: now.saturating_add(raise_period),
        money_management_yearly_fee: money_management_fee,
        performance_fee,
        is_open_ended,
        padding1: [0u8; 7],
        trading_delegate: Pubkey::default(),
        padding: [0u64; 11],
    });
    ctx.accounts.asset_registry.set_inner(AssetRegistry {
        bump: ctx.bumps.asset_registry,
        vault_pool: ctx.accounts.vault_pool.key(),
        asset_mints: Vec::new(),
        padding: [0u64; 8],
    });
    ctx.accounts.money_manager_pool.vaults_amount =
        index.checked_add(1).ok_or(error!(FbytError::Overflow))?;
    ctx.accounts.admin_pool.vault_pool_count = ctx
        .accounts
        .admin_pool
        .vault_pool_count
        .checked_add(1)
        .ok_or(error!(FbytError::Overflow))?;
    emit!(VaultCreatedEvent {
        index,
        admin_pool,
        money_manager,
        token_mint,
        min_contribute_amount_usd: min_contribute_amount,
        raise_period,
        min_raise_amount_usd: min_raise_amount,
        mm_withdraw_period,
        withdraw_cooldown,
        created_at: now,
        money_management_yearly_fee: money_management_fee,
        performance_fee,
        price: price.price,
        price_exponent: price.exponent,
        is_open_ended,
    });
    Ok(())
}
