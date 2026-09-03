/**
 * End-to-end vault lifecycle against a running surfnet, mirroring exactly what the browser does:
 * the manager deposits during the raise, the vault is advanced past its fundraise (POST /api/dev/advance),
 * then the manager trades base -> the demo output asset through the jupiter-mock. Relies solely on the
 * state `pnpm bootstrap` seeds (the mock cloned at the Jupiter id, the demo output asset + counterparty).
 *
 *   pnpm localnet -> pnpm bootstrap -> pnpm tsx scripts/e2e-lifecycle.ts <vaultAddress>
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  address,
  createClient,
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  getProgramDerivedAddress,
  AccountRole,
  type Address,
  type AccountMeta,
  type ReadonlyUint8Array,
} from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import {
  fetchVaultPool,
  fetchAdminPool,
  fetchAssetRegistry,
  findAdminPoolPda,
  findOraclePoolPda,
  findAssetRegistryPda,
  fetchOraclePool,
  fetchMaybeInvestorPool,
  getCreateInvestorPoolInstructionAsync,
  getDepositTokenFundInstructionAsync,
  getSwapInstruction,
} from '../src/generated/index.js';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const PROGRAM_ID = address(process.env.NEXT_PUBLIC_FBYT_PROGRAM_ID ?? '3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM = address('11111111111111111111111111111111');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PYTH_RECEIVER = address('rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp');
const PYTH_PUSH_ORACLE = address('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
const JUPITER = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const OUT_FEED = '2222222222222222222222222222222222222222222222222222222222222222';
const VAULT = process.argv[2] as Address;
const addrEnc = getAddressEncoder();
const here = dirname(fileURLToPath(import.meta.url));

let id = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}
const le = (v: number | bigint, n: number) => { const o = new Uint8Array(n); let x = BigInt(v); for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
function concat(...parts: Array<ArrayLike<number>>): Uint8Array { const t = parts.reduce((n, p) => n + p.length, 0); const o = new Uint8Array(t); let k = 0; for (const p of parts) { o.set(Uint8Array.from(p), k); k += p.length; } return o; }
function feed32(bytesLike: ArrayLike<number>): Uint8Array { const hex = new TextDecoder().decode(Uint8Array.from(bytesLike)).replace(/\0+$/, '').replace(/^0x/, ''); const out = new Uint8Array(32); for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
function feed32hex(hex: string): Uint8Array { const out = new Uint8Array(32); for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
async function pda(p: Address, seeds: Array<Uint8Array | ReadonlyUint8Array>) { const [a] = await getProgramDerivedAddress({ programAddress: p, seeds }); return a; }
const ata = (owner: Address, mint: Address) => pda(ATA_PROGRAM, [addrEnc.encode(owner), addrEnc.encode(TOKEN_PROGRAM), addrEnc.encode(mint)]);
const bal = async (a: Address) => BigInt((await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [a])).value.amount);

/** The /api/dev/advance behaviour: refresh both prices at `when`, then jump the clock there. */
async function injectPrice(feed: Uint8Array, priceMicro: bigint, when: number) {
  const [acct] = await getProgramDerivedAddress({ programAddress: PYTH_PUSH_ORACLE, seeds: [new Uint8Array([0, 0]), feed] });
  const disc = new Uint8Array(createHash('sha256').update('account:PriceUpdateV2').digest()).slice(0, 8);
  const data = concat(disc, new Uint8Array(32), [1], feed, le(priceMicro, 8), le(1n, 8), le(0xfffffff8, 4), le(when, 8), le(when, 8), le(priceMicro, 8), le(1n, 8), le(0n, 8));
  await rpc('surfnet_setAccount', [acct, { lamports: 5_000_000, data: Buffer.from(data).toString('hex'), owner: PYTH_RECEIVER, executable: false, rent_epoch: 0 }]);
  return acct;
}

