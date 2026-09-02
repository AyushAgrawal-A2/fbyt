/**
 * End-to-end manager trade against a running surfnet: fund the vault, clone the bundled jupiter-mock
 * at the Jupiter program id, then send a real `swap` (18 fixed accounts + the 7-account route the mock
 * consumes) as the vault's money manager. Asserts the vault spent input and received output and
 * recorded the trade. Mirrors the Rust `trade_vault` integration.
 *
 *   pnpm localnet -> pnpm bootstrap -> pnpm tsx scripts/e2e-trade.ts <vaultAddress>
 */
import { execSync } from 'node:child_process';
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
import {
  fetchVaultPool,
  fetchAssetRegistry,
  fetchAdminPool,
  findAdminPoolPda,
  findOraclePoolPda,
  findAssetRegistryPda,
  fetchOraclePool,
  fetchMaybeInvestorPool,
  getCreateInvestorPoolInstructionAsync,
  getDepositTokenFundInstructionAsync,
  getSwapInstruction,
  getOraclePoolEncoder,
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
const repoRoot = join(here, '..', '..');

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
function feedId66(hex: string): Uint8Array { const s = new TextEncoder().encode(`0x${hex}`); const out = new Uint8Array(66); out.set(s.slice(0, 66)); return out; }
async function pda(p: Address, seeds: Array<Uint8Array | ReadonlyUint8Array>) { const [a] = await getProgramDerivedAddress({ programAddress: p, seeds }); return a; }
const ata = (owner: Address, mint: Address) => pda(ATA_PROGRAM, [addrEnc.encode(owner), addrEnc.encode(TOKEN_PROGRAM), addrEnc.encode(mint)]);
async function setAccount(pubkey: Address, data: Uint8Array, owner: Address, lamports = 5_000_000) { await rpc('surfnet_setAccount', [pubkey, { lamports, data: Buffer.from(data).toString('hex'), owner, executable: false, rent_epoch: 0 }]); }
async function injectPrice(feed: Uint8Array, priceMicro: bigint, publishTime: number) {
  const [acct] = await getProgramDerivedAddress({ programAddress: PYTH_PUSH_ORACLE, seeds: [new Uint8Array([0, 0]), feed] });
  const disc = new Uint8Array(createHash('sha256').update('account:PriceUpdateV2').digest()).slice(0, 8);
  const data = concat(disc, new Uint8Array(32), [1], feed, le(priceMicro, 8), le(1n, 8), le(0xfffffff8, 4), le(publishTime, 8), le(publishTime, 8), le(priceMicro, 8), le(1n, 8), le(0n, 8));
  await setAccount(acct, data, PYTH_RECEIVER);
  return acct;
}
function injectMint(mint: Address, decimals: number, authority: Address) {
  const d = concat(le(1, 4), addrEnc.encode(authority), le(0, 8), [decimals], [1], le(0, 4));
  return setAccount(mint, concat(d, new Uint8Array(82 - d.length)), TOKEN_PROGRAM, 2_000_000);
}

async function main() {
  if (!VAULT) throw new Error('usage: tsx scripts/e2e-trade.ts <vaultAddress>');
  const manager = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(here, '.keys', 'manager.json'), 'utf8'))));
  const client = createClient().use(signer(manager)).use(solanaRpc({ rpcUrl: RPC_URL }));

  const vault = await fetchVaultPool(client.rpc, VAULT);
  const d = vault.data;
  const [adminPoolAddr] = await findAdminPoolPda({ programAddress: PROGRAM_ID });
  const admin = await fetchAdminPool(client.rpc, adminPoolAddr);
  const [baseOracle] = await findOraclePoolPda({ adminPool: d.adminPool, tokenMint: d.tokenMint }, { programAddress: PROGRAM_ID });
  const baseFeed = feed32((await fetchOraclePool(client.rpc, baseOracle)).data.feedId);
  const [assetRegistry] = await findAssetRegistryPda({ vaultPool: VAULT }, { programAddress: PROGRAM_ID });

  // 1. fund the vault: manager deposits 100 base (raise window is open pre-fundraise-end)
  await rpc('surfnet_setTokenAccount', [manager.address, d.tokenMint, { amount: 1_000_000_000 }]);
  const managerBaseAta = await ata(manager.address, d.tokenMint);
  const basePrice = await pda(PYTH_PUSH_ORACLE, [new Uint8Array([0, 0]), baseFeed]);
  const [managerInvestorPool] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode('InvestorPool'), addrEnc.encode(manager.address), addrEnc.encode(d.adminPool), addrEnc.encode(VAULT), addrEnc.encode(d.tokenMint)],
  });
  const hasInvestorPool = (await fetchMaybeInvestorPool(client.rpc, managerInvestorPool)).exists;
  const depositIxs = [];
  if (!hasInvestorPool) depositIxs.push(await getCreateInvestorPoolInstructionAsync({ investor: manager, vaultPool: VAULT, tokenMint: d.tokenMint }));
  depositIxs.push(await getDepositTokenFundInstructionAsync({ investor: manager, vaultPool: VAULT, oraclePool: baseOracle, fromAccount: managerBaseAta, tokenMint: d.tokenMint, priceUpdate: basePrice, tokenProgram: TOKEN_PROGRAM, amount: 100_000_000n }));
  await client.sendTransaction(depositIxs);

  // 2. clone the jupiter-mock at the Jupiter program id
  const tmpKp = join(here, '.keys', 'jupmock.json');
  execSync(`solana-keygen new --no-bip39-passphrase --silent --force -o ${tmpKp}`, { stdio: 'ignore' });
  const tmpId = execSync(`solana-keygen pubkey ${tmpKp}`).toString().trim();
  const deployerPath = join(here, '.keys', 'deployer.json');
  execSync(`solana program deploy ${repoRoot}/programs/fbyt_vault/tests/jupiter-mock/target/deploy/jupiter_mock.so --program-id ${tmpKp} --keypair ${deployerPath} --url ${RPC_URL} --commitment confirmed`, { stdio: 'ignore' });
  await rpc('surfnet_cloneProgramAccount', [tmpId, String(JUPITER)]);

  // 3. output side: mint + approved oracle + counterparty accounts
  const outMint = await pda(PROGRAM_ID, [new TextEncoder().encode('demo-out-mint')]);
  await injectMint(outMint, 6, admin.data.admin);
  const [outOracle, outOracleBump] = await findOraclePoolPda({ adminPool: d.adminPool, tokenMint: outMint }, { programAddress: PROGRAM_ID });
  await setAccount(outOracle, new Uint8Array(getOraclePoolEncoder().encode({ bump: outOracleBump, adminPool: d.adminPool, tokenMint: outMint, feedId: feedId66(OUT_FEED), isApproved: true, padding: Array(8).fill(0n), reserved: new Uint8Array(4) })), PROGRAM_ID);
  const poolPda = await pda(JUPITER, [new TextEncoder().encode('pool')]);
  const vaultInput = await ata(VAULT, d.tokenMint);
  const vaultOutput = await ata(VAULT, outMint);
  const inputSink = await ata(manager.address, d.tokenMint); // counterparty sink (any owned account)
  const outputSource = await ata(poolPda, outMint);
  await rpc('surfnet_setTokenAccount', [VAULT, outMint, { amount: 0 }]);
  await rpc('surfnet_setTokenAccount', [poolPda, outMint, { amount: 30_000_000 }]);

  // 4. time-travel past the fundraise end; refresh both prices to "now"
  const now = Number(d.createdAt + d.raisePeriod) + 60;
  await rpc('surfnet_timeTravel', [{ absoluteTimestamp: now * 1000 }]);
  await injectPrice(baseFeed, 150_000_000n, now);
  const outPrice = await injectPrice(feed32hex(OUT_FEED), 100_000_000n, now);

  // 5. build + send the swap as the manager. route data = [input_amount, output_amount] LE
  const routeData = concat(le(10_000_000n, 8), le(15_000_000n, 8));
  const base = getSwapInstruction({
    adminPool: d.adminPool, admin: admin.data.admin, trader: manager, tokenMint: d.tokenMint, vaultPool: VAULT,
    assetRegistry, inputMint: d.tokenMint, inputMintProgram: TOKEN_PROGRAM, outputMint: outMint, outputMintProgram: TOKEN_PROGRAM,
    vaultInputTokenAccount: vaultInput, vaultOutputTokenAccount: vaultOutput, oraclePoolFrom: baseOracle, oraclePoolTo: outOracle,
    inputPriceUpdate: basePrice, outputPriceUpdate: outPrice, jupiterProgram: JUPITER, systemProgram: SYSTEM, data: routeData,
  });
  const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });
  const w = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });
  const route = [ro(TOKEN_PROGRAM), w(vaultInput), w(inputSink), w(outputSource), w(vaultOutput), ro(VAULT), ro(poolPda)];

  const inBefore = BigInt((await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [vaultInput])).value.amount);
  console.log('trading…');
  const res = await client.sendTransaction([{ programAddress: base.programAddress, accounts: [...base.accounts, ...route] as AccountMeta[], data: base.data }]);
  console.log('signature', String(res.context.signature));

  const inAfter = BigInt((await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [vaultInput])).value.amount);
  const outAfter = BigInt((await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [vaultOutput])).value.amount);
  const reg = await fetchAssetRegistry(client.rpc, assetRegistry);
  const vaultAfter = await fetchVaultPool(client.rpc, VAULT);
  console.log('vault input', inBefore.toString(), '→', inAfter.toString());
  console.log('vault output 0 →', outAfter.toString());
  console.log('registry assets:', reg.data.assetMints.length);
  console.log('last_trade_at set:', vaultAfter.data.lastTradeAt !== d.lastTradeAt);
  if (inAfter >= inBefore || outAfter <= 0n) throw new Error('swap did not move funds');
  console.log('\n✅ trade flow works end-to-end');
}

function digLogs(e: unknown, depth = 0): void {
  if (!e || depth > 6) return;
  const any = e as Record<string, unknown>;
  const logs = (any.context as Record<string, unknown>)?.logs ?? any.logs;
  if (Array.isArray(logs)) {
    console.error('--- program logs ---');
    for (const l of logs) console.error(l);
  }
  if (any.cause) digLogs(any.cause, depth + 1);
}
main().catch((e) => {
  console.error('❌', (e as Error)?.message);
  digLogs(e);
  process.exit(1);
});
