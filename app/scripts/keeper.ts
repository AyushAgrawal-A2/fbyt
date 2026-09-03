/**
 * FBYT keeper — the off-chain automation bot. It trades vaults using their trading delegate (a
 * trade-only key that can never withdraw), mirroring the platform's DCA / grid / rebalance bots. It
 * builds the same `swap` the UI does, valuing legs against the Pyth oracles.
 *
 * Two modes:
 *   pnpm keeper scripts/keeper.config.json      # run strategies from a config file (one vault)
 *   pnpm keeper --db [delegateKeypair]          # run every enabled bot in the DB this key is the
 *                                               # delegate for, recording each execution as an order
 *
 * Strategies:
 *   dca       { inputMint, outputMint, inputAmount, maxSlippageBps? }
 *   rebalance { assetA, assetB, targetABps, maxTradeAmount, maxSlippageBps? }
 *   grid      { baseMint, quoteMint, stepBps, tradeAmount, maxSlippageBps? }   (state persisted per bot)
 *
 * A production deployment would run this same strategy engine as a hardened Rust service.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
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
  type TransactionSigner,
} from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import {
  fetchVaultPool,
  fetchAdminPool,
  fetchOraclePool,
  findAdminPoolPda,
  findOraclePoolPda,
  findAssetRegistryPda,
  getSwapInstruction,
} from '../src/generated/index.js';
import { dbAll, dbAppend, dbUpdate } from '../src/lib/db.js';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const PROGRAM_ID = address(process.env.NEXT_PUBLIC_FBYT_PROGRAM_ID ?? '3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM = address('11111111111111111111111111111111');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PYTH_PUSH_ORACLE = address('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
const JUPITER = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const here = dirname(fileURLToPath(import.meta.url));
const addrEnc = getAddressEncoder();

type DcaStrategy = { type: 'dca'; inputMint: string; outputMint: string; inputAmount: string; maxSlippageBps?: number };
type RebalanceStrategy = { type: 'rebalance'; assetA: string; assetB: string; targetABps: number; maxTradeAmount: string; maxSlippageBps?: number };
type GridStrategy = { type: 'grid'; baseMint: string; quoteMint: string; stepBps: number; tradeAmount: string; maxSlippageBps?: number };
type Strategy = DcaStrategy | RebalanceStrategy | GridStrategy;
type FileConfig = { vault: string; delegateKeypair: string; intervalSec?: number; ticks?: number; strategies: Strategy[] };
type Bot = { id: string; vault: string; owner: string; delegate: string; enabled: boolean; strategy: Strategy; runCount?: number; state?: { lastGridPrice?: string } };

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}
const le = (v: number | bigint, n: number) => { const o = new Uint8Array(n); let x = BigInt(v); for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
function concat(...p: Array<ArrayLike<number>>): Uint8Array { const t = p.reduce((n, x) => n + x.length, 0); const o = new Uint8Array(t); let k = 0; for (const x of p) { o.set(Uint8Array.from(x), k); k += x.length; } return o; }
function feed32(bytesLike: ArrayLike<number>): Uint8Array { const hex = new TextDecoder().decode(Uint8Array.from(bytesLike)).replace(/\0+$/, '').replace(/^0x/, ''); const out = new Uint8Array(32); for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
async function pda(prog: Address, seeds: Array<Uint8Array | ReadonlyUint8Array>) { const [a] = await getProgramDerivedAddress({ programAddress: prog, seeds }); return a; }
const ata = (owner: Address, mint: Address) => pda(ATA_PROGRAM, [addrEnc.encode(owner), addrEnc.encode(TOKEN_PROGRAM), addrEnc.encode(mint)]);
const bal = async (a: Address) => { const r = await rpc<{ value: { amount: string } | null }>('getTokenAccountBalance', [a]).catch(() => null); return r?.value ? BigInt(r.value.amount) : 0n; };
function readI64LE(b: Uint8Array, o: number): bigint { let x = 0n; for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(b[o + i]); if (b[o + 7] & 0x80) x -= 1n << 64n; return x; }
function readI32LE(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function loadSigner(path: string): Promise<TransactionSigner> {
  const p = isAbsolute(path) ? path : join(here, path);
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}
function makeClient(sig: TransactionSigner) {
  return createClient().use(signer(sig)).use(solanaRpc({ rpcUrl: RPC_URL }));
}
type FbytClient = ReturnType<typeof makeClient>;

type VaultCtx = Awaited<ReturnType<typeof makeContext>>;
async function makeContext(client: FbytClient, vault: Address) {
  const d = (await fetchVaultPool(client.rpc, vault)).data;
  const [adminPoolAddr] = await findAdminPoolPda({ programAddress: PROGRAM_ID });
  const admin = (await fetchAdminPool(client.rpc, adminPoolAddr)).data;
  const [assetRegistry] = await findAssetRegistryPda({ vaultPool: vault }, { programAddress: PROGRAM_ID });
  return { vault, d, admin, assetRegistry };
}

async function priceOf(client: FbytClient, adminPool: Address, mint: Address) {
  const [oraclePool] = await findOraclePoolPda({ adminPool, tokenMint: mint }, { programAddress: PROGRAM_ID });
  const oracle = await fetchOraclePool(client.rpc, oraclePool);
  const feed = feed32(oracle.data.feedId);
  const priceAcct = await pda(PYTH_PUSH_ORACLE, [new Uint8Array([0, 0]), feed]);
  const info = await rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [priceAcct, { encoding: 'base64' }]);
  if (!info.value) throw new Error(`no price account for ${String(mint)}`);
  const b = Uint8Array.from(Buffer.from(info.value.data[0], 'base64'));
  return { price: readI64LE(b, 73), expo: readI32LE(b, 89), oraclePool, priceAcct };
}

type Exec = { inputMint: string; outputMint: string; inputAmount: string; outputAmount: string; signature: string };
async function trade(client: FbytClient, ctx: VaultCtx, delegate: TransactionSigner, inputMint: Address, outputMint: Address, inputAmount: bigint, maxSlippageBps: number): Promise<Exec | null> {
  if (inputAmount <= 0n) return null;
  const from = await priceOf(client, ctx.d.adminPool, inputMint);
  const to = await priceOf(client, ctx.d.adminPool, outputMint);
  const shift = 0 + from.expo - to.expo; // demo assets are 6dp; a production keeper reads mint decimals
  let fair = inputAmount * from.price;
  fair = shift >= 0 ? fair * 10n ** BigInt(shift) : fair / 10n ** BigInt(-shift);
  fair = fair / to.price;
  const outputAmount = (fair * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  if (outputAmount <= 0n) return null;
  const poolPda = await pda(JUPITER, [new TextEncoder().encode('pool')]);
  const vaultInput = await ata(ctx.vault, inputMint);
  const vaultOutput = await ata(ctx.vault, outputMint);
  const inputSink = await ata(poolPda, inputMint);
  const outputSource = await ata(poolPda, outputMint);
  const base = getSwapInstruction({
    adminPool: ctx.d.adminPool, admin: ctx.admin.admin, trader: delegate, tokenMint: ctx.d.tokenMint, vaultPool: ctx.vault,
    assetRegistry: ctx.assetRegistry, inputMint, inputMintProgram: TOKEN_PROGRAM, outputMint, outputMintProgram: TOKEN_PROGRAM,
    vaultInputTokenAccount: vaultInput, vaultOutputTokenAccount: vaultOutput, oraclePoolFrom: from.oraclePool, oraclePoolTo: to.oraclePool,
    inputPriceUpdate: from.priceAcct, outputPriceUpdate: to.priceAcct, jupiterProgram: JUPITER, systemProgram: SYSTEM,
    data: concat(le(inputAmount, 8), le(outputAmount, 8)),
  });
  const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });
  const w = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });
  const route = [ro(TOKEN_PROGRAM), w(vaultInput), w(inputSink), w(outputSource), w(vaultOutput), ro(ctx.vault), ro(poolPda)];
  const res = await client.sendTransaction([{ programAddress: base.programAddress, accounts: [...base.accounts, ...route] as AccountMeta[], data: base.data }]);
  const sig = String(res.context.signature);
  console.log(`  swap ${inputAmount} ${String(inputMint).slice(0, 4)} -> ${outputAmount} ${String(outputMint).slice(0, 4)}  ${sig.slice(0, 12)}…`);
  return { inputMint: String(inputMint), outputMint: String(outputMint), inputAmount: inputAmount.toString(), outputAmount: outputAmount.toString(), signature: sig };
}

/** Run one strategy against a vault; returns the executions (and any updated grid state). */
async function runStrategy(client: FbytClient, ctx: VaultCtx, delegate: TransactionSigner, s: Strategy, state?: Bot['state']): Promise<{ execs: Exec[]; state?: Bot['state'] }> {
  const slip = s.maxSlippageBps ?? ctx.admin.maxSlippageBps;
  const execs: Exec[] = [];
  if (s.type === 'dca') {
    const e = await trade(client, ctx, delegate, address(s.inputMint), address(s.outputMint), BigInt(s.inputAmount), slip);
    if (e) execs.push(e);
    return { execs };
  }
  if (s.type === 'rebalance') {
    const a = address(s.assetA), b = address(s.assetB);
    const pa = await priceOf(client, ctx.d.adminPool, a), pb = await priceOf(client, ctx.d.adminPool, b);
    const balA = await bal(await ata(ctx.vault, a)), balB = await bal(await ata(ctx.vault, b));
    const usd = (amt: bigint, p: { price: bigint; expo: number }) => (amt * p.price) / 10n ** BigInt(-p.expo);
    const va = usd(balA, pa), vb = usd(balB, pb), total = va + vb;
    if (total === 0n) { console.log('  rebalance: empty vault'); return { execs }; }
    const targetA = (total * BigInt(s.targetABps)) / 10_000n;
    const cap = BigInt(s.maxTradeAmount);
    if (va > targetA) {
      let size = ((va - targetA) * 10n ** BigInt(-pa.expo)) / pa.price; if (size > cap) size = cap;
      const e = await trade(client, ctx, delegate, a, b, size, slip); if (e) execs.push(e);
    } else if (vb > total - targetA) {
      let size = ((vb - (total - targetA)) * 10n ** BigInt(-pb.expo)) / pb.price; if (size > cap) size = cap;
      const e = await trade(client, ctx, delegate, b, a, size, slip); if (e) execs.push(e);
    } else console.log('  rebalance: within band');
    return { execs };
  }
  // grid: buy the base when its quote-price drops a step below the last fill, sell when it rises a step
  const base = address(s.baseMint), quote = address(s.quoteMint);
  const pb2 = await priceOf(client, ctx.d.adminPool, base);
  const cur = pb2.price; // base price in quote terms (both expo -8 on the demo)
  const last = state?.lastGridPrice ? BigInt(state.lastGridPrice) : cur;
  const step = (last * BigInt(s.stepBps)) / 10_000n;
  if (cur <= last - step) {
    const e = await trade(client, ctx, delegate, quote, base, BigInt(s.tradeAmount), slip); if (e) execs.push(e);
    return { execs, state: { lastGridPrice: cur.toString() } };
  }
  if (cur >= last + step) {
    const e = await trade(client, ctx, delegate, base, quote, BigInt(s.tradeAmount), slip); if (e) execs.push(e);
    return { execs, state: { lastGridPrice: cur.toString() } };
  }
  console.log('  grid: price within a step, no trade');
  return { execs, state: { lastGridPrice: last.toString() } };
}

