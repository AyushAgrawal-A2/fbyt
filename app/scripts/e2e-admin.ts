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
  findAdminPoolPda,
  findOraclePoolPda,
  getAdminModifyFeeInstructionAsync,
  getAdminUpdateMaxSlippageBpsInstructionAsync,
  getCreateOraclePoolInstructionAsync,
  getApproveOraclePoolInstructionAsync,
} from '../src/generated/index.js';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const PROGRAM_ID = address(process.env.NEXT_PUBLIC_FBYT_PROGRAM_ID ?? '3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
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
