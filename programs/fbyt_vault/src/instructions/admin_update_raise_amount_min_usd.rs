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
pub struct AdminUpdateRaiseAmountMinUsd<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,
}

pub fn admin_update_raise_amount_min_usd(
    ctx: Context<AdminUpdateRaiseAmountMinUsd>,
    new_raise_amount_min_usd: u64,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.admin_pool.admin,
        FbytError::InvalidAdmin
    );
    ctx.accounts.admin_pool.raise_amount_min_usd = new_raise_amount_min_usd;
    emit!(AdminPoolUpdateRaiseAmountMinUsdEvent {
        admin: ctx.accounts.admin_pool.admin,
        new_raise_amount_min_usd
    });
    Ok(())
}
