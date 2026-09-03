/**
 * End-to-end check of the protocol-admin surface against a running surfnet, as the deployer (who is
 * the AdminPool admin). Mirrors what the /admin page builds: modify fees, update a scalar limit, and
 * onboard a fresh asset (create_oracle_pool + approve_oracle_pool). Asserts the AdminPool and the new
 * OraclePool reflect the changes. Restores the values it changes.
 *
 *   pnpm localnet -> pnpm bootstrap -> pnpm tsx scripts/e2e-admin.ts
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
  type Address,
} from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import {
  fetchAdminPool,
  fetchOraclePool,
  fetchMaybeOraclePool,
  findAdminPoolPda,
  findOraclePoolPda,
  getAdminModifyFeeInstructionAsync,
  getAdminUpdateMaxSlippageBpsInstructionAsync,
  getCreateOraclePoolInstructionAsync,
  getApproveOraclePoolInstructionAsync,
  getUpdateOraclePoolInstructionAsync,
  getCloseOraclePoolInstructionAsync,
  getGetPriceInfoInstructionAsync,
} from '../src/generated/index.js';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const PROGRAM_ID = address(process.env.NEXT_PUBLIC_FBYT_PROGRAM_ID ?? '3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const PYTH_RECEIVER = address('rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp');
const PYTH_PUSH_ORACLE = address('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
const here = dirname(fileURLToPath(import.meta.url));
const addrEnc = getAddressEncoder();

let id = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}
const le = (v: number | bigint, n: number) => { const o = new Uint8Array(n); let x = BigInt(v); for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
function concat(...p: Array<ArrayLike<number>>): Uint8Array { const t = p.reduce((n, x) => n + x.length, 0); const o = new Uint8Array(t); let k = 0; for (const x of p) { o.set(Uint8Array.from(x), k); k += x.length; } return o; }
function feed32(hex: string): Uint8Array { const out = new Uint8Array(32); for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
async function injectPrice(feedHex: string, publishTime: number): Promise<Address> {
  const [acct] = await getProgramDerivedAddress({ programAddress: PYTH_PUSH_ORACLE, seeds: [new Uint8Array([0, 0]), feed32(feedHex)] });
  const disc = new Uint8Array(createHash('sha256').update('account:PriceUpdateV2').digest()).slice(0, 8);
  const data = concat(disc, new Uint8Array(32), [1], feed32(feedHex), le(150_000_000n, 8), le(1n, 8), le(0xfffffff8, 4), le(publishTime, 8), le(publishTime, 8), le(150_000_000n, 8), le(1n, 8), le(0n, 8));
  await rpc('surfnet_setAccount', [acct, { lamports: 5_000_000, data: Buffer.from(data).toString('hex'), owner: PYTH_RECEIVER, executable: false, rent_epoch: 0 }]);
  return acct;
}

async function main() {
  const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(here, '.keys', 'deployer.json'), 'utf8'))));
  const client = createClient().use(signer(admin)).use(solanaRpc({ rpcUrl: RPC_URL }));
  const [adminPool] = await findAdminPoolPda({ programAddress: PROGRAM_ID });
  const before = (await fetchAdminPool(client.rpc, adminPool)).data;

  // 1. update a scalar limit (max slippage) and assert it changed, then restore
  const newSlip = before.maxSlippageBps === 500 ? 600 : 500;
  await client.sendTransaction([await getAdminUpdateMaxSlippageBpsInstructionAsync({ admin, newMaxSlippageBps: newSlip })]);
  let now = (await fetchAdminPool(client.rpc, adminPool)).data;
  if (now.maxSlippageBps !== newSlip) throw new Error('max slippage did not update');
  console.log('max slippage', before.maxSlippageBps, '→', now.maxSlippageBps);

  // 2. modify fees (bump creation fee by 1), assert, then restore
  await client.sendTransaction([await getAdminModifyFeeInstructionAsync({
    admin,
    creationFee: before.creationFee + 1n,
    tradingFee: before.tradingFee,
    protocolPerformanceFee: before.protocolPerformanceFee,
    protocolMoneyManagementFee: before.protocolMoneyManagementFee,
    moneyManagementYearlyFeeMax: before.moneyManagementYearlyFeeMax,
    performanceFeeMax: before.performanceFeeMax,
  })]);
  now = (await fetchAdminPool(client.rpc, adminPool)).data;
  if (now.creationFee !== before.creationFee + 1n) throw new Error('creation fee did not update');
  console.log('creation fee', before.creationFee.toString(), '→', now.creationFee.toString());

  // 3. onboard a fresh asset: inject a dummy mint, then create + approve its oracle
  const [dummyMint] = await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [new TextEncoder().encode('e2e-admin-mint')] });
  const mintData = concat(le(1, 4), addrEnc.encode(admin.address), le(0, 8), [6], [1], le(0, 4));
  await rpc('surfnet_setAccount', [dummyMint, { lamports: 2_000_000, data: Buffer.from(concat(mintData, new Uint8Array(82 - mintData.length))).toString('hex'), owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }]);
  const [oraclePool] = await findOraclePoolPda({ adminPool, tokenMint: dummyMint }, { programAddress: PROGRAM_ID });
  const exists = await rpc<{ value: unknown }>('getAccountInfo', [oraclePool, { encoding: 'base64' }]).then((r) => !!r.value).catch(() => false);
  const feed = 'ab'.repeat(32); // 64 hex chars = 32-byte feed id
  const ixs = [];
  if (!exists) ixs.push(await getCreateOraclePoolInstructionAsync({ requester: admin, tokenMint: dummyMint, feedId: `0x${feed}` }));
  ixs.push(await getApproveOraclePoolInstructionAsync({ admin, tokenMint: dummyMint }));
  await client.sendTransaction(ixs);
  const oracle = await fetchOraclePool(client.rpc, oraclePool);
  if (!oracle.data.isApproved) throw new Error('oracle not approved');
  console.log('onboarded oracle for', String(dummyMint).slice(0, 8), '… approved:', oracle.data.isApproved);

  // 4. get_price_info: inject a fresh price for the feed, then log it on-chain (proves the feed is live)
  const nowTs = await rpc<number>('getBlockTime', [await rpc<number>('getSlot', [])]).catch(() => Math.floor(Date.now() / 1000));
  const priceAcct = await injectPrice(feed, nowTs);
  await client.sendTransaction([await getGetPriceInfoInstructionAsync({ payer: admin, priceUpdate: priceAcct, feedId: `0x${feed}` })]);
  console.log('get_price_info succeeded (feed live)');

  // 5. update_oracle_pool: re-point the feed, then close_oracle_pool: retire the asset
  const feed2 = 'cd'.repeat(32);
  await client.sendTransaction([await getUpdateOraclePoolInstructionAsync({ admin, tokenMint: dummyMint, feedId: `0x${feed2}` })]);
  const updated = await fetchOraclePool(client.rpc, oraclePool);
  const storedFeed = new TextDecoder().decode(Uint8Array.from(updated.data.feedId)).replace(/\0+$/, '');
  if (storedFeed !== `0x${feed2}`) throw new Error('feed did not update');
  console.log('feed updated →', storedFeed.slice(0, 10), '…');
  await client.sendTransaction([await getCloseOraclePoolInstructionAsync({ admin, tokenMint: dummyMint })]);
  if ((await fetchMaybeOraclePool(client.rpc, oraclePool)).exists) throw new Error('oracle not closed');
  console.log('oracle closed');

  // restore the values we changed
  await client.sendTransaction([await getAdminUpdateMaxSlippageBpsInstructionAsync({ admin, newMaxSlippageBps: before.maxSlippageBps })]);
  await client.sendTransaction([await getAdminModifyFeeInstructionAsync({
    admin, creationFee: before.creationFee, tradingFee: before.tradingFee,
    protocolPerformanceFee: before.protocolPerformanceFee, protocolMoneyManagementFee: before.protocolMoneyManagementFee,
    moneyManagementYearlyFeeMax: before.moneyManagementYearlyFeeMax, performanceFeeMax: before.performanceFeeMax,
  })]);
  console.log('\n✅ protocol-admin surface (fees, limits, oracle onboarding) works end-to-end');
}

function digLogs(e: unknown, depth = 0): void {
  if (!e || depth > 6) return;
  const a = e as Record<string, unknown>;
  const logs = (a.context as Record<string, unknown>)?.logs ?? a.logs;
  if (Array.isArray(logs)) { console.error('--- logs ---'); for (const l of logs) console.error(l); }
  if (a.cause) digLogs(a.cause, depth + 1);
}
main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); digLogs(e); process.exit(1); });
