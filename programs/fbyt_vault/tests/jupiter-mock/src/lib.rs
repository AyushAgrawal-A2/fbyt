//! Minimal stand-in for the Jupiter aggregator, for testing fbyt_vault::swap.
//!
//! The real swap CPIs into Jupiter with route accounts in remaining_accounts and opaque `data`, then
//! measures the vault input decrease / output increase. This mock reproduces that observable effect
//! with two SPL-token transfers, authorized exactly the way the real aggregator authorizes them:
//!   * INPUT leg (tokens OUT of the vault): the vault PDA is the authority. It signs via the fbyt
//!     swap's `invoke_signed`, and that signature propagates into this CPI — so a plain `invoke`
//!     works. (The deployed swap grants the vault PDA signer and NO other route account.)
//!   * OUTPUT leg (tokens INTO the vault): the source is a pool account owned by THIS program's own
//!     PDA, and the mock signs for it with `invoke_signed` — mirroring how Jupiter authorizes moves
//!     out of its own pools with its own PDAs, never with a caller-provided signer.
//!
//! data:     [input_amount: u64 LE][output_amount: u64 LE]
//! accounts: 0 token_program, 1 vault_input (src, vault-owned), 2 input_sink (dst),
//!           3 output_source (src, owned by this program's [b"pool"] PDA), 4 vault_output (dst),
//!           5 vault_authority (the fbyt vault PDA; signer propagated from the swap's invoke_signed),
//!           6 pool_authority (this program's [b"pool"] PDA; the mock signs for it)
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint, entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    pubkey::Pubkey,
};

entrypoint!(process);

const POOL_SEED: &[u8] = b"pool";

fn spl_transfer(token_program: &Pubkey, src: &Pubkey, dst: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![3u8]; // SPL Token "Transfer" tag
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*src, false),
            AccountMeta::new(*dst, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let input_amount = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let output_amount = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let account_iter = &mut accounts.iter();
    let token_program = next_account_info(account_iter)?;
    let vault_input = next_account_info(account_iter)?;
    let input_sink = next_account_info(account_iter)?;
    let output_source = next_account_info(account_iter)?;
    let vault_output = next_account_info(account_iter)?;
    let vault_authority = next_account_info(account_iter)?;
    let pool_authority = next_account_info(account_iter)?;

    // input leg: pull tokens OUT of the vault (vault PDA signs, propagated from the swap's invoke_signed)
    invoke(
        &spl_transfer(token_program.key, vault_input.key, input_sink.key, vault_authority.key, input_amount),
        &[vault_input.clone(), input_sink.clone(), vault_authority.clone(), token_program.clone()],
    )?;
    // output leg: push tokens INTO the vault, sourced from THIS program's pool PDA (mock signs for it)
    let (pool_pda, bump) = Pubkey::find_program_address(&[POOL_SEED], program_id);
    assert_eq!(&pool_pda, pool_authority.key, "output pool authority must be the mock's [b\"pool\"] PDA");
    invoke_signed(
        &spl_transfer(token_program.key, output_source.key, vault_output.key, pool_authority.key, output_amount),
        &[output_source.clone(), vault_output.clone(), pool_authority.clone(), token_program.clone()],
        &[&[POOL_SEED, &[bump]]],
    )?;
    Ok(())
}
