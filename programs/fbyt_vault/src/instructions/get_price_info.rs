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
pub struct GetPriceInfo<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,

    #[account(mut)]
    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    pub system_program: Program<'info, System>,
}

pub fn get_price_info(ctx: Context<GetPriceInfo>, feed_id: String) -> Result<()> {
    use pyth_solana_receiver_sdk::price_update::get_feed_id_from_hex;
    let feed = get_feed_id_from_hex(&feed_id).map_err(|_| error!(FbytError::InvalidPriceFeed))?;
    // A Pyth `GetPriceError` propagates unmapped (a stale feed surfaces as Anchor code 16000).
    let price = ctx.accounts.price_update.get_price_no_older_than(
        &Clock::get()?,
        ctx.accounts.admin_pool.oracle_max_age,
        &feed,
    )?;
    msg!(
        "price={} conf={} expo={}",
        price.price,
        price.conf,
        price.exponent
    );
    Ok(())
}
