/**
 * Seed a running local surfnet with a demo FBYT environment — through the program's own instructions,
 * not by faking its accounts.
 *
 *   terminal 1:  pnpm localnet     # surfpool start  (forks mainnet, RPC on 127.0.0.1:8899)
 *   terminal 2:  pnpm bootstrap
 *
 * It deploys the reconstructed program, then drives the real onboarding chain: create_admin_pool (the
 * deployer is the program's upgrade authority), create_oracle_pool + approve_oracle_pool for the base
 * and demo-output assets, and create_money_manager_pool + create_vault for a demo vault. Cheatcodes are
 * used only for genuinely external state a fork can't mint: the demo SPL mints, the Pyth price accounts,
 * the jupiter-mock program cloned at the Jupiter id, and its counterparty liquidity.
 *
 * This is the local-run path; it is not exercised in CI.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  address,
  createClient,
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type TransactionSigner,
} from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import {
  findAdminPoolPda,
  findOraclePoolPda,
  findAssetRegistryPda,
  fetchMaybeAdminPool,
  fetchMaybeOraclePool,
  fetchMaybeMoneyManagerPool,
  fetchMaybeVaultPool,
  getCreateAdminPoolInstruction,
  getCreateOraclePoolInstructionAsync,
  getApproveOraclePoolInstructionAsync,
  getCreateMoneyManagerPoolInstructionAsync,
  getCreateVaultInstructionAsync,
} from '../src/generated/index.js';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const PROGRAM_ID = address(
  process.env.NEXT_PUBLIC_FBYT_PROGRAM_ID ?? '3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y',
);
const PYTH_RECEIVER = address('rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp');
const PYTH_PUSH_ORACLE = address('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const BPF_LOADER_UPGRADEABLE = address('BPFLoaderUpgradeab1e11111111111111111111111');
const JUPITER = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
// Pyth feed ids for the demo assets (arbitrary 32-byte ids — the injected mock prices use them too).
const DEMO_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const DEMO_OUT_MINT_SEED = 'demo-out-mint';
const DEMO_OUT_FEED = '2222222222222222222222222222222222222222222222222222222222222222';
const JUPITER_POOL_SEED = 'pool';
const addrEnc = getAddressEncoder();

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
    { lamports, data: Buffer.from(data).toString('hex'), owner, executable: false, rent_epoch: 0 },
  ]);
}
function feed32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
/** Inject an external SPL Mint account (a third-party token a fork can't mint locally). */
async function injectMint(mint: Address, decimals: number, authority: Address) {
  const d = bytes(le(1, 4), addrEnc.encode(authority), le(0, 8), [decimals], [1], le(0, 4));
  await setAccount(mint, bytes(d, new Uint8Array(82 - d.length)), TOKEN_PROGRAM, 2_000_000);
}
/** Inject a fresh Pyth PriceUpdateV2 ($price at expo -8) at the canonical account for `feedHex`. */
async function injectPrice(feedHex: string, priceMicro: bigint, publishTime: number): Promise<Address> {
  const [acct] = await getProgramDerivedAddress({
    programAddress: PYTH_PUSH_ORACLE,
    seeds: [new Uint8Array([0, 0]), feed32(feedHex)],
  });
  const data = bytes(
    acctDisc('PriceUpdateV2'),
    new Uint8Array(32),
    [1],
    feed32(feedHex),
    le(priceMicro, 8),
    le(1n, 8),
    le(0xfffffff8, 4),
    le(publishTime, 8),
    le(publishTime, 8),
    le(priceMicro, 8),
    le(1n, 8),
    le(0n, 8),
  );
  await setAccount(acct, data, PYTH_RECEIVER);
  return acct;
}

