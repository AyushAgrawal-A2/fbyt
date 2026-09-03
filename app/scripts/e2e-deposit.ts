/**
 * End-to-end check against a running surfnet + bootstrapped state: fund a fresh investor, then send
 * the real create_investor_pool + deposit_token_fund transaction (the same instructions the UI builds)
 * and assert the vault's raised amount and the investor's shares moved. Proves the investor flow works.
 *
 *   pnpm localnet   # (surfpool)   ->   pnpm bootstrap   ->   pnpm tsx scripts/e2e-deposit.ts
 */
import {
  address,
  createClient,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type ReadonlyUint8Array,
} from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import {
  fetchVaultPool,
  fetchMaybeInvestorPool,
  findInvestorPoolPda,
  findOraclePoolPda,
  fetchOraclePool,
  getCreateInvestorPoolInstructionAsync,
  getDepositTokenFundInstructionAsync,
} from '../src/generated/index.js';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const PROGRAM_ID = address(
  process.env.NEXT_PUBLIC_FBYT_PROGRAM_ID ?? '3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y',
);
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PYTH_PUSH_ORACLE = address('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
const VAULT = process.argv[2] as Address; // pass the demo vault address
const addrEnc = getAddressEncoder();

let id = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}
function feed32(bytesLike: ArrayLike<number>): Uint8Array {
  const hex = new TextDecoder().decode(Uint8Array.from(bytesLike)).replace(/\0+$/, '').replace(/^0x/, '');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function pda(programAddress: Address, seeds: Array<Uint8Array | ReadonlyUint8Array>) {
  const [a] = await getProgramDerivedAddress({ programAddress, seeds });
  return a;
}

async function main() {
  if (!VAULT) throw new Error('usage: tsx scripts/e2e-deposit.ts <vaultAddress>');
  const investor = await generateKeyPairSigner();
  const client = createClient().use(signer(investor)).use(solanaRpc({ rpcUrl: RPC_URL }));

  const vaultBefore = await fetchVaultPool(client.rpc, VAULT);
  const d = vaultBefore.data;

  // fund the investor: SOL + demo base tokens
  await rpc('surfnet_setAccount', [investor.address, { lamports: 10_000_000_000 }]);
  await rpc('surfnet_setTokenAccount', [investor.address, d.tokenMint, { amount: 1_000_000_000 }]);

  // derive the accounts the deposit needs (mirrors the UI)
  const [oraclePool] = await findOraclePoolPda(
    { adminPool: d.adminPool, tokenMint: d.tokenMint },
    { programAddress: PROGRAM_ID },
  );
  const oracle = await fetchOraclePool(client.rpc, oraclePool);
  const priceUpdate = await pda(PYTH_PUSH_ORACLE, [new Uint8Array([0, 0]), feed32(oracle.data.feedId)]);
  const fromAccount = await pda(ATA_PROGRAM, [
    addrEnc.encode(investor.address),
    addrEnc.encode(TOKEN_PROGRAM),
    addrEnc.encode(d.tokenMint),
  ]);
  const [investorPool] = await findInvestorPoolPda(
    { investor: investor.address, adminPool: d.adminPool, vaultPool: VAULT, tokenMint: d.tokenMint },
    { programAddress: PROGRAM_ID },
  );

  const amount = 100_000_000n; // 100 tokens (6dp)
  const ixs = [
    // the vault's base ATA must exist before the first deposit (the program does not init it);
    // the first depositor creates it idempotently.
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: investor, owner: VAULT, mint: d.tokenMint }),
    await getCreateInvestorPoolInstructionAsync({
      investor,
      vaultPool: VAULT,
      tokenMint: d.tokenMint,
    }),
    await getDepositTokenFundInstructionAsync({
      investor,
      vaultPool: VAULT,
      oraclePool,
      fromAccount,
      tokenMint: d.tokenMint,
      priceUpdate,
      tokenProgram: TOKEN_PROGRAM,
      amount,
    }),
  ];

  console.log('sending deposit…');
  const res = await client.sendTransaction(ixs);
  console.log('signature', String(res.context.signature));

  const vaultAfter = await fetchVaultPool(client.rpc, VAULT);
  const pos = await fetchMaybeInvestorPool(client.rpc, investorPool);
  console.log('raised before/after:', d.raisedAmountUsd.toString(), '→', vaultAfter.data.raisedAmountUsd.toString());
  console.log('total shares before/after:', d.totalShares.toString(), '→', vaultAfter.data.totalShares.toString());
  console.log('investor shares:', pos.exists ? pos.data.shares.toString() : '(none)');

  if (vaultAfter.data.raisedAmountUsd <= d.raisedAmountUsd) throw new Error('raised did not increase');
  if (!pos.exists || pos.data.shares <= 0n) throw new Error('no shares minted');
  console.log('\n✅ deposit flow works end-to-end');
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
