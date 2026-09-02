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
pub struct RevokeTradingDelegate<'info> {
    #[account(
        mut,
        has_one = money_manager
    )]
    pub vault_pool: Box<Account<'info, VaultPool>>,

    pub money_manager: Signer<'info>,
}

pub fn revoke_trading_delegate(ctx: Context<RevokeTradingDelegate>) -> Result<()> {
    require!(
        ctx.accounts.vault_pool.trading_delegate != Pubkey::default(),
        FbytError::NoTradingDelegate
    );
    let vault_pool = ctx.accounts.vault_pool.key();
    let money_manager = ctx.accounts.money_manager.key();
    let previous_delegate = ctx.accounts.vault_pool.trading_delegate;
    let now = Clock::get()?.unix_timestamp as u64;
    ctx.accounts.vault_pool.trading_delegate = Pubkey::default();
    ctx.accounts.vault_pool.updated_at = now;
    emit!(TradingDelegateRevokedEvent {
        vault_pool,
        money_manager,
        previous_delegate,
        timestamp: now
    });
    Ok(())
}
