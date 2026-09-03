/**
 * End-to-end investor round-trip against a running surfnet: deposit, jump past the withdraw cooldown,
 * refresh the oracle price, then redeem the full position with a real withdraw_token_fund (per-asset
 * remaining-account group of 7). Asserts shares burn and base tokens come back.
 *
 *   pnpm localnet -> pnpm bootstrap -> pnpm tsx scripts/e2e-withdraw.ts <vaultAddress>
 */
import {
  address,
  createClient,
  generateKeyPairSigner,
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
  findAdminPoolPda,
  findOraclePoolPda,
  fetchOraclePool,
  getCreateInvestorPoolInstructionAsync,
  getDepositTokenFundInstructionAsync,
  getWithdrawTokenFundInstructionAsync,
} from '../src/generated/index.js';
import { createHash } from 'node:crypto';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const PROGRAM_ID = address(process.env.NEXT_PUBLIC_FBYT_PROGRAM_ID ?? '3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PYTH_RECEIVER = address('rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp');
const PYTH_PUSH_ORACLE = address('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
const VAULT = process.argv[2] as Address;
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
const le = (v: number | bigint, n: number) => {
  const o = new Uint8Array(n);
  let x = BigInt(v);
  for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; }
  return o;
};
function feed32(bytesLike: ArrayLike<number>): Uint8Array {
  const hex = new TextDecoder().decode(Uint8Array.from(bytesLike)).replace(/\0+$/, '').replace(/^0x/, '');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function pda(p: Address, seeds: Array<Uint8Array | ReadonlyUint8Array>) {
  const [a] = await getProgramDerivedAddress({ programAddress: p, seeds });
  return a;
}
const ata = (owner: Address, mint: Address) =>
  pda(ATA_PROGRAM, [addrEnc.encode(owner), addrEnc.encode(TOKEN_PROGRAM), addrEnc.encode(mint)]);
async function balance(acct: Address): Promise<bigint> {
  const r = await rpc<{ value: { amount: string } | null }>('getTokenAccountBalance', [acct]).catch(() => null);
  return r?.value ? BigInt(r.value.amount) : 0n;
}
async function injectPrice(feedHex32: Uint8Array, publishTime: number) {
  const [priceAcct] = await getProgramDerivedAddress({
    programAddress: PYTH_PUSH_ORACLE,
    seeds: [new Uint8Array([0, 0]), feedHex32],
  });
  const price = 150_000_000n;
  const disc = new Uint8Array(createHash('sha256').update('account:PriceUpdateV2').digest()).slice(0, 8);
  const parts: Array<ArrayLike<number>> = [disc, new Uint8Array(32), [1], feedHex32, le(price, 8), le(1n, 8), le(0xfffffff8, 4), le(publishTime, 8), le(publishTime, 8), le(price, 8), le(1n, 8), le(0n, 8)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const data = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { data.set(Uint8Array.from(p), o); o += p.length; }
  await rpc('surfnet_setAccount', [priceAcct, { lamports: 5_000_000, data: Buffer.from(data).toString('hex'), owner: PYTH_RECEIVER, executable: false, rent_epoch: 0 }]);
}

async function main() {
  if (!VAULT) throw new Error('usage: tsx scripts/e2e-withdraw.ts <vaultAddress>');
  const investor = await generateKeyPairSigner();
  const client = createClient().use(signer(investor)).use(solanaRpc({ rpcUrl: RPC_URL }));

  const vault = await fetchVaultPool(client.rpc, VAULT);
  const d = vault.data;
  const [adminPoolAddr] = await findAdminPoolPda({ programAddress: PROGRAM_ID });
  const admin = await fetchAdminPool(client.rpc, adminPoolAddr);
  const [oraclePool] = await findOraclePoolPda({ adminPool: d.adminPool, tokenMint: d.tokenMint }, { programAddress: PROGRAM_ID });
  const oracle = await fetchOraclePool(client.rpc, oraclePool);
  const feed = feed32(oracle.data.feedId);
  const priceUpdate = await pda(PYTH_PUSH_ORACLE, [new Uint8Array([0, 0]), feed]);

  // fund + deposit
  await rpc('surfnet_setAccount', [investor.address, { lamports: 10_000_000_000 }]);
  await rpc('surfnet_setTokenAccount', [investor.address, d.tokenMint, { amount: 1_000_000_000 }]);
  const fromAccount = await ata(investor.address, d.tokenMint);
  await client.sendTransaction([
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: investor, owner: VAULT, mint: d.tokenMint }),
    await getCreateInvestorPoolInstructionAsync({ investor, vaultPool: VAULT, tokenMint: d.tokenMint }),
    await getDepositTokenFundInstructionAsync({ investor, vaultPool: VAULT, oraclePool, fromAccount, tokenMint: d.tokenMint, priceUpdate, tokenProgram: TOKEN_PROGRAM, amount: 100_000_000n }),
  ]);

  // jump past the cooldown and refresh the price to "now"
  const unlock = Number(d.createdAt + d.raisePeriod + d.withdrawCooldown) + 60;
  await rpc('surfnet_timeTravel', [{ absoluteTimestamp: unlock * 1000 }]);
  await injectPrice(feed, unlock);

  // fee-recipient token accounts (owned by the manager / protocol admin)
  await rpc('surfnet_setTokenAccount', [d.moneyManager, d.tokenMint, { amount: 0 }]);
  await rpc('surfnet_setTokenAccount', [admin.data.admin, d.tokenMint, { amount: 0 }]);
  const vaultAta = await ata(VAULT, d.tokenMint);
  const mgrFee = await ata(d.moneyManager, d.tokenMint);
  const protoFee = await ata(admin.data.admin, d.tokenMint);
  const [investorPool] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode('InvestorPool'), addrEnc.encode(investor.address), addrEnc.encode(d.adminPool), addrEnc.encode(VAULT), addrEnc.encode(d.tokenMint)],
  });

  const before = await balance(fromAccount);
  const ix = await getWithdrawTokenFundInstructionAsync({
    investor,
    moneyManager: d.moneyManager,
    vaultPool: VAULT,
    investorPool,
    tokenProgram: TOKEN_PROGRAM,
    tokenProgram2022: TOKEN_2022,
    shares: 100_000_000n,
  });
  // append the base-asset group of 7: [oracle, price, mint, vault_ata, investor_ata, mgr_fee, proto_fee]
  const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });
  const w = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });
  const withRemaining = {
    ...ix,
    accounts: [...ix.accounts, ro(oraclePool), ro(priceUpdate), ro(d.tokenMint), w(vaultAta), w(fromAccount), w(mgrFee), w(protoFee)],
  };
  console.log('redeeming…');
  const res = await client.sendTransaction([withRemaining]);
  console.log('signature', String(res.context.signature));

  const after = await balance(fromAccount);
  const vaultAfter = await fetchVaultPool(client.rpc, VAULT);
  console.log('investor base tokens', before.toString(), '→', after.toString());
  console.log('vault total shares', d.totalShares.toString(), '→', vaultAfter.data.totalShares.toString());
  if (after <= before) throw new Error('investor did not receive tokens back');
  console.log('\n✅ redeem flow works end-to-end');
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
