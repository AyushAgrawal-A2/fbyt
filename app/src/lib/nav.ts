import {
  createSolanaRpc,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type ReadonlyUint8Array,
} from '@solana/kit';
import {
  fetchMaybeVaultPool,
  fetchMaybeAssetRegistry,
  fetchMaybeOraclePool,
  findOraclePoolPda,
  findAssetRegistryPda,
} from '@/generated';
import { FBYT_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@/lib/config';
import { PYTH_PUSH_ORACLE_ID } from '@/lib/program';

const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address;
const addrEnc = getAddressEncoder();

export type Holding = {
  mint: string;
  amount: string; // base units
  decimals: number;
  priceUsd: number; // human USD per whole token
  valueMicroUsd: string; // micro-USD (6dp)
};

export type Nav = {
  navMicroUsd: string;
  raisedMicroUsd: string;
  pnlBps: number; // (nav - raised) / raised, in basis points; 0 if raised == 0
  holdings: Holding[];
};

type Rpc = ReturnType<typeof createSolanaRpc>;

function feed32(feedIdBytes: ArrayLike<number>): Uint8Array {
  const hex = new TextDecoder().decode(Uint8Array.from(feedIdBytes)).replace(/\0+$/, '').replace(/^0x/, '');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function pda(program: Address, seeds: Array<Uint8Array | ReadonlyUint8Array>): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: program, seeds });
  return a;
}
function readI64LE(b: Uint8Array, o: number): bigint {
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(b[o + i]);
  if (b[o + 7] & 0x80) x -= 1n << 64n;
  return x;
}
function readI32LE(b: Uint8Array, o: number): number {
  const v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  return v; // already signed via <<24
}

/** Parse a Pyth PriceUpdateV2 account: price (i64) at offset 73, exponent (i32) at offset 89. */
function parsePythPrice(dataB64: string): { price: bigint; expo: number } {
  const b = Uint8Array.from(Buffer.from(dataB64, 'base64'));
  return { price: readI64LE(b, 73), expo: readI32LE(b, 89) };
}

/** Compute a vault's live NAV in micro-USD by valuing every held asset against its Pyth oracle. */
export async function computeNav(vault: string, rpcUrl: string): Promise<Nav | null> {
  const rpc = createSolanaRpc(rpcUrl);
  const v = await fetchMaybeVaultPool(rpc, vault as Address);
  if (!v.exists) return null;
  const d = v.data;

  const [registryAddr] = await findAssetRegistryPda({ vaultPool: vault as Address }, { programAddress: FBYT_PROGRAM_ID });
  const registry = await fetchMaybeAssetRegistry(rpc, registryAddr);
  const registryMints = registry.exists ? registry.data.assetMints.map((m) => String(m)) : [];
  const mints = [String(d.tokenMint), ...registryMints].filter((m, i, a) => a.indexOf(m) === i);

  const holdings: Holding[] = [];
  let navMicro = 0n;
  for (const m of mints) {
    const mint = m as Address;
    const vaultAta = await pda(ATA_PROGRAM, [addrEnc.encode(vault as Address), addrEnc.encode(TOKEN_PROGRAM_ID), addrEnc.encode(mint)]);
    const bal = await rpc.getTokenAccountBalance(vaultAta).send().catch(() => null);
    const amount = bal?.value ? BigInt(bal.value.amount) : 0n;
    const decimals = bal?.value?.decimals ?? 6;
    if (amount === 0n) continue;

    const [oraclePool] = await findOraclePoolPda({ adminPool: d.adminPool, tokenMint: mint }, { programAddress: FBYT_PROGRAM_ID });
    const oracle = await fetchMaybeOraclePool(rpc, oraclePool);
    if (!oracle.exists) continue;
    const priceAcct = await pda(PYTH_PUSH_ORACLE_ID, [new Uint8Array([0, 0]), feed32(oracle.data.feedId)]);
    const info = await rpc.getAccountInfo(priceAcct, { encoding: 'base64' }).send().catch(() => null);
    if (!info?.value) continue;
    const { price, expo } = parsePythPrice(info.value.data[0]);

    // micro-USD = amount * price * 10^(6 + expo - decimals)
    const shift = 6 + expo - decimals;
    let valueMicro: bigint;
    if (shift >= 0) valueMicro = amount * price * 10n ** BigInt(shift);
    else valueMicro = (amount * price) / 10n ** BigInt(-shift);
    navMicro += valueMicro;

    holdings.push({
      mint: m,
      amount: amount.toString(),
      decimals,
      priceUsd: Number(price) * 10 ** expo,
      valueMicroUsd: valueMicro.toString(),
    });
  }

  const raised = d.raisedAmountUsd;
  const pnlBps = raised > 0n ? Number(((navMicro - raised) * 10_000n) / raised) : 0;
  return { navMicroUsd: navMicro.toString(), raisedMicroUsd: raised.toString(), pnlBps, holdings };
}
