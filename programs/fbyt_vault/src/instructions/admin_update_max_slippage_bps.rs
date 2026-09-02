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
pub struct AdminUpdateMaxSlippageBps<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,
}

pub fn admin_update_max_slippage_bps(
    ctx: Context<AdminUpdateMaxSlippageBps>,
    new_max_slippage_bps: u16,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.admin_pool.admin,
        FbytError::InvalidAdmin
    );
    require!(new_max_slippage_bps <= 10_000, FbytError::InvalidBps);
    ctx.accounts.admin_pool.max_slippage_bps = new_max_slippage_bps;
    emit!(AdminPoolUpdateMaxSlippageBpsEvent {
        admin: ctx.accounts.admin_pool.admin,
        new_max_slippage_bps
    });
    Ok(())
}
