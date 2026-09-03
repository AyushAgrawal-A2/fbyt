/**
 * End-to-end REAL Jupiter swap against a running mainnet-fork surfnet (no mock). Deploys the program,
 * onboards real-asset oracles (wSOL + USDC via their real Pyth feeds), creates a wSOL-base vault,
 * funds + deposits, advances past the (short) fundraise, then trades wSOL -> USDC through real Jupiter:
 * quote -> swap-instructions -> adapt -> the on-chain `swap` CPIs into Jupiter, signed by the vault PDA.
 *
 *   pnpm localnet (fresh)  ->  pnpm tsx scripts/e2e-jupiter-real.ts
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  address, createClient, createKeyPairSignerFromBytes, getAddressEncoder, getProgramDerivedAddress,
  AccountRole, type Address, type AccountMeta, type Instruction, type ReadonlyUint8Array,
} from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import {
  findAdminPoolPda, findOraclePoolPda, findAssetRegistryPda,
  fetchMaybeAdminPool, fetchMaybeOraclePool, fetchMaybeVaultPool, fetchMaybeMoneyManagerPool, fetchMaybeInvestorPool,
  getCreateAdminPoolInstruction, getCreateOraclePoolInstructionAsync, getApproveOraclePoolInstructionAsync,
  getCreateMoneyManagerPoolInstructionAsync, getCreateVaultInstructionAsync,
  getCreateInvestorPoolInstructionAsync, getDepositTokenFundInstructionAsync, getSwapInstruction,
} from '../src/generated/index.js';

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const PROGRAM_ID = address('3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y');
const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM = address('11111111111111111111111111111111');
const ATA = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const BPF = address('BPFLoaderUpgradeab1e11111111111111111111111');
const PYTH = address('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
const JUPITER = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const WSOL = address('So11111111111111111111111111111111111111112');
const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const USDC_FEED = 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const addrEnc = getAddressEncoder();

let id = 0;
async function rpc<T>(m: string, p: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: m, params: p }) });
  const j = await r.json(); if (j.error) throw new Error(`${m}: ${JSON.stringify(j.error)}`); return j.result as T;
}
async function pda(prog: Address, seeds: Array<Uint8Array | ReadonlyUint8Array>) { const [a] = await getProgramDerivedAddress({ programAddress: prog, seeds }); return a; }
const ata = (o: Address, m: Address) => pda(ATA, [addrEnc.encode(o), addrEnc.encode(TOKEN), addrEnc.encode(m)]);
const priceAcct = (feedHex: string) => { const f = new Uint8Array(32); for (let i = 0; i < 32; i++) f[i] = parseInt(feedHex.slice(i * 2, i * 2 + 2), 16); return pda(PYTH, [new Uint8Array([0, 0]), f]); };
const bal = async (a: Address) => { const r = await rpc<{ value: { amount: string } | null }>('getTokenAccountBalance', [a]).catch(() => null); return r?.value ? BigInt(r.value.amount) : 0n; };
const b64ToBytes = (b: string) => Uint8Array.from(Buffer.from(b, 'base64'));
function roleOf(s: boolean, w: boolean): AccountRole { return s && w ? AccountRole.WRITABLE_SIGNER : s ? AccountRole.READONLY_SIGNER : w ? AccountRole.WRITABLE : AccountRole.READONLY; }

async function main() {
  const keysDir = join(here, '.keys'); if (!existsSync(keysDir)) mkdirSync(keysDir, { recursive: true });
  const dep = join(keysDir, 'deployer.json'); const mgr = join(keysDir, 'manager.json');
  for (const k of [dep, mgr]) if (!existsSync(k)) execSync(`solana-keygen new --no-bip39-passphrase --silent -o ${k}`, { stdio: 'ignore' });
  const deployer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(dep, 'utf8'))));
  const manager = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(mgr, 'utf8'))));
  const adminC = createClient().use(signer(deployer)).use(solanaRpc({ rpcUrl: RPC }));
  const mgrC = createClient().use(signer(manager)).use(solanaRpc({ rpcUrl: RPC }));
  await rpc('surfnet_setAccount', [deployer.address, { lamports: 100_000_000_000 }]);
  await rpc('surfnet_setAccount', [manager.address, { lamports: 10_000_000_000 }]);

  // 1. deploy the program (deployer = upgrade authority)
  const ex = await rpc<{ value: { executable: boolean } | null }>('getAccountInfo', [PROGRAM_ID, { encoding: 'base64' }]);
  if (!ex?.value?.executable) {
    console.log('deploying program…');
    execSync(`solana program deploy ${repoRoot}/target/deploy/fbyt_vault.so --program-id ${repoRoot}/target/deploy/fbyt_vault-keypair.json --keypair ${dep} --url ${RPC} --commitment confirmed`, { stdio: 'ignore' });
  }
  const [adminPool] = await findAdminPoolPda({ programAddress: PROGRAM_ID });
  if (!(await fetchMaybeAdminPool(adminC.rpc, adminPool)).exists) {
    const [programData] = await getProgramDerivedAddress({ programAddress: BPF, seeds: [addrEnc.encode(PROGRAM_ID)] });
    console.log('create_admin_pool…');
    await adminC.sendTransaction([getCreateAdminPoolInstruction({
      admin: deployer, operator: deployer.address, program: PROGRAM_ID, programData, adminPool,
      creationFee: 0n, protocolPerformanceFee: 2000, protocolMoneyManagementFee: 2000, tradingFee: 0n,
      moneyManagementYearlyFeeMax: 1500, performanceFeeMax: 2000, withdrawCooldownMax: 3_888_000n, fundrisingPeriodMax: 2_592_000n,
      raiseAmountMinUsd: 10_000n, contributionAmountMinUsd: 10_000n, oracleMaxAge: 259_200n, idlePeriod: 7_776_000n,
      dustThresholdUsd: 10_000n, maxAssetCount: 30, maxSlippageBps: 2000, // 20% to absorb real price impact + oracle vs market
    })]);
  }

  // 2. onboard real-asset oracles (wSOL + USDC) with their real Pyth feeds
  for (const [mint, feed] of [[WSOL, SOL_FEED], [USDC, USDC_FEED]] as const) {
    const [op] = await findOraclePoolPda({ adminPool, tokenMint: mint }, { programAddress: PROGRAM_ID });
    const cur = await fetchMaybeOraclePool(adminC.rpc, op);
    if (!cur.exists) await adminC.sendTransaction([await getCreateOraclePoolInstructionAsync({ requester: deployer, tokenMint: mint, feedId: `0x${feed}` })]);
    if (!cur.exists || !cur.data.isApproved) await adminC.sendTransaction([await getApproveOraclePoolInstructionAsync({ admin: deployer, tokenMint: mint })]);
  }
  console.log('oracles onboarded (wSOL + USDC, real Pyth)');

  // 3. create a wSOL-base vault (short raise so we can trade quickly while prices stay fresh)
  const adminAcc = await fetchMaybeAdminPool(adminC.rpc, adminPool); if (!adminAcc.exists) throw new Error('admin pool missing'); const admin = adminAcc.data;
  const [vault] = await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [new TextEncoder().encode('VaultPool'), addrEnc.encode(adminPool), addrEnc.encode(manager.address), new Uint8Array(8)] });
  const [assetRegistry] = await findAssetRegistryPda({ vaultPool: vault }, { programAddress: PROGRAM_ID });
  const [wsolOracle] = await findOraclePoolPda({ adminPool, tokenMint: WSOL }, { programAddress: PROGRAM_ID });
  const [usdcOracle] = await findOraclePoolPda({ adminPool, tokenMint: USDC }, { programAddress: PROGRAM_ID });
  const wsolPrice = await priceAcct(SOL_FEED); const usdcPrice = await priceAcct(USDC_FEED);
  if (!(await fetchMaybeVaultPool(adminC.rpc, vault)).exists) {
    const [mmPool] = await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [new TextEncoder().encode('MoneyManagerPool'), addrEnc.encode(adminPool), addrEnc.encode(manager.address)] });
    const ixs = [];
    if (!(await fetchMaybeMoneyManagerPool(mgrC.rpc, mmPool)).exists) ixs.push(await getCreateMoneyManagerPoolInstructionAsync({ moneyManager: manager }));
    ixs.push(await getCreateVaultInstructionAsync({
      admin: admin.admin, moneyManager: manager, vaultPool: vault, assetRegistry, oraclePool: wsolOracle, priceUpdate: wsolPrice, tokenMint: WSOL,
      minContributeAmount: 10_000n, raisePeriod: 120n, minRaiseAmount: 10_000n, mmWithdrawPeriod: 604_800n, withdrawCooldown: 3_888_000n,
      moneyManagementFee: 1000, performanceFee: 1500, isOpenEnded: false,
    }));
    console.log('create_vault (wSOL base)…');
    await mgrC.sendTransaction(ixs);
  }
  const vAcc = await fetchMaybeVaultPool(adminC.rpc, vault); if (!vAcc.exists) throw new Error('vault missing'); const d = vAcc.data;

  // 4. fund an investor with wSOL and deposit (raises the amount + funds the vault ATA)
  await rpc('surfnet_setTokenAccount', [manager.address, WSOL, { amount: 2_000_000_000 }]); // 2 wSOL
  const mgrWsol = await ata(manager.address, WSOL);
  const [investorPool] = await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [new TextEncoder().encode('InvestorPool'), addrEnc.encode(manager.address), addrEnc.encode(adminPool), addrEnc.encode(vault), addrEnc.encode(WSOL)] });
  const depIxs: Instruction[] = [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: manager, owner: vault, mint: WSOL })];
  if (!(await fetchMaybeInvestorPool(mgrC.rpc, investorPool)).exists) depIxs.push(await getCreateInvestorPoolInstructionAsync({ investor: manager, vaultPool: vault, tokenMint: WSOL }));
  depIxs.push(await getDepositTokenFundInstructionAsync({ investor: manager, vaultPool: vault, oraclePool: wsolOracle, fromAccount: mgrWsol, tokenMint: WSOL, priceUpdate: wsolPrice, tokenProgram: TOKEN, amount: 1_000_000_000n }));
  console.log('depositing 1 wSOL…');
  await mgrC.sendTransaction(depIxs);
  const vaultWsol = await ata(vault, WSOL);
  console.log('vault wSOL balance:', (await bal(vaultWsol)).toString());

  // 5. advance just past the 120s raise (prices stay fresh within oracle_max_age)
  const when = Number(d.createdAt + 120n) + 5;
  await rpc('surfnet_timeTravel', [{ absoluteTimestamp: when * 1000 }]);

  // 6. REAL Jupiter: quote wSOL -> USDC, get swap-instructions with the vault PDA as the user, adapt
  const inAmount = 500_000_000n; // 0.5 wSOL
  // high Jupiter slippage absorbs the fork-vs-live pool difference (the quote reflects live mainnet
  // state, execution runs against the frozen fork); the fbyt program's own oracle check still enforces
  // that the realized trade is fair (within admin max_slippage_bps).
  const dexes = process.env.JUP_DEXES ?? 'Whirlpool';
  const quote = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${WSOL}&outputMint=${USDC}&amount=${inAmount}&slippageBps=5000&onlyDirectRoutes=true&dexes=${encodeURIComponent(dexes)}`)).json();
  console.log('jupiter quote out:', quote.outAmount, 'priceImpact:', quote.priceImpactPct);
  const six = await (await fetch('https://lite-api.jup.ag/swap/v1/swap-instructions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: String(vault), wrapAndUnwrapSol: false, useSharedAccounts: true }),
  })).json();
  if (!six.swapInstruction) throw new Error('no swapInstruction: ' + JSON.stringify(six).slice(0, 300));
  const jix = six.swapInstruction as { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
  const routeData = b64ToBytes(jix.data);
  const remaining: AccountMeta[] = jix.accounts.map((a) => ({ address: a.pubkey as Address, role: roleOf(a.pubkey === String(vault) ? false : a.isSigner, a.isWritable) }));
  console.log('jupiter route: program', jix.programId, 'accounts', remaining.length);

  // 7. build the fbyt swap with the real route + send (signed by the manager)
  const vaultUsdc = await ata(vault, USDC);
  const base = getSwapInstruction({
    adminPool, admin: admin.admin, trader: manager, tokenMint: WSOL, vaultPool: vault, assetRegistry,
    inputMint: WSOL, inputMintProgram: TOKEN, outputMint: USDC, outputMintProgram: TOKEN,
    vaultInputTokenAccount: vaultWsol, vaultOutputTokenAccount: vaultUsdc, oraclePoolFrom: wsolOracle, oraclePoolTo: usdcOracle,
    inputPriceUpdate: wsolPrice, outputPriceUpdate: usdcPrice, jupiterProgram: JUPITER, systemProgram: SYSTEM, data: routeData,
  });
  const createUsdc = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: manager, owner: vault, mint: USDC });
  const usdcBefore = await bal(vaultUsdc);
  console.log('sending real Jupiter swap…');
  const res = await mgrC.sendTransaction([createUsdc, { programAddress: base.programAddress, accounts: [...base.accounts, ...remaining] as AccountMeta[], data: base.data }]);
  console.log('signature', String(res.context.signature));
  const usdcAfter = await bal(vaultUsdc); const wsolAfter = await bal(vaultWsol);
  console.log('vault USDC', usdcBefore.toString(), '->', usdcAfter.toString());
  console.log('vault wSOL', '->', wsolAfter.toString());
  if (usdcAfter <= usdcBefore) throw new Error('no USDC received');
  console.log('\n✅ REAL Jupiter swap works end-to-end (wSOL -> USDC through the on-chain swap CPI)');
}

function digLogs(e: unknown, depth = 0): void {
  if (!e || depth > 6) return; const a = e as Record<string, unknown>;
  const logs = (a.context as Record<string, unknown>)?.logs ?? a.logs;
  if (Array.isArray(logs)) { console.error('--- logs ---'); for (const l of logs) console.error(l); }
  if (a.cause) digLogs(a.cause, depth + 1);
}
main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); digLogs(e); process.exit(1); });
