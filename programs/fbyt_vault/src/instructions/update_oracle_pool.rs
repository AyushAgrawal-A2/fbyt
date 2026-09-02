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
pub struct UpdateOraclePool<'info> {
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
        has_one = token_mint
    )]
    pub oracle_pool: Box<Account<'info, OraclePool>>,
}

pub fn update_oracle_pool(ctx: Context<UpdateOraclePool>, feed_id: String) -> Result<()> {
    require!(feed_id.as_bytes().len() <= 66, FbytError::InvalidPriceFeed);
    let mut feed = [0u8; 66];
    feed[..feed_id.as_bytes().len()].copy_from_slice(feed_id.as_bytes());
    ctx.accounts.oracle_pool.feed_id = feed;
    emit!(UpdateOraclePoolEvent {
        admin_pool: ctx.accounts.oracle_pool.admin_pool,
        token_mint: ctx.accounts.oracle_pool.token_mint,
        feed_id,
    });
    Ok(())
}
