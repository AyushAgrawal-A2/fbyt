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
pub struct CreateOraclePool<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,

    #[account(
        mut,
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,

    #[account(mut)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = requester,
        space = OraclePool::DISCRIMINATOR.len() + OraclePool::INIT_SPACE,
        seeds = [ORACLE_POOL_SEED, admin_pool.key().as_ref(), token_mint.key().as_ref()],
        bump
    )]
    pub oracle_pool: Box<Account<'info, OraclePool>>,

    pub system_program: Program<'info, System>,
}

pub fn create_oracle_pool(ctx: Context<CreateOraclePool>, feed_id: String) -> Result<()> {
    require!(feed_id.as_bytes().len() <= 66, FbytError::InvalidPriceFeed);
    let mut feed = [0u8; 66];
    feed[..feed_id.as_bytes().len()].copy_from_slice(feed_id.as_bytes());
    let admin_pool = ctx.accounts.admin_pool.key();
    let token_mint = ctx.accounts.token_mint.key();
    ctx.accounts.oracle_pool.set_inner(OraclePool {
        bump: ctx.bumps.oracle_pool,
        admin_pool,
        token_mint,
        feed_id: feed,
        is_approved: false,
        padding: [0u64; 8],
        reserved: [0u8; 4],
    });
    emit!(CreateOraclePoolEvent {
        admin_pool,
        token_mint,
        feed_id
    });
    Ok(())
}
