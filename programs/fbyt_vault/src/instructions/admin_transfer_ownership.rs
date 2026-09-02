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
pub struct AdminTransferOwnership<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: the nominated next admin, recorded as `admin_pool.pending_admin`. Any address may be
    /// nominated; it only takes effect once it signs `admin_accept_ownership`.
    #[account(mut)]
    pub pending_admin: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,
}

pub fn admin_transfer_ownership(ctx: Context<AdminTransferOwnership>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.admin_pool.admin,
        FbytError::InvalidAdmin
    );
    ctx.accounts.admin_pool.pending_admin = ctx.accounts.pending_admin.key();
    emit!(AdminPoolTransferOwnershipEvent {
        admin: ctx.accounts.admin_pool.admin,
        pending_admin: ctx.accounts.admin_pool.pending_admin,
    });
    Ok(())
}
