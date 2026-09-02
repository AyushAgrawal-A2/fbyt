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
pub struct CreateInvestorPool<'info> {
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

    #[account(mut)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = investor,
        space = InvestorPool::DISCRIMINATOR.len() + InvestorPool::INIT_SPACE,
        seeds = [INVESTOR_POOL_SEED, investor.key().as_ref(), admin_pool.key().as_ref(), vault_pool.key().as_ref(), token_mint.key().as_ref()],
        bump
    )]
    pub investor_pool: Box<Account<'info, InvestorPool>>,

    pub system_program: Program<'info, System>,
}

pub fn create_investor_pool(ctx: Context<CreateInvestorPool>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp as u64;
    let investor = ctx.accounts.investor.key();
    let admin_pool = ctx.accounts.admin_pool.key();
    let vault_pool = ctx.accounts.vault_pool.key();
    let token_mint = ctx.accounts.token_mint.key();
    ctx.accounts.investor_pool.set_inner(InvestorPool {
        bump: ctx.bumps.investor_pool,
        investor,
        admin_pool,
        vault_pool,
        token_mint,
        shares: 0,
        hight_watermark: 0,
        created_at: now,
        updated_at: now,
        padding: [0u64; 8],
    });
    // Count the new investor on the vault.
    ctx.accounts.vault_pool.investor_count = ctx
        .accounts
        .vault_pool
        .investor_count
        .checked_add(1)
        .ok_or(error!(FbytError::Overflow))?;
    emit!(InvestorPoolCreatedEvent {
        investor,
        admin_pool,
        vault_pool,
        token_mint,
        created_at: now
    });
    Ok(())
}
