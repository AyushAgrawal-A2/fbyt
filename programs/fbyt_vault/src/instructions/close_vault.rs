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
pub struct CloseVault<'info> {
    #[account(
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,

    #[account(
        mut,
        has_one = admin_pool,
        has_one = money_manager,
        has_one = token_mint
    )]
    pub vault_pool: Box<Account<'info, VaultPool>>,

    #[account(mut)]
    pub money_manager: Signer<'info>,

    #[account(mut)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,
}

pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
    require!(
        ctx.accounts.vault_pool.vault_pool_status != (VaultStatus::Closed as u8),
        FbytError::VaultClosed
    );
    // A vault can only be closed after its fundraise period has ended.
    let now = Clock::get()?.unix_timestamp as u64;
    require!(
        now >= ctx.accounts.vault_pool.created_at.saturating_add(ctx.accounts.vault_pool.raise_period),
        FbytError::FundRaisePeriodNotOver
    );
    let admin_pool = ctx.accounts.admin_pool.key();
    let money_manager = ctx.accounts.money_manager.key();
    let vault_pool = ctx.accounts.vault_pool.key();
    let token_mint = ctx.accounts.token_mint.key();
    // soft close: mark status Closed (account retained). NOTE: original likely also requires total_shares == 0.
    ctx.accounts.vault_pool.vault_pool_status = VaultStatus::Closed as u8;
    ctx.accounts.vault_pool.updated_at = Clock::get()?.unix_timestamp as u64;
    emit!(CloseVaultEvent {
        admin_pool,
        money_manager,
        vault_pool,
        token_mint,
        status: VaultStatus::Closed as u8
    });
    Ok(())
}
