use anchor_lang::prelude::*;

#[event]
pub struct AdminPoolAcceptOwnershipEvent {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct AdminPoolCreatedEvent {
    pub admin: Pubkey,
    pub operator: Pubkey,
    pub vault_pool_count: u64,
    pub creation_fee: u64,
    pub protocol_performance_fee: u16,
    pub protocol_money_management_fee: u16,
    pub trading_fee: u64,
    pub money_management_yearly_fee_max: u16,
    pub performance_fee_max: u16,
    pub withdraw_cooldown_max: u64,
    pub fundrising_period_max: u64,
    pub raise_amount_min_usd: u64,
    pub contribution_amount_min_usd: u64,
    pub oracle_max_age: u64,
    pub idle_period: u64,
    pub dust_threshold_usd: u64,
    pub max_asset_count: u16,
    pub max_slippage_bps: u16,
}

#[event]
pub struct AdminPoolModifyFeeEvent {
    pub admin: Pubkey,
    pub creation_fee: u64,
    pub protocol_performance_fee: u16,
    pub protocol_money_management_fee: u16,
    pub trading_fee: u64,
    pub money_management_yearly_fee_max: u16,
    pub performance_fee_max: u16,
}

#[event]
pub struct AdminPoolTransferOwnershipEvent {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminPoolUpdateContributionAmountMinUsdEvent {
    pub admin: Pubkey,
    pub new_contribution_amount_min_usd: u64,
}

#[event]
pub struct AdminPoolUpdateDustThresholdUsdEvent {
    pub admin: Pubkey,
    pub new_dust_threshold_usd: u64,
}

#[event]
pub struct AdminPoolUpdateFundrisingPeriodMaxEvent {
    pub admin: Pubkey,
    pub new_fundrising_period_max: u64,
}

#[event]
pub struct AdminPoolUpdateIdlePeriodEvent {
    pub admin: Pubkey,
    pub new_idle_period: u64,
}

#[event]
pub struct AdminPoolUpdateMaxAssetCountEvent {
    pub admin: Pubkey,
    pub new_max_asset_count: u16,
}

#[event]
pub struct AdminPoolUpdateMaxSlippageBpsEvent {
    pub admin: Pubkey,
    pub new_max_slippage_bps: u16,
}

#[event]
pub struct AdminPoolUpdateOperatorEvent {
    pub admin: Pubkey,
    pub new_operator: Pubkey,
}

#[event]
pub struct AdminPoolUpdateOracleMaxAgeEvent {
    pub admin: Pubkey,
    pub new_oracle_max_age: u64,
}

#[event]
pub struct AdminPoolUpdateRaiseAmountMinUsdEvent {
    pub admin: Pubkey,
    pub new_raise_amount_min_usd: u64,
}

#[event]
pub struct AdminPoolUpdateWithdrawCooldownMaxEvent {
    pub admin: Pubkey,
    pub new_withdraw_cooldown_max: u64,
}

#[event]
pub struct ApproveOraclePoolEvent {
    pub admin_pool: Pubkey,
    pub token_mint: Pubkey,
}

#[event]
pub struct AssetAddedEvent {
    pub vault_pool: Pubkey,
    pub asset_registry: Pubkey,
    pub mint: Pubkey,
    pub total_assets: u64,
}

#[event]
pub struct AssetRemovedEvent {
    pub vault_pool: Pubkey,
    pub asset_registry: Pubkey,
    pub mint: Pubkey,
    pub total_assets: u64,
}

#[event]
pub struct CloseOraclePoolEvent {
    pub admin_pool: Pubkey,
    pub token_mint: Pubkey,
    pub oracle_pool: Pubkey,
}

#[event]
pub struct CloseVaultEvent {
    pub admin_pool: Pubkey,
    pub money_manager: Pubkey,
    pub vault_pool: Pubkey,
    pub token_mint: Pubkey,
    pub status: u8,
}

#[event]
pub struct CreateOraclePoolEvent {
    pub admin_pool: Pubkey,
    pub token_mint: Pubkey,
    pub feed_id: String,
}

#[event]
pub struct DepositTokenFundEvent {
    pub investor: Pubkey,
    pub admin_pool: Pubkey,
    pub vault_pool: Pubkey,
    pub investor_pool: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub amount_usd: u64,
    pub shares: u64,
}

#[event]
pub struct InvestorPoolCreatedEvent {
    pub investor: Pubkey,
    pub admin_pool: Pubkey,
    pub vault_pool: Pubkey,
    pub token_mint: Pubkey,
    pub created_at: u64,
}

#[event]
pub struct MoneyManagerPoolCreatedEvent {
    pub money_manager: Pubkey,
    pub admin_pool: Pubkey,
}

#[event]
pub struct TradingDelegateRevokedEvent {
    pub vault_pool: Pubkey,
    pub money_manager: Pubkey,
    pub previous_delegate: Pubkey,
    pub timestamp: u64,
}

#[event]
pub struct TradingDelegateSetEvent {
    pub vault_pool: Pubkey,
    pub money_manager: Pubkey,
    pub trading_delegate: Pubkey,
    pub previous_delegate: Pubkey,
    pub timestamp: u64,
}

#[event]
pub struct TradingEvent {
    pub admin_pool: Pubkey,
    pub money_manager: Pubkey,
    pub vault_pool: Pubkey,
    pub input_mint: Pubkey,
    pub input_mint_decimals: u8,
    pub output_mint: Pubkey,
    pub output_mint_decimals: u8,
    pub input_amount: u64,
    pub output_amount: u64,
    pub trader: Pubkey,
}

#[event]
pub struct UpdateOraclePoolEvent {
    pub admin_pool: Pubkey,
    pub token_mint: Pubkey,
    pub feed_id: String,
}

#[event]
pub struct VaultCreatedEvent {
    pub index: u64,
    pub admin_pool: Pubkey,
    pub money_manager: Pubkey,
    pub token_mint: Pubkey,
    pub min_contribute_amount_usd: u64,
    pub raise_period: u64,
    pub min_raise_amount_usd: u64,
    pub mm_withdraw_period: u64,
    pub withdraw_cooldown: u64,
    pub created_at: u64,
    pub money_management_yearly_fee: u16,
    pub performance_fee: u16,
    pub price: i64,
    pub price_exponent: i32,
    pub is_open_ended: bool,
}

#[event]
pub struct WithdrawMoneyManagementFeeEvent {
    pub vault_pool: Pubkey,
    pub money_manager: Pubkey,
    pub token_mint: Pubkey,
    pub fee_amount: u64,
    pub admin_fee: u64,
}

#[event]
pub struct WithdrawTokenFundEvent {
    pub investor: Pubkey,
    pub investor_pool: Pubkey,
    pub vault_pool: Pubkey,
    pub token_mint: Pubkey,
    pub token_price: i64,
    pub token_exponent: i32,
    pub amount: u64,
    pub money_manager_fee: u64,
    pub performance_fee: u64,
    pub admin_fee: u64,
}

#[event]
pub struct WithdrawTokenFundResultEvent {
    pub investor: Pubkey,
    pub money_manager: Pubkey,
    pub admin_pool: Pubkey,
    pub vault_pool: Pubkey,
    pub investor_pool: Pubkey,
    pub vault_prev_value: u64,
    pub vault_updated_value: u64,
    pub investor_prev_value: u64,
    pub investor_updated_value: u64,
}
