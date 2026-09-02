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
pub struct CreateMoneyManagerPool<'info> {
    #[account(
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,

    #[account(mut)]
    pub money_manager: Signer<'info>,

    #[account(
        init,
        payer = money_manager,
        space = MoneyManagerPool::DISCRIMINATOR.len() + MoneyManagerPool::INIT_SPACE,
        seeds = [MONEY_MANAGER_POOL_SEED, admin_pool.key().as_ref(), money_manager.key().as_ref()],
        bump
    )]
    pub money_manager_pool: Box<Account<'info, MoneyManagerPool>>,

    pub system_program: Program<'info, System>,
}

pub fn create_money_manager_pool(ctx: Context<CreateMoneyManagerPool>) -> Result<()> {
    let money_manager = ctx.accounts.money_manager.key();
    let admin_pool = ctx.accounts.admin_pool.key();
    ctx.accounts.money_manager_pool.set_inner(MoneyManagerPool {
        bump: ctx.bumps.money_manager_pool,
        money_manager,
        admin_pool,
        vaults_amount: 0,
        padding: [0u64; 8],
    });
    emit!(MoneyManagerPoolCreatedEvent {
        money_manager,
        admin_pool
    });
    Ok(())
}
