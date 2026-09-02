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
pub struct CloseOraclePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump,
        has_one = admin
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,

    #[account(mut)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [ORACLE_POOL_SEED, admin_pool.key().as_ref(), token_mint.key().as_ref()],
        bump = oracle_pool.bump,
        has_one = admin_pool,
        has_one = token_mint,
        close = admin
    )]
    pub oracle_pool: Box<Account<'info, OraclePool>>,
}

pub fn close_oracle_pool(ctx: Context<CloseOraclePool>) -> Result<()> {
    // rent returned to `admin` via the `close = admin` account constraint
    emit!(CloseOraclePoolEvent {
        admin_pool: ctx.accounts.admin_pool.key(),
        token_mint: ctx.accounts.token_mint.key(),
        oracle_pool: ctx.accounts.oracle_pool.key(),
    });
    Ok(())
}
