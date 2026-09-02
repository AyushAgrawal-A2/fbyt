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
pub struct AdminAcceptOwnership<'info> {
    #[account(mut)]
    pub pending_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,
}

pub fn admin_accept_ownership(ctx: Context<AdminAcceptOwnership>) -> Result<()> {
    // The pending-admin mismatch uses the dedicated `InvalidPendingAdmin`, not the generic
    // `InvalidAdmin` that the admin-authed handlers use.
    require_keys_eq!(
        ctx.accounts.pending_admin.key(),
        ctx.accounts.admin_pool.pending_admin,
        FbytError::InvalidPendingAdmin
    );
    let old_admin = ctx.accounts.admin_pool.admin;
    ctx.accounts.admin_pool.admin = ctx.accounts.pending_admin.key();
    ctx.accounts.admin_pool.pending_admin = Pubkey::default();
    emit!(AdminPoolAcceptOwnershipEvent {
        old_admin,
        new_admin: ctx.accounts.admin_pool.admin
    });
    Ok(())
}
