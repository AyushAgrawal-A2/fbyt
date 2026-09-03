/**
 * FBYT keeper — an off-chain automation bot that trades a vault on a schedule using the vault's
 * trading delegate (a trade-only key that can never withdraw). Mirrors the DCA / rebalance bots the
 * real platform runs. It builds the same `swap` the manager UI does, valuing legs against the Pyth
 * oracles, and sends them signed by the delegate.
 *
 *   1. manager sets a delegate:   (UI) Manage → Trading delegate → the keeper's pubkey
 *   2. run the keeper:            pnpm keeper scripts/keeper.config.json
 *
 * Config (see keeper.config.example.json):
 *   { "vault", "delegateKeypair", "intervalSec"?, "ticks"?, "strategies": [ ... ] }
 * Strategies:
 *   { "type": "dca",       "inputMint", "outputMint", "inputAmount", "maxSlippageBps"? }
 *   { "type": "rebalance", "assetA", "assetB", "targetABps", "maxTradeAmount", "maxSlippageBps"? }
 *
 * NOTE: this is the functional TypeScript keeper (it reuses the app's proven swap plumbing). A
 * production deployment would run the same strategy engine as a hardened Rust service.
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
type Strategy = DcaStrategy | RebalanceStrategy;
type Config = { vault: string; delegateKeypair: string; intervalSec?: number; ticks?: number; strategies: Strategy[] };

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
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

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('usage: tsx scripts/keeper.ts <config.json>');
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
  const kpPath = isAbsolute(cfg.delegateKeypair) ? cfg.delegateKeypair : join(here, cfg.delegateKeypair);
  const delegate = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(kpPath, 'utf8'))));
  const client = createClient().use(signer(delegate)).use(solanaRpc({ rpcUrl: RPC_URL }));
  const VAULT = cfg.vault as Address;

  const d0 = (await fetchVaultPool(client.rpc, VAULT)).data;
  const [adminPoolAddr] = await findAdminPoolPda({ programAddress: PROGRAM_ID });
  const admin = (await fetchAdminPool(client.rpc, adminPoolAddr)).data;
  const [assetRegistry] = await findAssetRegistryPda({ vaultPool: VAULT }, { programAddress: PROGRAM_ID });
  if (String(d0.tradingDelegate) !== delegate.address) {
    throw new Error(`vault delegate is ${String(d0.tradingDelegate)}, not the keeper (${delegate.address}). Set it in Manage → Trading delegate.`);
  }
  console.log(`keeper for vault ${cfg.vault} as delegate ${delegate.address}`);

  // read a mint's approved oracle price (raw, expo) and its canonical price account
  async function priceOf(mint: Address): Promise<{ price: bigint; expo: number; oraclePool: Address; priceAcct: Address; feed: Uint8Array }> {
    const [oraclePool] = await findOraclePoolPda({ adminPool: d0.adminPool, tokenMint: mint }, { programAddress: PROGRAM_ID });
    const oracle = await fetchOraclePool(client.rpc, oraclePool);
    const feed = feed32(oracle.data.feedId);
    const priceAcct = await pda(PYTH_PUSH_ORACLE, [new Uint8Array([0, 0]), feed]);
    const info = await rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [priceAcct, { encoding: 'base64' }]);
    if (!info.value) throw new Error(`no price account for ${String(mint)}`);
    const b = Uint8Array.from(Buffer.from(info.value.data[0], 'base64'));
    return { price: readI64LE(b, 73), expo: readI32LE(b, 89), oraclePool, priceAcct, feed };
  }

  // build + send a swap of `inputAmount` from -> to, valued at oracle mid minus slippage, as the delegate
  async function trade(inputMint: Address, outputMint: Address, inputAmount: bigint, maxSlippageBps: number) {
    if (inputAmount <= 0n) return;
    const from = await priceOf(inputMint);
    const to = await priceOf(outputMint);
    const inDec = 6, outDec = 6; // demo assets are 6dp; a production keeper reads mint decimals
    // fair output (micro precision): inAmt * priceIn/priceOut * 10^(outDec-inDec+expoIn-expoTo)
    const shift = outDec - inDec + from.expo - to.expo;
    let fair = inputAmount * from.price;
    fair = shift >= 0 ? fair * 10n ** BigInt(shift) : fair / 10n ** BigInt(-shift);
    fair = fair / to.price;
    const outputAmount = (fair * BigInt(10_000 - maxSlippageBps)) / 10_000n;
    if (outputAmount <= 0n) return;

    const poolPda = await pda(JUPITER, [new TextEncoder().encode('pool')]);
    const vaultInput = await ata(VAULT, inputMint);
    const vaultOutput = await ata(VAULT, outputMint);
    const inputSink = await ata(poolPda, inputMint);
    const outputSource = await ata(poolPda, outputMint);
    const base = getSwapInstruction({
      adminPool: d0.adminPool, admin: admin.admin, trader: delegate, tokenMint: d0.tokenMint, vaultPool: VAULT,
      assetRegistry, inputMint, inputMintProgram: TOKEN_PROGRAM, outputMint, outputMintProgram: TOKEN_PROGRAM,
      vaultInputTokenAccount: vaultInput, vaultOutputTokenAccount: vaultOutput, oraclePoolFrom: from.oraclePool, oraclePoolTo: to.oraclePool,
      inputPriceUpdate: from.priceAcct, outputPriceUpdate: to.priceAcct, jupiterProgram: JUPITER, systemProgram: SYSTEM,
      data: concat(le(inputAmount, 8), le(outputAmount, 8)),
    });
    const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });
    const w = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });
    const route = [ro(TOKEN_PROGRAM), w(vaultInput), w(inputSink), w(outputSource), w(vaultOutput), ro(VAULT), ro(poolPda)];
    const res = await client.sendTransaction([{ programAddress: base.programAddress, accounts: [...base.accounts, ...route] as AccountMeta[], data: base.data }]);
    console.log(`  swap ${inputAmount} ${String(inputMint).slice(0, 4)} -> ${outputAmount} ${String(outputMint).slice(0, 4)}  ${String(res.context.signature).slice(0, 12)}…`);
  }

  async function runStrategy(s: Strategy) {
    const slip = s.maxSlippageBps ?? admin.maxSlippageBps;
    if (s.type === 'dca') {
      await trade(address(s.inputMint), address(s.outputMint), BigInt(s.inputAmount), slip);
    } else if (s.type === 'rebalance') {
      // move toward a target weight for assetA (in bps of the A+B USD value)
      const a = address(s.assetA), b = address(s.assetB);
      const pa = await priceOf(a), pb = await priceOf(b);
      const balA = await bal(await ata(VAULT, a)), balB = await bal(await ata(VAULT, b));
      const usd = (amt: bigint, p: { price: bigint; expo: number }) => (amt * p.price) / 10n ** BigInt(-p.expo);
      const va = usd(balA, pa), vb = usd(balB, pb);
      const total = va + vb;
      if (total === 0n) return;
      const targetA = (total * BigInt(s.targetABps)) / 10_000n;
      const cap = BigInt(s.maxTradeAmount);
      if (va > targetA) {
        // A overweight → sell A for B. size in A units, capped.
        const overUsd = va - targetA;
        let sizeA = (overUsd * 10n ** BigInt(-pa.expo)) / pa.price;
        if (sizeA > cap) sizeA = cap;
        await trade(a, b, sizeA, slip);
      } else if (vb > total - targetA) {
        const overUsd = vb - (total - targetA);
        let sizeB = (overUsd * 10n ** BigInt(-pb.expo)) / pb.price;
        if (sizeB > cap) sizeB = cap;
        await trade(b, a, sizeB, slip);
      } else {
        console.log('  rebalance: within band, no trade');
      }
    }
  }

  const ticks = cfg.ticks ?? 1;
  for (let t = 0; t < ticks; t++) {
    console.log(`tick ${t + 1}/${ticks}`);
    for (const s of cfg.strategies) {
      try {
        await runStrategy(s);
      } catch (e) {
        console.error('  strategy error:', (e as Error)?.message ?? e);
      }
    }
    if (t < ticks - 1 && cfg.intervalSec) await sleep(cfg.intervalSec * 1000);
  }
  console.log('keeper done');
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); process.exit(1); });
