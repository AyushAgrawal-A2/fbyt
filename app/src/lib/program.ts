import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Address,
} from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  findOraclePoolPda,
  findInvestorPoolPda,
  findAssetRegistryPda,
} from '@/generated';
import { FBYT_PROGRAM_ID, TOKEN_PROGRAM_ID } from './config';

const addrEnc = getAddressEncoder();
const u64Enc = getU64Encoder();

/** The "pro" Pyth push-oracle program that owns the canonical sponsored-feed accounts. */
export const PYTH_PUSH_ORACLE_ID: Address = address('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');

/** Decode an OraclePool's stored 66-byte ASCII hex feed_id into the 32-byte Pyth feed id. */
export function feedId32(feedIdBytes: ArrayLike<number>): Uint8Array {
  const hex = new TextDecoder()
    .decode(Uint8Array.from(feedIdBytes))
    .replace(/\0+$/, '')
    .replace(/^0x/, '');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The canonical Pyth sponsored-feed account (PDA `[shard=0u16 LE, feed_id]` under the push oracle). */
export async function canonicalPriceAccount(feed32: Uint8Array): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PYTH_PUSH_ORACLE_ID,
    seeds: [new Uint8Array([0, 0]), feed32],
  });
  return pda;
}

export async function oraclePoolAddress(adminPool: Address, tokenMint: Address): Promise<Address> {
  const [pda] = await findOraclePoolPda({ adminPool, tokenMint }, { programAddress: FBYT_PROGRAM_ID });
  return pda;
}

export async function investorPoolAddress(
  investor: Address,
  adminPool: Address,
  vaultPool: Address,
  tokenMint: Address,
): Promise<Address> {
  const [pda] = await findInvestorPoolPda(
    { investor, adminPool, vaultPool, tokenMint },
    { programAddress: FBYT_PROGRAM_ID },
  );
  return pda;
}

export async function ata(owner: Address, mint: Address): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ID });
  return pda;
}

/** VaultPool PDA: `[VaultPool, admin_pool, money_manager, index_u64_le]`. */
export async function vaultPoolAddress(
  adminPool: Address,
  moneyManager: Address,
  index: bigint,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: FBYT_PROGRAM_ID,
    seeds: [
      new TextEncoder().encode('VaultPool'),
      addrEnc.encode(adminPool),
      addrEnc.encode(moneyManager),
      u64Enc.encode(index),
    ],
  });
  return pda;
}

export async function assetRegistryAddress(vaultPool: Address): Promise<Address> {
  const [pda] = await findAssetRegistryPda({ vaultPool }, { programAddress: FBYT_PROGRAM_ID });
  return pda;
}