function loadSigner(path: string): Promise<TransactionSigner> {
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

async function main() {
  // 0. keypairs + funding. The deployer becomes the program upgrade authority, protocol admin and
  //    operator; the money manager runs the demo vault. Both are saved so the e2e scripts can sign.
  const keysDir = join(here, '.keys');
  if (!existsSync(keysDir)) mkdirSync(keysDir, { recursive: true });
  const deployerPath = join(keysDir, 'deployer.json');
  if (!existsSync(deployerPath)) execSync(`solana-keygen new --no-bip39-passphrase --silent -o ${deployerPath}`, { stdio: 'ignore' });
  const managerPath = join(keysDir, 'manager.json');
  if (!existsSync(managerPath)) execSync(`solana-keygen new --no-bip39-passphrase --silent -o ${managerPath}`, { stdio: 'ignore' });
  const deployerAddr = execSync(`solana-keygen pubkey ${deployerPath}`).toString().trim() as Address;
  const managerAddr = execSync(`solana-keygen pubkey ${managerPath}`).toString().trim() as Address;
  await rpc('surfnet_setAccount', [deployerAddr, { lamports: 100_000_000_000 }]);
  await rpc('surfnet_setAccount', [managerAddr, { lamports: 10_000_000_000 }]);

  // 1. deploy the reconstructed program (skip if already on the surfnet)
  const existing = await rpc<{ value: { executable: boolean } | null }>('getAccountInfo', [PROGRAM_ID, { encoding: 'base64' }]);
  if (existing?.value?.executable) {
    console.log('program already deployed, skipping');
  } else {
    console.log('deploying program…');
    execSync(
      `solana program deploy ${repoRoot}/target/deploy/fbyt_vault.so ` +
        `--program-id ${repoRoot}/target/deploy/fbyt_vault-keypair.json ` +
        `--keypair ${deployerPath} --url ${RPC_URL} --commitment confirmed`,
      { stdio: 'inherit' },
    );
  }

  const deployer = await loadSigner(deployerPath);
  const manager = await loadSigner(managerPath);
  const adminClient = createClient().use(signer(deployer)).use(solanaRpc({ rpcUrl: RPC_URL }));
  const managerClient = createClient().use(signer(manager)).use(solanaRpc({ rpcUrl: RPC_URL }));
  const [adminPool] = await findAdminPoolPda({ programAddress: PROGRAM_ID });

  // 2. create_admin_pool — the deployer (upgrade authority) sets the protocol config through the program
  if ((await fetchMaybeAdminPool(adminClient.rpc, adminPool)).exists) {
    console.log('admin pool exists, skipping create_admin_pool');
  } else {
    const [programData] = await getProgramDerivedAddress({ programAddress: BPF_LOADER_UPGRADEABLE, seeds: [addrEnc.encode(PROGRAM_ID)] });
    console.log('create_admin_pool…');
    await adminClient.sendTransaction([
      getCreateAdminPoolInstruction({
        admin: deployer,
        operator: deployerAddr,
        program: PROGRAM_ID,
        programData,
        adminPool,
        creationFee: 2_000_000n,
        protocolPerformanceFee: 2000,
        protocolMoneyManagementFee: 2000,
        tradingFee: 1_000_000n,
        moneyManagementYearlyFeeMax: 1500,
        performanceFeeMax: 2000,
        withdrawCooldownMax: 3_888_000n,
        fundrisingPeriodMax: 2_592_000n,
        raiseAmountMinUsd: 10_000n,
        contributionAmountMinUsd: 10_000n,
        oracleMaxAge: 259_200n,
        idlePeriod: 7_776_000n,
        dustThresholdUsd: 10_000n,
        maxAssetCount: 30,
        maxSlippageBps: 1000,
      }),
    ]);
  }

  // 3. external assets: inject the two demo SPL mints + their fresh Pyth prices ($1.50 base, $1.00 out)
  const baseMint = address('D3mSMintFbyt1111111111111111111111111111111');
  const [outMint] = await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [new TextEncoder().encode(DEMO_OUT_MINT_SEED)] });
  await injectMint(baseMint, 6, deployerAddr);
  await injectMint(outMint, 6, deployerAddr);
  const nowTs = await rpc<number>('getBlockTime', [await rpc<number>('getSlot', [])]).catch(() => Math.floor(Date.now() / 1000));
  const basePrice = await injectPrice(DEMO_FEED, 150_000_000n, nowTs);
  await injectPrice(DEMO_OUT_FEED, 100_000_000n, nowTs);

  // 4. onboard both assets through the program: create_oracle_pool + approve_oracle_pool
  for (const [mint, feed] of [[baseMint, DEMO_FEED], [outMint, DEMO_OUT_FEED]] as const) {
    const [oraclePool] = await findOraclePoolPda({ adminPool, tokenMint: mint }, { programAddress: PROGRAM_ID });
    const oracle = await fetchMaybeOraclePool(adminClient.rpc, oraclePool);
    if (!oracle.exists) {
      await adminClient.sendTransaction([await getCreateOraclePoolInstructionAsync({ requester: deployer, tokenMint: mint, feedId: `0x${feed}` })]);
    }
    if (!oracle.exists || !oracle.data.isApproved) {
      await adminClient.sendTransaction([await getApproveOraclePoolInstructionAsync({ admin: deployer, tokenMint: mint })]);
    }
  }
  console.log('oracles onboarded (base + demo-out)');

  // 5. create the demo vault through the program (create_money_manager_pool + create_vault)
  const admin = await fetchMaybeAdminPool(adminClient.rpc, adminPool);
  if (!admin.exists) throw new Error('admin pool missing after create');
  const index = admin.data.vaultPoolCount;
  const [vaultPool] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode('VaultPool'), addrEnc.encode(adminPool), addrEnc.encode(managerAddr), le(index, 8)],
  });
  if ((await fetchMaybeVaultPool(adminClient.rpc, vaultPool)).exists) {
    console.log('demo vault exists, skipping create_vault');
  } else {
    const [baseOracle] = await findOraclePoolPda({ adminPool, tokenMint: baseMint }, { programAddress: PROGRAM_ID });
    const [assetRegistry] = await findAssetRegistryPda({ vaultPool }, { programAddress: PROGRAM_ID });
    const ixs = [];
    if (!(await fetchMaybeMoneyManagerPool(managerClient.rpc, (await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [new TextEncoder().encode('MoneyManagerPool'), addrEnc.encode(adminPool), addrEnc.encode(managerAddr)] }))[0])).exists) {
      ixs.push(await getCreateMoneyManagerPoolInstructionAsync({ moneyManager: manager }));
    }
    ixs.push(
      await getCreateVaultInstructionAsync({
        admin: admin.data.admin,
        moneyManager: manager,
        vaultPool,
        assetRegistry,
        oraclePool: baseOracle,
        priceUpdate: basePrice,
        tokenMint: baseMint,
        minContributeAmount: 10_000n,
        raisePeriod: 2_592_000n,
        minRaiseAmount: 10_000n,
        mmWithdrawPeriod: 604_800n,
        withdrawCooldown: 3_888_000n,
        moneyManagementFee: 1000,
        performanceFee: 1500,
        isOpenEnded: true,
      }),
    );
    console.log('create_money_manager_pool + create_vault…');
    await managerClient.sendTransaction(ixs);
  }

  // 6. trade prerequisites (localnet only): clone the bundled jupiter-mock at the Jupiter id and seed
  //    the demo output asset's counterparty liquidity, so the manager can trade once past the fundraise.
  const mockSo = `${repoRoot}/programs/fbyt_vault/tests/jupiter-mock/target/deploy/jupiter_mock.so`;
  if (existsSync(mockSo)) {
    console.log('cloning jupiter-mock at the Jupiter id…');
    const tmpKp = join(keysDir, 'jupmock.json');
    execSync(`solana-keygen new --no-bip39-passphrase --silent --force -o ${tmpKp}`, { stdio: 'ignore' });
    const tmpId = execSync(`solana-keygen pubkey ${tmpKp}`).toString().trim();
    execSync(`solana program deploy ${mockSo} --program-id ${tmpKp} --keypair ${deployerPath} --url ${RPC_URL} --commitment confirmed`, { stdio: 'ignore' });
    await rpc('surfnet_cloneProgramAccount', [tmpId, String(JUPITER)]);
  } else {
    console.log('jupiter-mock .so not built; skipping (trade UI will be unavailable)');
  }
  const [poolPda] = await getProgramDerivedAddress({ programAddress: JUPITER, seeds: [new TextEncoder().encode(JUPITER_POOL_SEED)] });
  await rpc('surfnet_setTokenAccount', [poolPda, outMint, { amount: 1_000_000_000 }]).catch(() => {});
  await rpc('surfnet_setTokenAccount', [poolPda, baseMint, { amount: 0 }]).catch(() => {});
  await rpc('surfnet_setTokenAccount', [vaultPool, outMint, { amount: 0 }]).catch(() => {});

  console.log('\nbootstrap complete:');
  console.log('  admin pool   ', adminPool);
  console.log('  demo mint    ', baseMint);
  console.log('  demo out mint', outMint);
  console.log('  demo vault   ', vaultPool);
  console.log('\nFund a wallet with demo tokens:  POST /api/faucet { address, mint }');
  console.log('Advance a vault to its trading phase:  POST /api/dev/advance { vault }');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