async function runFileConfig(cfg: FileConfig) {
  const delegate = await loadSigner(cfg.delegateKeypair);
  const client = createClient().use(signer(delegate)).use(solanaRpc({ rpcUrl: RPC_URL }));
  const ctx = await makeContext(client, cfg.vault as Address);
  if (String(ctx.d.tradingDelegate) !== delegate.address) throw new Error(`vault delegate is ${String(ctx.d.tradingDelegate)}, not the keeper (${delegate.address})`);
  console.log(`keeper for vault ${cfg.vault} as delegate ${delegate.address}`);
  const ticks = cfg.ticks ?? 1;
  for (let t = 0; t < ticks; t++) {
    console.log(`tick ${t + 1}/${ticks}`);
    for (const s of cfg.strategies) {
      try { await runStrategy(client, ctx, delegate, s); } catch (e) { console.error('  strategy error:', (e as Error)?.message ?? e); }
    }
    if (t < ticks - 1 && cfg.intervalSec) await sleep(cfg.intervalSec * 1000);
  }
  console.log('keeper done');
}

async function runDbMode(delegatePath: string) {
  const delegate = await loadSigner(delegatePath);
  const client = createClient().use(signer(delegate)).use(solanaRpc({ rpcUrl: RPC_URL }));
  const bots = (await dbAll<Bot>('bots')).filter((b) => b.enabled && b.delegate === delegate.address);
  console.log(`keeper (db mode) as ${delegate.address}: ${bots.length} enabled bot(s)`);
  const byVault = new Map<string, Bot[]>();
  for (const b of bots) (byVault.get(b.vault) ?? byVault.set(b.vault, []).get(b.vault)!).push(b);
  for (const [vault, vaultBots] of byVault) {
    let ctx: VaultCtx;
    try { ctx = await makeContext(client, vault as Address); } catch (e) { console.error(`  vault ${vault}: ${(e as Error).message}`); continue; }
    if (String(ctx.d.tradingDelegate) !== delegate.address) { console.error(`  vault ${vault}: delegate mismatch, skipping`); continue; }
    for (const b of vaultBots) {
      console.log(`bot ${b.id} (${b.strategy.type}) on ${vault.slice(0, 6)}…`);
      try {
        const { execs, state } = await runStrategy(client, ctx, delegate, b.strategy, b.state);
        for (const e of execs) await dbAppend('botOrders', { botId: b.id, vault, t: Date.now(), ...e });
        await dbUpdate<Bot>('bots', b.id, { runCount: (b.runCount ?? 0) + 1, ...(state ? { state } : {}), lastRunAt: Date.now() } as Partial<Bot>);
      } catch (e) { console.error('  bot error:', (e as Error)?.message ?? e); }
    }
  }
  console.log('keeper done');
}

async function main() {
  const arg = process.argv[2];
  if (!arg) throw new Error('usage: tsx scripts/keeper.ts <config.json> | --db [delegateKeypair]');
  if (arg === '--db') {
    await runDbMode(process.argv[3] ?? '.keys/delegate.json');
  } else {
    await runFileConfig(JSON.parse(readFileSync(arg, 'utf8')) as FileConfig);
  }
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); process.exit(1); });
