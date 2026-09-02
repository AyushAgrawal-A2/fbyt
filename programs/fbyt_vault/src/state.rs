use anchor_lang::prelude::*;

use crate::constants::*;

#[account]
#[derive(InitSpace)]
pub struct AdminPool {
    // Bump to identify PDA
    pub bump: u8,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub operator: Pubkey,
    pub vault_pool_count: u64,
    pub creation_fee: u64,
    pub protocol_performance_fee: u16,
    pub protocol_money_management_fee: u16,
    pub money_management_yearly_fee_max: u16,
    pub performance_fee_max: u16,
    pub trading_fee: u64,
    pub withdraw_cooldown_max: u64,
    pub fundrising_period_max: u64,
    pub raise_amount_min_usd: u64,
    pub contribution_amount_min_usd: u64,
    pub oracle_max_age: u64,
    pub idle_period: u64,
    pub dust_threshold_usd: u64,
    pub max_asset_count: u16,
    pub max_slippage_bps: u16,
    pub padding: [u8; 62],
}

#[account]
#[derive(InitSpace)]
pub struct AssetRegistry {
    // Bump to identify PDA
    pub bump: u8,
    // Reference to the vault pool this registry belongs to
    pub vault_pool: Pubkey,
    // Dynamic list of asset mints in the vault (realloc-grown; init reserves 0)
    #[max_len(0)]
    pub asset_mints: Vec<Pubkey>,
    pub padding: [u64; 8],
}

#[account]
#[derive(InitSpace)]
pub struct InvestorPool {
    // Bump to identify PDA
    pub bump: u8,
    pub investor: Pubkey,
    pub admin_pool: Pubkey,
    pub vault_pool: Pubkey,
    pub token_mint: Pubkey,
    pub shares: u64,
    pub hight_watermark: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub padding: [u64; 8],
}

#[account]
#[derive(InitSpace)]
pub struct MoneyManagerPool {
    // Bump to identify PDA
    pub bump: u8,
    pub money_manager: Pubkey,
    pub admin_pool: Pubkey,
    pub vaults_amount: u64,
    pub padding: [u64; 8],
}

#[account]
#[derive(InitSpace)]
pub struct OraclePool {
    // Bump to identify PDA
    pub bump: u8,
    // The block timestamp of the observation
    pub admin_pool: Pubkey,
    pub token_mint: Pubkey,
    pub feed_id: [u8; 66],
    pub is_approved: bool,
    pub padding: [u64; 8],
    /// Trailing reserve that pads `OraclePool` to its fixed 208-byte on-chain allocation.
    pub reserved: [u8; 4],
}

#[account]
#[derive(InitSpace)]
pub struct VaultPool {
    // Bump to identify PDA
    pub bump: u8,
    pub index: u64,
    pub admin_pool: Pubkey,
    pub money_manager: Pubkey,
    pub token_mint: Pubkey,
    // Reference to the asset registry for this vault
    pub asset_registry: Pubkey,
    pub vault_pool_status: u8,
    pub investor_count: u64,
    pub raised_amount_usd: u64,
    pub total_shares: u64,
    // Minimum contribution amount
    pub min_contribute_amount_usd: u64,
    pub raise_period: u64,
    pub min_raise_amount_usd: u64,
    pub mm_withdraw_period: u64,
    pub withdraw_cooldown: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_trade_at: u64,
    pub last_mm_fee_withdraw_at: u64,
    pub money_management_yearly_fee: u16,
    pub performance_fee: u16,
    pub is_open_ended: bool,
    pub padding1: [u8; 7],
    // Optional second key allowed to trade this vault — and only trade. Carved out of the head of `padding`, so the
    pub trading_delegate: Pubkey,
    pub padding: [u64; 11],
}

// Compile-time guards: the Anchor-derived account size (8-byte discriminator + INIT_SPACE) must
// equal the size measured against the deployed program's live accounts. If a struct layout ever
// drifts, the build fails here.
const _: () = assert!(AdminPool::DISCRIMINATOR.len() + AdminPool::INIT_SPACE == ADMIN_POOL_SPACE);
const _: () = assert!(
    MoneyManagerPool::DISCRIMINATOR.len() + MoneyManagerPool::INIT_SPACE
        == MONEY_MANAGER_POOL_SPACE
);
const _: () = assert!(VaultPool::DISCRIMINATOR.len() + VaultPool::INIT_SPACE == VAULT_POOL_SPACE);
const _: () =
    assert!(OraclePool::DISCRIMINATOR.len() + OraclePool::INIT_SPACE == ORACLE_POOL_SPACE);
const _: () =
    assert!(InvestorPool::DISCRIMINATOR.len() + InvestorPool::INIT_SPACE == INVESTOR_POOL_SPACE);
const _: () = assert!(
    AssetRegistry::DISCRIMINATOR.len() + AssetRegistry::INIT_SPACE == ASSET_REGISTRY_INIT_SPACE
);
