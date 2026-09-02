use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod util;

use instructions::*;

// NOTE: original mainnet program id is DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm.
// Using the local placeholder so it matches Anchor.toml / your generated keypair.
declare_id!("3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y");

#[program]
pub mod fbyt_vault {
    use super::*;

    pub fn admin_accept_ownership(ctx: Context<AdminAcceptOwnership>) -> Result<()> {
        instructions::admin_accept_ownership::admin_accept_ownership(ctx)
    }

    pub fn admin_modify_fee(
        ctx: Context<AdminModifyFee>,
        creation_fee: u64,
        protocol_performance_fee: u16,
        protocol_money_management_fee: u16,
        trading_fee: u64,
        money_management_yearly_fee_max: u16,
        performance_fee_max: u16,
    ) -> Result<()> {
        instructions::admin_modify_fee::admin_modify_fee(
            ctx,
            creation_fee,
            protocol_performance_fee,
            protocol_money_management_fee,
            trading_fee,
            money_management_yearly_fee_max,
            performance_fee_max,
        )
    }

    pub fn admin_transfer_ownership(ctx: Context<AdminTransferOwnership>) -> Result<()> {
        instructions::admin_transfer_ownership::admin_transfer_ownership(ctx)
    }

    pub fn admin_update_contribution_amount_min_usd(
        ctx: Context<AdminUpdateContributionAmountMinUsd>,
        new_contribution_amount_min_usd: u64,
    ) -> Result<()> {
        instructions::admin_update_contribution_amount_min_usd::admin_update_contribution_amount_min_usd(ctx, new_contribution_amount_min_usd)
    }

    pub fn admin_update_dust_threshold_usd(
        ctx: Context<AdminUpdateDustThresholdUsd>,
        new_dust_threshold_usd: u64,
    ) -> Result<()> {
        instructions::admin_update_dust_threshold_usd::admin_update_dust_threshold_usd(
            ctx,
            new_dust_threshold_usd,
        )
    }

    pub fn admin_update_fundrising_period_max(
        ctx: Context<AdminUpdateFundrisingPeriodMax>,
        new_fundrising_period_max: u64,
    ) -> Result<()> {
        instructions::admin_update_fundrising_period_max::admin_update_fundrising_period_max(
            ctx,
            new_fundrising_period_max,
        )
    }

    pub fn admin_update_idle_period(
        ctx: Context<AdminUpdateIdlePeriod>,
        new_idle_period: u64,
    ) -> Result<()> {
        instructions::admin_update_idle_period::admin_update_idle_period(ctx, new_idle_period)
    }

    pub fn admin_update_max_asset_count(
        ctx: Context<AdminUpdateMaxAssetCount>,
        new_max_asset_count: u16,
    ) -> Result<()> {
        instructions::admin_update_max_asset_count::admin_update_max_asset_count(
            ctx,
            new_max_asset_count,
        )
    }

    pub fn admin_update_max_slippage_bps(
        ctx: Context<AdminUpdateMaxSlippageBps>,
        new_max_slippage_bps: u16,
    ) -> Result<()> {
        instructions::admin_update_max_slippage_bps::admin_update_max_slippage_bps(
            ctx,
            new_max_slippage_bps,
        )
    }

    pub fn admin_update_operator(ctx: Context<AdminUpdateOperator>) -> Result<()> {
        instructions::admin_update_operator::admin_update_operator(ctx)
    }

    pub fn admin_update_oracle_max_age(
        ctx: Context<AdminUpdateOracleMaxAge>,
        new_oracle_max_age: u64,
    ) -> Result<()> {
        instructions::admin_update_oracle_max_age::admin_update_oracle_max_age(
            ctx,
            new_oracle_max_age,
        )
    }

    pub fn admin_update_raise_amount_min_usd(
        ctx: Context<AdminUpdateRaiseAmountMinUsd>,
        new_raise_amount_min_usd: u64,
    ) -> Result<()> {
        instructions::admin_update_raise_amount_min_usd::admin_update_raise_amount_min_usd(
            ctx,
            new_raise_amount_min_usd,
        )
    }

    pub fn admin_update_withdraw_cooldown_max(
        ctx: Context<AdminUpdateWithdrawCooldownMax>,
        new_withdraw_cooldown_max: u64,
    ) -> Result<()> {
        instructions::admin_update_withdraw_cooldown_max::admin_update_withdraw_cooldown_max(
            ctx,
            new_withdraw_cooldown_max,
        )
    }

