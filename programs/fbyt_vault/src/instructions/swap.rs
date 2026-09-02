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
use crate::util::*;

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        mut,
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump,
        has_one = admin
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,

    /// CHECK: protocol admin; receives the SOL trading fee. Tied to `admin_pool` by its `has_one = admin`.
    #[account(mut)]
    pub admin: UncheckedAccount<'info>,

    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(mut)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        has_one = admin_pool,
        has_one = token_mint
    )]
    pub vault_pool: Box<Account<'info, VaultPool>>,

    #[account(
        mut,
        seeds = [ASSET_REGISTRY_SEED, vault_pool.key().as_ref()],
        bump = asset_registry.bump,
        has_one = vault_pool
    )]
    pub asset_registry: Box<Account<'info, AssetRegistry>>,

    pub input_mint: Box<InterfaceAccount<'info, Mint>>,

    pub input_mint_program: Interface<'info, TokenInterface>,

    pub output_mint: Box<InterfaceAccount<'info, Mint>>,

    pub output_mint_program: Interface<'info, TokenInterface>,

    #[account(
        mut,
        associated_token::mint = input_mint,
        associated_token::authority = vault_pool,
        associated_token::token_program = input_mint_program
    )]
    pub vault_input_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = output_mint,
        associated_token::authority = vault_pool,
        associated_token::token_program = output_mint_program
    )]
    pub vault_output_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        has_one = admin_pool
    )]
    pub oracle_pool_from: Box<Account<'info, OraclePool>>,

    #[account(
        mut,
        has_one = admin_pool
    )]
    pub oracle_pool_to: Box<Account<'info, OraclePool>>,

    pub input_price_update: Box<Account<'info, PriceUpdateV2>>,

    pub output_price_update: Box<Account<'info, PriceUpdateV2>>,

    /// CHECK: Jupiter aggregator program (CPI target)
    #[account(address = JUPITER_PROGRAM_ID)]
    pub jupiter_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn swap(ctx: Context<Swap>, data: Vec<u8>) -> Result<()> {
    use anchor_lang::solana_program::{
        instruction::{AccountMeta, Instruction},
        program::{invoke, invoke_signed},
        system_instruction,
    };

    // ---- validations first ----
    let trader = ctx.accounts.trader.key();
    require!(
        trader == ctx.accounts.vault_pool.money_manager
            || (ctx.accounts.vault_pool.trading_delegate != Pubkey::default()
                && trader == ctx.accounts.vault_pool.trading_delegate),
        FbytError::UnauthorizedTrader
    );
    require!(
        ctx.accounts.vault_pool.vault_pool_status == (VaultStatus::Active as u8),
        FbytError::VaultNotActive
    );
    require!(
        ctx.accounts.oracle_pool_from.is_approved && ctx.accounts.oracle_pool_to.is_approved,
        FbytError::OracleNotApproved
    );
    // Trading is only allowed once the fundraise period is over (`now >= created_at + raise_period`).
    let now = Clock::get()?.unix_timestamp as u64;
    require!(
        now >= ctx.accounts.vault_pool.created_at.saturating_add(ctx.accounts.vault_pool.raise_period),
        FbytError::InvalidTradingPeriod
    );
    // The vault must have reached its minimum raise before it can trade.
    require!(
        ctx.accounts.vault_pool.raised_amount_usd >= ctx.accounts.vault_pool.min_raise_amount_usd,
        FbytError::MinRaiseAmountNotReached
    );

    let in_before = ctx.accounts.vault_input_token_account.amount;
    let out_before = ctx.accounts.vault_output_token_account.amount;

    // ---- Jupiter CPI, signed by the vault PDA; route accounts via remaining_accounts ----
    let admin_pool = ctx.accounts.vault_pool.admin_pool;
    let money_manager_key = ctx.accounts.vault_pool.money_manager;
    let index_le = ctx.accounts.vault_pool.index.to_le_bytes();
    let bump = ctx.accounts.vault_pool.bump;
    let seeds: &[&[u8]] = &[
        VAULT_POOL_SEED,
        admin_pool.as_ref(),
        money_manager_key.as_ref(),
        index_le.as_ref(),
        &[bump],
    ];
    // The vault PDA is the ONLY account granted signer authority inside the Jupiter CPI (it signs via
    // `seeds`). Every other route account is forwarded WITHOUT its outer signer flag: the aggregator
    // authorizes moves out of its own pools with its own PDAs and never needs a caller-provided signer.
    // Do NOT preserve `account_info.is_signer` here — that would over-privilege the CPI.
    let vault_key = ctx.accounts.vault_pool.key();
    let metas: Vec<AccountMeta> = ctx
        .remaining_accounts
        .iter()
        .map(|account_info| {
            let is_signer = account_info.key() == vault_key;
            if account_info.is_writable {
                AccountMeta::new(account_info.key(), is_signer)
            } else {
                AccountMeta::new_readonly(account_info.key(), is_signer)
            }
        })
        .collect();
    invoke_signed(
        &Instruction {
            program_id: ctx.accounts.jupiter_program.key(),
            accounts: metas,
            data,
        },
        ctx.remaining_accounts,
        &[seeds],
    )?;

    // ---- post-CPI checks (must run after the swap) ----
    ctx.accounts.vault_input_token_account.reload()?;
    ctx.accounts.vault_output_token_account.reload()?;
    let input_amount = in_before.saturating_sub(ctx.accounts.vault_input_token_account.amount);
    let output_amount = ctx
        .accounts
        .vault_output_token_account
        .amount
        .saturating_sub(out_before);
    require!(input_amount > 0, FbytError::InvalidInputBalance);
    require!(output_amount > 0, FbytError::InvalidOutputBalance);
    // Each price account must be the canonical Pyth push-oracle sponsored feed account for its oracle's
    // feed (`InvalidPriceOracle` otherwise), so a trade can only be priced by the sponsored feed. This
    // check is swap-specific: the withdraw perf-fee valuation shares `oracle_value_usd` but does not
    // enforce the canonical-account requirement.
    let max_age = ctx.accounts.admin_pool.oracle_max_age;
    let input_feed = feed_id_of(&ctx.accounts.oracle_pool_from)?;
    require_keys_eq!(
        ctx.accounts.input_price_update.key(),
        expected_pyth_price_account(&input_feed),
        FbytError::InvalidPriceOracle
    );
    let output_feed = feed_id_of(&ctx.accounts.oracle_pool_to)?;
    require_keys_eq!(
        ctx.accounts.output_price_update.key(),
        expected_pyth_price_account(&output_feed),
        FbytError::InvalidPriceOracle
    );
    // Slippage guard: the output value must be within `max_slippage_bps` of the input value.
    let input_value_usd = oracle_value_usd(
        &ctx.accounts.input_price_update,
        &ctx.accounts.oracle_pool_from,
        max_age,
        ctx.accounts.input_mint.decimals,
        input_amount,
    )?;
    let output_value_usd = oracle_value_usd(
        &ctx.accounts.output_price_update,
        &ctx.accounts.oracle_pool_to,
        max_age,
        ctx.accounts.output_mint.decimals,
        output_amount,
    )?;
    let max_slippage_bps = ctx.accounts.admin_pool.max_slippage_bps as u128;
    require!(
        (output_value_usd as u128) * 10_000u128
            >= input_value_usd * (10_000u128 - max_slippage_bps),
        FbytError::SlippageExceeded
    );

    // ---- trading fee (SOL trader -> admin) ----
    let trading_fee = ctx.accounts.admin_pool.trading_fee;
    if trading_fee > 0 {
        invoke(
            &system_instruction::transfer(&trader, &ctx.accounts.admin.key(), trading_fee),
            &[
                ctx.accounts.trader.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    // ---- track BOTH swap legs in the registry (realloc-grow) ----
    // Both the input and output mints are registered, input first, each only if not already present
    // and each bounded by `max_asset_count`. A first `base -> X` trade therefore leaves the registry as
    // `[base, X]`, not just `[X]`.
    let out_mint = ctx.accounts.output_mint.key();
    for mint in [ctx.accounts.input_mint.key(), out_mint] {
        if !ctx.accounts.asset_registry.asset_mints.contains(&mint) {
            require!(
                (ctx.accounts.asset_registry.asset_mints.len() as u16)
                    < ctx.accounts.admin_pool.max_asset_count,
                FbytError::MaxAssetCountExceeded
            );
            grow_registry(
                &ctx.accounts.asset_registry.to_account_info(),
                &ctx.accounts.trader.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
            )?;
            ctx.accounts.asset_registry.asset_mints.push(mint);
            emit!(AssetAddedEvent {
                vault_pool: ctx.accounts.vault_pool.key(),
                asset_registry: ctx.accounts.asset_registry.key(),
                mint,
                total_assets: ctx.accounts.asset_registry.asset_mints.len() as u64
            });
        }
    }

    ctx.accounts.vault_pool.last_trade_at = Clock::get()?.unix_timestamp as u64;
    emit!(TradingEvent {
        admin_pool,
        money_manager: money_manager_key,
        vault_pool: ctx.accounts.vault_pool.key(),
        input_mint: ctx.accounts.input_mint.key(),
        input_mint_decimals: ctx.accounts.input_mint.decimals,
        output_mint: out_mint,
        output_mint_decimals: ctx.accounts.output_mint.decimals,
        input_amount,
        output_amount,
        trader,
    });
    Ok(())
}
