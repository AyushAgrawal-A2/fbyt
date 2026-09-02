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
pub struct AdminModifyFee<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,
}

pub fn admin_modify_fee(
    ctx: Context<AdminModifyFee>,
    creation_fee: u64,
    protocol_performance_fee: u16,
    protocol_money_management_fee: u16,
    trading_fee: u64,
    money_management_yearly_fee_max: u16,
    performance_fee_max: u16,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.admin_pool.admin,
        FbytError::InvalidAdmin
    );
    require!(
        protocol_performance_fee <= 10_000
            && protocol_money_management_fee <= 10_000
            && performance_fee_max <= 10_000
            && money_management_yearly_fee_max <= 10_000,
        FbytError::InvalidFee
    );
    ctx.accounts.admin_pool.creation_fee = creation_fee;
    ctx.accounts.admin_pool.protocol_performance_fee = protocol_performance_fee;
    ctx.accounts.admin_pool.protocol_money_management_fee = protocol_money_management_fee;
    ctx.accounts.admin_pool.trading_fee = trading_fee;
    ctx.accounts.admin_pool.money_management_yearly_fee_max = money_management_yearly_fee_max;
    ctx.accounts.admin_pool.performance_fee_max = performance_fee_max;
    emit!(AdminPoolModifyFeeEvent {
        admin: ctx.accounts.admin_pool.admin,
        creation_fee,
        protocol_performance_fee,
        protocol_money_management_fee,
        trading_fee,
        money_management_yearly_fee_max,
        performance_fee_max,
    });
    Ok(())
}
