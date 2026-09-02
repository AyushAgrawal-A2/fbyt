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
pub struct WithdrawMoneyManagementFee<'info> {
    #[account(
        seeds = [ADMIN_POOL_SEED],
        bump = admin_pool.bump
    )]
    pub admin_pool: Box<Account<'info, AdminPool>>,

    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(
        mut,
        has_one = admin_pool
    )]
    pub vault_pool: Box<Account<'info, VaultPool>>,

    #[account(
        seeds = [ASSET_REGISTRY_SEED, vault_pool.key().as_ref()],
        bump = asset_registry.bump,
        has_one = vault_pool
    )]
    pub asset_registry: Box<Account<'info, AssetRegistry>>,

    pub token_program: Program<'info, Token>,

    pub token_program2022: Program<'info, Token2022>,
}

pub fn withdraw_money_management_fee<'info>(
    ctx: Context<'info, WithdrawMoneyManagementFee<'info>>,
) -> Result<()> {
    // Streams the money-manager fee in kind. For each vault asset supplied in `remaining_accounts` as a
    // group of 4 `[mint, vault_ata, manager_ata, protocol_ata]`, the accrued fee is
    // `balance * yearly_fee_bps * elapsed / (10_000 * SECONDS_PER_YEAR)`, split protocol/manager and
    // transferred out of the vault ATA, emitting one event per asset. Only the protocol `operator` may
    // trigger it.
    require_keys_eq!(
        ctx.accounts.operator.key(),
        ctx.accounts.admin_pool.operator,
        FbytError::InvalidOperator
    );
    // The vault must have traded at least once. A never-traded vault has `last_trade_at == created_at`
    // (its init sentinel), so that equality — not `!= 0` — is the NoTradesYet condition.
    require!(
        ctx.accounts.vault_pool.last_trade_at != ctx.accounts.vault_pool.created_at,
        FbytError::NoTradesYet
    );
    let now = Clock::get()?.unix_timestamp as u64;
    // The vault must not be dormant: a fee withdrawal more than `idle_period` (an AdminPool field) after
    // the last trade is refused with `VaultIsDormant`.
    require!(
        now <= ctx.accounts.vault_pool.last_trade_at.saturating_add(ctx.accounts.admin_pool.idle_period),
        FbytError::VaultIsDormant
    );
    // At least one `mm_withdraw_period` must have elapsed since the last fee withdrawal.
    // `last_mm_fee_withdraw_at` is initialized to `created_at + raise_period`, so the first fee is
    // claimable one period after the fundraise ends. A too-soon call rejects with `OutsideWithdrawPeriod`.
    let last = ctx.accounts.vault_pool.last_mm_fee_withdraw_at;
    require!(
        now >= last.saturating_add(ctx.accounts.vault_pool.mm_withdraw_period),
        FbytError::OutsideWithdrawPeriod
    );

    let vault_key = ctx.accounts.vault_pool.key();
    let money_manager_key = ctx.accounts.vault_pool.money_manager;
    let admin_pool_key = ctx.accounts.vault_pool.admin_pool;
    let index_le = ctx.accounts.vault_pool.index.to_le_bytes();
    let bump = ctx.accounts.vault_pool.bump;
    let yearly_fee_bps = ctx.accounts.vault_pool.money_management_yearly_fee as u128;
    let protocol_fee_bps = ctx.accounts.admin_pool.protocol_money_management_fee as u128;
    let elapsed_seconds = now.saturating_sub(last) as u128;
    let seeds: &[&[u8]] = &[
        VAULT_POOL_SEED,
        admin_pool_key.as_ref(),
        money_manager_key.as_ref(),
        index_le.as_ref(),
        &[bump],
    ];
    let vault_info = ctx.accounts.vault_pool.to_account_info();
    let protocol_admin = ctx.accounts.admin_pool.admin;

    require!(
        ctx.remaining_accounts.len() % 4 == 0,
        FbytError::InvalidAccountLength
    );
    for group in ctx.remaining_accounts.chunks(4) {
        let (mint_info, vault_ata, manager_ata, protocol_ata) =
            (&group[0], &group[1], &group[2], &group[3]);
        let mint = mint_info.key();
        // The fee-recipient ATAs must belong to the money_manager and protocol admin respectively;
        // otherwise the operator could redirect the streamed fees to accounts they control.
        {
            let data = manager_ata.try_borrow_data()?;
            require!(data.len() >= 64 && data[32..64] == money_manager_key.to_bytes(), FbytError::InvalidMoneyManagerAccount);
        }
        {
            let data = protocol_ata.try_borrow_data()?;
            require!(data.len() >= 64 && data[32..64] == protocol_admin.to_bytes(), FbytError::InvalidAdminAccount);
        }
        {
            let token_account_data = vault_ata.try_borrow_data()?;
            require!(
                token_account_data.len() >= 72,
                FbytError::InvalidAccountLength
            );
            require!(
                token_account_data[0..32] == mint.to_bytes(),
                FbytError::InvalidTokenMint
            );
            require!(
                token_account_data[32..64] == vault_key.to_bytes(),
                FbytError::InvalidTokenOwner
            );
        }
        let balance = read_token_amount(vault_ata)? as u128;
        let total_fee = balance
            .checked_mul(yearly_fee_bps)
            .ok_or(error!(FbytError::CalculateOverflow))?
            .checked_mul(elapsed_seconds)
            .ok_or(error!(FbytError::CalculateOverflow))?
            / (10_000u128 * SECONDS_PER_YEAR);
        if total_fee == 0 {
            continue;
        }
        let admin_fee: u64 = (total_fee * protocol_fee_bps / 10_000u128)
            .try_into()
            .map_err(|_| error!(FbytError::CalculateOverflow))?;
        let manager_fee: u64 = (total_fee as u64).saturating_sub(admin_fee);
        let token_program_info = if vault_ata.owner == &ctx.accounts.token_program.key() {
            ctx.accounts.token_program.to_account_info()
        } else {
            ctx.accounts.token_program2022.to_account_info()
        };
        if manager_fee > 0 {
            spl_transfer_signed(
                &token_program_info,
                vault_ata,
                manager_ata,
                &vault_info,
                manager_fee,
                seeds,
            )?;
        }
        if admin_fee > 0 {
            spl_transfer_signed(
                &token_program_info,
                vault_ata,
                protocol_ata,
                &vault_info,
                admin_fee,
                seeds,
            )?;
        }
        emit!(WithdrawMoneyManagementFeeEvent {
            vault_pool: vault_key,
            money_manager: money_manager_key,
            token_mint: mint,
            fee_amount: manager_fee,
            admin_fee
        });
    }
    ctx.accounts.vault_pool.last_mm_fee_withdraw_at = now;
    Ok(())
}