    pub fn approve_oracle_pool(ctx: Context<ApproveOraclePool>) -> Result<()> {
        instructions::approve_oracle_pool::approve_oracle_pool(ctx)
    }

    pub fn close_oracle_pool(ctx: Context<CloseOraclePool>) -> Result<()> {
        instructions::close_oracle_pool::close_oracle_pool(ctx)
    }

    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        instructions::close_vault::close_vault(ctx)
    }

    pub fn create_admin_pool(
        ctx: Context<CreateAdminPool>,
        creation_fee: u64,
        protocol_performance_fee: u16,
        protocol_money_management_fee: u16,
        trading_fee: u64,
        money_management_yearly_fee_max: u16,
        performance_fee_max: u16,
        withdraw_cooldown_max: u64,
        fundrising_period_max: u64,
        raise_amount_min_usd: u64,
        contribution_amount_min_usd: u64,
        oracle_max_age: u64,
        idle_period: u64,
        dust_threshold_usd: u64,
        max_asset_count: u16,
        max_slippage_bps: u16,
    ) -> Result<()> {
        instructions::create_admin_pool::create_admin_pool(
            ctx,
            creation_fee,
            protocol_performance_fee,
            protocol_money_management_fee,
            trading_fee,
            money_management_yearly_fee_max,
            performance_fee_max,
            withdraw_cooldown_max,
            fundrising_period_max,
            raise_amount_min_usd,
            contribution_amount_min_usd,
            oracle_max_age,
            idle_period,
            dust_threshold_usd,
            max_asset_count,
            max_slippage_bps,
        )
    }

    pub fn create_investor_pool(ctx: Context<CreateInvestorPool>) -> Result<()> {
        instructions::create_investor_pool::create_investor_pool(ctx)
    }

    pub fn create_money_manager_pool(ctx: Context<CreateMoneyManagerPool>) -> Result<()> {
        instructions::create_money_manager_pool::create_money_manager_pool(ctx)
    }

    pub fn create_oracle_pool(ctx: Context<CreateOraclePool>, feed_id: String) -> Result<()> {
        instructions::create_oracle_pool::create_oracle_pool(ctx, feed_id)
    }

    pub fn create_vault(
        ctx: Context<CreateVault>,
        min_contribute_amount: u64,
        raise_period: u64,
        min_raise_amount: u64,
        mm_withdraw_period: u64,
        withdraw_cooldown: u64,
        money_management_fee: u16,
        performance_fee: u16,
        is_open_ended: bool,
    ) -> Result<()> {
        instructions::create_vault::create_vault(
            ctx,
            min_contribute_amount,
            raise_period,
            min_raise_amount,
            mm_withdraw_period,
            withdraw_cooldown,
            money_management_fee,
            performance_fee,
            is_open_ended,
        )
    }

    pub fn deposit_token_fund<'info>(
        ctx: Context<'info, DepositTokenFund<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::deposit_token_fund::deposit_token_fund(ctx, amount)
    }

    pub fn get_price_info(ctx: Context<GetPriceInfo>, feed_id: String) -> Result<()> {
        instructions::get_price_info::get_price_info(ctx, feed_id)
    }

    pub fn revoke_trading_delegate(ctx: Context<RevokeTradingDelegate>) -> Result<()> {
        instructions::revoke_trading_delegate::revoke_trading_delegate(ctx)
    }

    pub fn set_trading_delegate(
        ctx: Context<SetTradingDelegate>,
        trading_delegate: Pubkey,
    ) -> Result<()> {
        instructions::set_trading_delegate::set_trading_delegate(ctx, trading_delegate)
    }

    pub fn swap(ctx: Context<Swap>, data: Vec<u8>) -> Result<()> {
        instructions::swap::swap(ctx, data)
    }

    pub fn update_oracle_pool(ctx: Context<UpdateOraclePool>, feed_id: String) -> Result<()> {
        instructions::update_oracle_pool::update_oracle_pool(ctx, feed_id)
    }

    pub fn withdraw_money_management_fee<'info>(
        ctx: Context<'info, WithdrawMoneyManagementFee<'info>>,
    ) -> Result<()> {
        instructions::withdraw_money_management_fee::withdraw_money_management_fee(ctx)
    }

    pub fn withdraw_token_fund<'info>(
        ctx: Context<'info, WithdrawTokenFund<'info>>,
        shares: u64,
    ) -> Result<()> {
        instructions::withdraw_token_fund::withdraw_token_fund(ctx, shares)
    }
}
