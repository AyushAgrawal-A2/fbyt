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
pub struct AdminUpdateOperator<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: the new operator address to record on the admin pool. Any address is valid.
    #[account(mut)]
    pub operator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,
}

pub fn admin_update_operator(ctx: Context<AdminUpdateOperator>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.admin_pool.admin,
        FbytError::InvalidAdmin
    );
    ctx.accounts.admin_pool.operator = ctx.accounts.operator.key();
    emit!(AdminPoolUpdateOperatorEvent {
        admin: ctx.accounts.admin_pool.admin,
        new_operator: ctx.accounts.admin_pool.operator,
    });
    Ok(())
}