async function main() {
  if (!VAULT) throw new Error('usage: tsx scripts/e2e-lifecycle.ts <vaultAddress>');
  const manager = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(here, '.keys', 'manager.json'), 'utf8'))));
  const client = createClient().use(signer(manager)).use(solanaRpc({ rpcUrl: RPC_URL }));

  const d = (await fetchVaultPool(client.rpc, VAULT)).data;
  const [adminPoolAddr] = await findAdminPoolPda({ programAddress: PROGRAM_ID });
  const admin = await fetchAdminPool(client.rpc, adminPoolAddr);
  const [baseOracle] = await findOraclePoolPda({ adminPool: d.adminPool, tokenMint: d.tokenMint }, { programAddress: PROGRAM_ID });
  const baseFeed = feed32((await fetchOraclePool(client.rpc, baseOracle)).data.feedId);
  const basePrice = await pda(PYTH_PUSH_ORACLE, [new Uint8Array([0, 0]), baseFeed]);
  const [assetRegistry] = await findAssetRegistryPda({ vaultPool: VAULT }, { programAddress: PROGRAM_ID });
  const outMint = await pda(PROGRAM_ID, [new TextEncoder().encode('demo-out-mint')]);
  const [outOracle] = await findOraclePoolPda({ adminPool: d.adminPool, tokenMint: outMint }, { programAddress: PROGRAM_ID });

  // 1. deposit 100 base during the raise (mirrors the deposit UI)
  await rpc('surfnet_setTokenAccount', [manager.address, d.tokenMint, { amount: 1_000_000_000 }]);
  const managerBaseAta = await ata(manager.address, d.tokenMint);
  const [investorPool] = await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [new TextEncoder().encode('InvestorPool'), addrEnc.encode(manager.address), addrEnc.encode(d.adminPool), addrEnc.encode(VAULT), addrEnc.encode(d.tokenMint)] });
  const ixs = [];
  ixs.push(await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: manager, owner: VAULT, mint: d.tokenMint }));
  if (!(await fetchMaybeInvestorPool(client.rpc, investorPool)).exists) ixs.push(await getCreateInvestorPoolInstructionAsync({ investor: manager, vaultPool: VAULT, tokenMint: d.tokenMint }));
  ixs.push(await getDepositTokenFundInstructionAsync({ investor: manager, vaultPool: VAULT, oraclePool: baseOracle, fromAccount: managerBaseAta, tokenMint: d.tokenMint, priceUpdate: basePrice, tokenProgram: TOKEN_PROGRAM, amount: 100_000_000n }));
  await client.sendTransaction(ixs);
  const vaultInput = await ata(VAULT, d.tokenMint);
  console.log('deposited — vault input balance:', (await bal(vaultInput)).toString());

  // 2. advance past the fundraise (mirrors POST /api/dev/advance)
  const when = Number(d.createdAt + d.raisePeriod) + 60;
  await injectPrice(baseFeed, 150_000_000n, when);
  const outPrice = await injectPrice(feed32hex(OUT_FEED), 100_000_000n, when);
  await rpc('surfnet_timeTravel', [{ absoluteTimestamp: when * 1000 }]);
  console.log('advanced to trading, t =', when);

  // 3. trade base -> out through the mock (mirrors the trade UI exactly)
  const poolPda = await pda(JUPITER, [new TextEncoder().encode('pool')]);
  const vaultOutput = await ata(VAULT, outMint);
  const inputSink = await ata(poolPda, d.tokenMint);
  const outputSource = await ata(poolPda, outMint);
  const data = concat(le(10_000_000n, 8), le(15_000_000n, 8));
  const base = getSwapInstruction({
    adminPool: d.adminPool, admin: admin.data.admin, trader: manager, tokenMint: d.tokenMint, vaultPool: VAULT,
    assetRegistry, inputMint: d.tokenMint, inputMintProgram: TOKEN_PROGRAM, outputMint: outMint, outputMintProgram: TOKEN_PROGRAM,
    vaultInputTokenAccount: vaultInput, vaultOutputTokenAccount: vaultOutput, oraclePoolFrom: baseOracle, oraclePoolTo: outOracle,
    inputPriceUpdate: basePrice, outputPriceUpdate: outPrice, jupiterProgram: JUPITER, systemProgram: SYSTEM, data,
  });
  const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });
  const w = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });
  const route = [ro(TOKEN_PROGRAM), w(vaultInput), w(inputSink), w(outputSource), w(vaultOutput), ro(VAULT), ro(poolPda)];

  const inBefore = await bal(vaultInput);
  const res = await client.sendTransaction([{ programAddress: base.programAddress, accounts: [...base.accounts, ...route] as AccountMeta[], data: base.data }]);
  console.log('traded — signature', String(res.context.signature));

  const inAfter = await bal(vaultInput);
  const outAfter = await bal(vaultOutput);
  const reg = await fetchAssetRegistry(client.rpc, assetRegistry);
  console.log('vault input', inBefore.toString(), '→', inAfter.toString());
  console.log('vault output 0 →', outAfter.toString());
  console.log('registry assets:', reg.data.assetMints.length);
  if (inAfter >= inBefore || outAfter <= 0n) throw new Error('swap did not move funds');
  console.log('\n✅ full lifecycle (deposit → advance → trade) works end-to-end');
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); process.exit(1); });
