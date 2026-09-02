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
pub struct CreateAdminPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: the initial operator address to record on the admin pool. Any address is valid.
    #[account(mut)]
    pub operator: UncheckedAccount<'info>,

    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::FbytVault>,

    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()))]
    pub program_data: Account<'info, ProgramData>,

    #[account(
        init,
        payer = admin,
        space = AdminPool::DISCRIMINATOR.len() + AdminPool::INIT_SPACE,
        seeds = [ADMIN_POOL_SEED],
        bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,

    pub system_program: Program<'info, System>,
}

pub fn create_admin_pool(
    ctx: Context<CreateAdminPool>,
    creation_fee: u64,
    protocol_performance_fee: u16,
    protocol_money_management_fee: u16,
    trading_fee: u64,
    money_management_yearly_fee_max: u16,
    performance_fee_max: u16,
    withdraw_cooldown_max: u64,
    fundrising_period_max: u64,
    raise_amount_min_usd: u64,
    contribution_amount_min_usd: u64,
    oracle_max_age: u64,
    idle_period: u64,
    dust_threshold_usd: u64,
    max_asset_count: u16,
    max_slippage_bps: u16,
) -> Result<()> {
    require!(
        protocol_performance_fee <= 10_000
            && protocol_money_management_fee <= 10_000
            && performance_fee_max <= 10_000
            && money_management_yearly_fee_max <= 10_000
            && max_slippage_bps <= 10_000,
        FbytError::InvalidFee
    );
    let admin = ctx.accounts.admin.key();
    let operator = ctx.accounts.operator.key();
    ctx.accounts.admin_pool.set_inner(AdminPool {
        bump: ctx.bumps.admin_pool,
        admin,
        pending_admin: Pubkey::default(),
        operator,
        vault_pool_count: 0,
        creation_fee,
        protocol_performance_fee,
        protocol_money_management_fee,
        money_management_yearly_fee_max,
        performance_fee_max,
        trading_fee,
        withdraw_cooldown_max,
        fundrising_period_max,
        raise_amount_min_usd,
        contribution_amount_min_usd,
        oracle_max_age,
        idle_period,
        dust_threshold_usd,
        max_asset_count,
        max_slippage_bps,
        padding: [0u8; 62],
    });
    emit!(AdminPoolCreatedEvent {
        admin,
        operator,
        vault_pool_count: 0,
        creation_fee,
        protocol_performance_fee,
        protocol_money_management_fee,
        trading_fee,
        money_management_yearly_fee_max,
        performance_fee_max,
        withdraw_cooldown_max,
        fundrising_period_max,
        raise_amount_min_usd,
        contribution_amount_min_usd,
        oracle_max_age,
        idle_period,
        dust_threshold_usd,
        max_asset_count,
        max_slippage_bps,
    });
    Ok(())
}
