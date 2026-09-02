import {
  getBase58Decoder,
  getBase64Encoder,
  type Base58EncodedBytes,
  type Rpc,
  type GetProgramAccountsApi,
} from '@solana/kit';
import {
  VAULT_POOL_DISCRIMINATOR,
  getVaultPoolDecoder,
  type VaultPool,
} from '@/generated';
import { FBYT_PROGRAM_ID } from './config';

export type VaultSummary = {
  address: string;
  data: VaultPool;
};

const discriminatorBase58 = getBase58Decoder().decode(VAULT_POOL_DISCRIMINATOR) as Base58EncodedBytes;

/** Fetch and decode every `VaultPool` owned by the program. */
export async function fetchVaults(
  rpc: Rpc<GetProgramAccountsApi>,
): Promise<VaultSummary[]> {
  const accounts = await rpc
    .getProgramAccounts(FBYT_PROGRAM_ID, {
      encoding: 'base64',
      filters: [{ memcmp: { offset: 0n, bytes: discriminatorBase58, encoding: 'base58' } }],
    })
    .send();

  const decoder = getVaultPoolDecoder();
  const b64 = getBase64Encoder();
  return accounts.map((acc) => {
    const [dataStr] = acc.account.data;
    return { address: String(acc.pubkey), data: decoder.decode(b64.encode(dataStr)) };
  });
}

/** A leaderboard-style ordering: most capital raised first. */
export function sortVaults(vaults: VaultSummary[]): VaultSummary[] {
  return [...vaults].sort((a, b) => Number(b.data.raisedAmountUsd - a.data.raisedAmountUsd));
}
