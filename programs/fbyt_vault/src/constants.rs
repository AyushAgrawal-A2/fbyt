use anchor_lang::prelude::*;

/// PDA seed prefixes — byte-for-byte the deployed program's seeds.
pub const ADMIN_POOL_SEED: &[u8] = b"AdminPool";
pub const MONEY_MANAGER_POOL_SEED: &[u8] = b"MoneyManagerPool";
pub const VAULT_POOL_SEED: &[u8] = b"VaultPool";
pub const ASSET_REGISTRY_SEED: &[u8] = b"AssetRegistry";
pub const INVESTOR_POOL_SEED: &[u8] = b"InvestorPool";
pub const ORACLE_POOL_SEED: &[u8] = b"oracle_pool";

/// Jupiter aggregator program — CPI target for `swap`.
pub const JUPITER_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// Total account sizes (incl. 8-byte discriminator), measured against the deployed
/// program's live accounts on mainnet — NOT derived, so they match byte-for-byte.
pub const ADMIN_POOL_SPACE: usize = 259;
pub const MONEY_MANAGER_POOL_SPACE: usize = 145;
pub const VAULT_POOL_SPACE: usize = 374;
pub const ORACLE_POOL_SPACE: usize = 208;
pub const INVESTOR_POOL_SPACE: usize = 233;
/// AssetRegistry is created empty and realloc-grown (+32 per asset) in the trade
/// handler — this is the initial (zero-asset) size, not a max_len allocation.
pub const ASSET_REGISTRY_INIT_SPACE: usize = 109;

/// On-chain vault status byte (`VaultPool.vault_pool_status`): `Active = 1` is the normal live state
/// and `Dormant = 2` marks a vault idle past `idle_period`. "Fundraising" is a backend-derived label,
/// not a distinct on-chain value (a fundraising vault is still `Active`). `Closed = 3` is the assumed
/// value for a soft-closed vault; no closed vault has been observed on-chain to pin it exactly.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VaultStatus {
    Active = 1,
    Dormant = 2,
    Closed = 3,
}

/// Seconds per year for annualized (streamed) management-fee accrual.
pub const SECONDS_PER_YEAR: u128 = 31_536_000;

/// Minimum money-manager fee-withdrawal cadence (1 week). `create_vault` rejects a smaller
/// `mm_withdraw_period` with `InvalidWithdrawPeriod`.
pub const MIN_MM_WITHDRAW_PERIOD: u64 = 604_800;
