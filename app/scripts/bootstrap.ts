/**
 * Seed a running local surfnet with a demo FBYT environment.
 *
 *   terminal 1:  pnpm localnet     # surfpool start  (forks mainnet, RPC on 127.0.0.1:8899)
 *   terminal 2:  pnpm bootstrap
 *
 * It deploys the reconstructed program, then injects — deterministically, via surfnet cheatcodes and
 * the Codama-generated account encoders — an admin pool, a demo base mint, an approved oracle, a fresh
 * Pyth price account, a money-manager pool, and one demo vault. The app then reads this state, and the
 * deposit flow sends real `deposit_token_fund` transactions against it. Fund a browser wallet with demo
 * tokens through POST /api/faucet.
 *
 * This is the local-run path; it is not exercised in CI.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Address,
} from '@solana/kit';
import {
  getAdminPoolEncoder,
  getOraclePoolEncoder,
  getMoneyManagerPoolEncoder,
  getVaultPoolEncoder,
  getAssetRegistryEncoder,
  findAdminPoolPda,
  findOraclePoolPda,
  findMoneyManagerPoolPda,
  findAssetRegistryPda,
} from '../src/generated/index.js';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const PROGRAM_ID = address(
  process.env.NEXT_PUBLIC_FBYT_PROGRAM_ID ?? '3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y',
);
const PYTH_RECEIVER = address('rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp');
const PYTH_PUSH_ORACLE = address('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const BPF_LOADER_UPGRADEABLE = address('BPFLoaderUpgradeab1e11111111111111111111111');
// Base-token Pyth feed for the demo vault (an arbitrary 32-byte id — the injected price uses it too).
const DEMO_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const BASE_TIME = 1_900_000_000; // a fixed "now" we time-travel the clock to
const addrEnc = getAddressEncoder();
const u64Enc = getU64Encoder();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

let rpcId = 0;
async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result as T;
}

function acctDisc(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`account:${name}`).digest()).slice(0, 8);
}
function bytes(...parts: Array<ArrayLike<number>>): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(Uint8Array.from(p), o);
    o += p.length;
  }
  return out;
}
const le = (v: number | bigint, n: number) => {
  const out = new Uint8Array(n);
  let x = BigInt(v);
  for (let i = 0; i < n; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};
async function setAccount(pubkey: Address, data: Uint8Array, owner: Address, lamports = 5_000_000) {
  await rpc('surfnet_setAccount', [
    pubkey,
    { lamports, data: Array.from(data), owner, executable: false, rent_epoch: 0 },
  ]);
}
function feed32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function feedId66(hex: string): Uint8Array {
  const s = new TextEncoder().encode(`0x${hex}`);
  const out = new Uint8Array(66);
  out.set(s.slice(0, 66));
  return out;
}

async function main() {
  // 0. deployer keypair + funding
  const keysDir = join(here, '.keys');
  if (!existsSync(keysDir)) mkdirSync(keysDir, { recursive: true });
  const deployerPath = join(keysDir, 'deployer.json');
  if (!existsSync(deployerPath)) {
    execSync(`solana-keygen new --no-bip39-passphrase --silent -o ${deployerPath}`, { stdio: 'ignore' });
  }
  const deployer = execSync(`solana-keygen pubkey ${deployerPath}`).toString().trim() as Address;
  await rpc('surfnet_setAccount', [deployer, { lamports: 100_000_000_000 }]);

  // 1. deploy the reconstructed program
  console.log('deploying program…');
  execSync(
    `solana program deploy ${repoRoot}/target/deploy/fbyt_vault.so ` +
      `--program-id ${repoRoot}/target/deploy/fbyt_vault-keypair.json ` +
      `--keypair ${deployerPath} --url ${RPC_URL} --commitment confirmed`,
    { stdio: 'inherit' },
  );

  // fixed demo actor pubkeys (no signing needed — everything is injected)
  const admin = deployer;
  const operator = deployer;
  const moneyManager = address('4Nd1mDMkBQ2fJctxxu5xgQXcv7uxDvsWtUxu5b8bYh4z'); // arbitrary demo manager

  // 2. admin pool (matches the deployed protocol config)
  const [adminPool, adminBump] = await findAdminPoolPda({ programAddress: PROGRAM_ID });
  const adminData = getAdminPoolEncoder().encode({
    bump: adminBump,
    admin,
    pendingAdmin: address('11111111111111111111111111111111'),
    operator,
    vaultPoolCount: 1n,
    creationFee: 2_000_000n,
    protocolPerformanceFee: 2000,
    protocolMoneyManagementFee: 2000,
    moneyManagementYearlyFeeMax: 1500,
    performanceFeeMax: 2000,
    tradingFee: 1_000_000n,
    withdrawCooldownMax: 3_888_000n,
    fundrisingPeriodMax: 2_592_000n,
    raiseAmountMinUsd: 10_000n,
    contributionAmountMinUsd: 10_000n,
    oracleMaxAge: 259_200n,
    idlePeriod: 7_776_000n,
    dustThresholdUsd: 10_000n,
    maxAssetCount: 30,
    maxSlippageBps: 1000,
    padding: new Uint8Array(62),
  });
  await setAccount(adminPool, new Uint8Array(adminData), PROGRAM_ID);

  // 3. demo base mint (SPL Mint, 6 decimals)
  const mint = address('D3mSMintFbyt1111111111111111111111111111111');
  const mintData = bytes(
    le(1, 4), // mint_authority: Some
    addrEnc.encode(admin),
    le(0, 8), // supply
    [6], // decimals
    [1], // is_initialized
    le(0, 4), // freeze_authority: None
  );
  await setAccount(mint, bytes(mintData, new Uint8Array(82 - mintData.length)), TOKEN_PROGRAM, 2_000_000);

  // 4. approved oracle for the demo mint
  const [oraclePool, oracleBump] = await findOraclePoolPda(
    { adminPool, tokenMint: mint },
    { programAddress: PROGRAM_ID },
  );
  const oracleData = getOraclePoolEncoder().encode({
    bump: oracleBump,
    adminPool,
    tokenMint: mint,
    feedId: feedId66(DEMO_FEED),
    isApproved: true,
    padding: Array(8).fill(0n),
    reserved: new Uint8Array(4),
  });
  await setAccount(oraclePool, new Uint8Array(oracleData), PROGRAM_ID);

  // 5. fresh Pyth PriceUpdateV2 at the canonical sponsored-feed address ($1.50, expo -8)
  const [priceAcct] = await getProgramDerivedAddress({
    programAddress: PYTH_PUSH_ORACLE,
    seeds: [new Uint8Array([0, 0]), feed32(DEMO_FEED)],
  });
  const price = 150_000_000n;
  const priceData = bytes(
    acctDisc('PriceUpdateV2'),
    new Uint8Array(32), // write_authority
    [1], // verification_level = Full
    feed32(DEMO_FEED),
    le(price, 8),
    le(1n, 8), // conf
    le(0xfffffff8, 4), // exponent -8 as i32 LE
    le(BASE_TIME, 8),
    le(BASE_TIME, 8),
    le(price, 8),
    le(1n, 8),
    le(0n, 8),
  );
  await setAccount(priceAcct, priceData, PYTH_RECEIVER);

  // 6. money-manager pool
  const [mmPool, mmBump] = await findMoneyManagerPoolPda(
    { adminPool, moneyManager },
    { programAddress: PROGRAM_ID },
  );
  const mmData = getMoneyManagerPoolEncoder().encode({
    bump: mmBump,
    moneyManager,
    adminPool,
    vaultsAmount: 1n,
    padding: Array(8).fill(0n),
  });
  await setAccount(mmPool, new Uint8Array(mmData), PROGRAM_ID);

  // 7. demo vault (index 0) + its (empty) asset registry
  const [vaultPool] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      new TextEncoder().encode('VaultPool'),
      addrEnc.encode(adminPool),
      addrEnc.encode(moneyManager),
      u64Enc.encode(0n),
    ],
  });
  const [assetRegistry, regBump] = await findAssetRegistryPda(
    { vaultPool },
    { programAddress: PROGRAM_ID },
  );
  const [, vaultBump] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      new TextEncoder().encode('VaultPool'),
      addrEnc.encode(adminPool),
      addrEnc.encode(moneyManager),
      u64Enc.encode(0n),
    ],
  });
  const vaultData = getVaultPoolEncoder().encode({
    bump: vaultBump,
    index: 0n,
    adminPool,
    moneyManager,
    tokenMint: mint,
    assetRegistry,
    vaultPoolStatus: 1, // Active
    investorCount: 0n,
    raisedAmountUsd: 0n,
    totalShares: 0n,
    minContributeAmountUsd: 10_000n,
    raisePeriod: 2_592_000n,
    minRaiseAmountUsd: 10_000n,
    mmWithdrawPeriod: 604_800n,
    withdrawCooldown: 3_888_000n,
    createdAt: BigInt(BASE_TIME),
    updatedAt: BigInt(BASE_TIME),
    lastTradeAt: BigInt(BASE_TIME),
    lastMmFeeWithdrawAt: BigInt(BASE_TIME + 2_592_000),
    moneyManagementYearlyFee: 1000,
    performanceFee: 1500,
    isOpenEnded: true,
    padding1: new Uint8Array(7),
    tradingDelegate: address('11111111111111111111111111111111'),
    padding: Array(11).fill(0n),
  });
  await setAccount(vaultPool, new Uint8Array(vaultData), PROGRAM_ID, 5_000_000);

  const regData = getAssetRegistryEncoder().encode({
    bump: regBump,
    vaultPool,
    assetMints: [],
    padding: Array(8).fill(0n),
  });
  await setAccount(assetRegistry, new Uint8Array(regData), PROGRAM_ID);

  // the vault's base ATA (owned by the vault PDA), empty
  const [vaultAta] = await getProgramDerivedAddress({
    programAddress: address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    seeds: [addrEnc.encode(vaultPool), addrEnc.encode(TOKEN_PROGRAM), addrEnc.encode(mint)],
  });
  await rpc('surfnet_setTokenAccount', [vaultPool, mint, { amount: 0 }]).catch(() => {});

  // 8. put the clock inside the raise window so deposits are accepted
  await rpc('surfnet_timeTravel', [{ absolute_timestamp: BASE_TIME + 1000 }]).catch(() =>
    rpc('surfnet_timeTravel', [{ unix_timestamp: BASE_TIME + 1000 }]).catch(() => {}),
  );

  console.log('\nbootstrap complete:');
  console.log('  admin pool   ', adminPool);
  console.log('  demo mint    ', mint);
  console.log('  oracle pool  ', oraclePool);
  console.log('  price account', priceAcct);
  console.log('  demo vault   ', vaultPool);
  console.log('  vault ATA    ', vaultAta);
  console.log('\nFund a wallet with demo tokens:  POST /api/faucet { address, mint }');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
