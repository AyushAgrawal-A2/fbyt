#![allow(unused_imports)]
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, get_feed_id_from_hex};

use crate::errors::*;
use crate::state::*;

/// Decode an OraclePool's stored 66-byte hex feed_id into the 32-byte Pyth FeedId.
pub fn feed_id_of(oracle_pool: &OraclePool) -> Result<[u8; 32]> {
    let feed_hex = core::str::from_utf8(&oracle_pool.feed_id)
        .unwrap_or("")
        .trim_end_matches('\0');
    get_feed_id_from_hex(feed_hex).map_err(|_| error!(FbytError::InvalidPriceFeed))
}

/// The canonical Pyth push-oracle sponsored feed account for `feed_id`: the PDA
/// `[shard = 0u16 LE, feed_id]` under `PYTH_PUSH_ORACLE_ID` (the pro push oracle `pyt2F414…`, which the
/// `pro-compatible` feature selects alongside the pro receiver). The `swap` handler requires each price
/// account to be exactly this so a trade can only be priced by the sponsored feed, not an arbitrary
/// caller-supplied `PriceUpdateV2` (`InvalidPriceOracle` otherwise).
pub fn expected_pyth_price_account(feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[&0u16.to_le_bytes(), feed_id.as_ref()],
        &pyth_solana_receiver_sdk::PYTH_PUSH_ORACLE_ID,
    )
    .0
}

/// Value `amount` base units of a token in micro-USD (6 dp) via its Pyth feed, requiring the feed to
/// match the oracle pool and to be no staler than `max_age`.
///
/// Known divergence from the deployed program: for whole-token quantities the two agree exactly, but
/// the deployed program's token→USD conversion loses one micro-USD unit for sub-1-token amounts (its
/// exact integer form is not recovered). This reconstruction uses the straightforward
/// `amount * price * 10^(6 + exponent - decimals)`. See RPC_FINDINGS.md ("token→USD conversion").
pub fn oracle_value_usd(
    price_update: &PriceUpdateV2,
    oracle_pool: &OraclePool,
    max_age: u64,
    decimals: u8,
    amount: u64,
) -> Result<u128> {
    require!(oracle_pool.is_approved, FbytError::OracleNotApproved);
    let feed_hex = core::str::from_utf8(&oracle_pool.feed_id)
        .unwrap_or("")
        .trim_end_matches('\0');
    let feed = get_feed_id_from_hex(feed_hex).map_err(|_| error!(FbytError::InvalidPriceFeed))?;
    // A Pyth `GetPriceError` propagates unmapped: a stale feed surfaces as `PriceTooOld` (Anchor code
    // 16000), never a remapped program error.
    let price = price_update.get_price_no_older_than(&Clock::get()?, max_age, &feed)?;
    require!(price.price > 0, FbytError::InvalidPrice);
    let net_exponent = 6i32 + price.exponent - decimals as i32;
    let scaled = (amount as u128)
        .checked_mul(price.price as u128)
        .ok_or(error!(FbytError::CalculateOverflow))?;
    Ok(if net_exponent >= 0 {
        scaled
            .checked_mul(10u128.pow(net_exponent as u32))
            .ok_or(error!(FbytError::CalculateOverflow))?
    } else {
        scaled / 10u128.pow((-net_exponent) as u32)
    })
}

/// Grow an AssetRegistry account by one Pubkey (32 bytes), topping up rent from `payer`.
/// (AssetRegistry is created empty and realloc-grown as assets are acquired.)
pub fn grow_registry<'info>(
    asset_registry_info: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
) -> Result<()> {
    let new_len = asset_registry_info.data_len() + 32;
    let needed_lamports = Rent::get()?.minimum_balance(new_len);
    let current_lamports = asset_registry_info.lamports();
    if needed_lamports > current_lamports {
        anchor_lang::solana_program::program::invoke(
            &anchor_lang::solana_program::system_instruction::transfer(
                payer.key,
                asset_registry_info.key,
                needed_lamports - current_lamports,
            ),
            &[
                payer.clone(),
                asset_registry_info.clone(),
                system_program.clone(),
            ],
        )?;
    }
    asset_registry_info.resize(new_len)?;
    Ok(())
}

/// Read an SPL/Token-2022 token account's `amount` (offset 64, u64 LE) from raw data.
pub fn read_token_amount(token_account: &AccountInfo) -> Result<u64> {
    let data = token_account.try_borrow_data()?;
    require!(data.len() >= 72, FbytError::InvalidAccountLength);
    let mut amount_bytes = [0u8; 8];
    amount_bytes.copy_from_slice(&data[64..72]);
    Ok(u64::from_le_bytes(amount_bytes))
}

/// Legacy SPL `Transfer` (instruction tag 3), PDA-signed. Works for classic SPL and
/// non-extension Token-2022 mints. (transfer_checked would need the mint per asset.)
pub fn spl_transfer_signed<'info>(
    token_program: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
    let mut data = Vec::with_capacity(9);
    data.push(3u8);
    data.extend_from_slice(&amount.to_le_bytes());
    let transfer_ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    anchor_lang::solana_program::program::invoke_signed(
        &transfer_ix,
        &[
            source.clone(),
            destination.clone(),
            authority.clone(),
            token_program.clone(),
        ],
        &[seeds],
    )?;
    Ok(())
}

