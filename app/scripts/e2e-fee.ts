/**
 * End-to-end money-management-fee withdrawal against a running surfnet. The protocol operator streams
 * the accrued fee in kind for each vault asset. Run after e2e-lifecycle (the vault must have traded and
 * hold balances). Time-travels to one `mm_withdraw_period` past the last withdrawal, then calls
 * withdraw_money_management_fee with a group of 4 `[mint, vault_ata, manager_ata, protocol_ata]` per asset.
 *
 *   pnpm localnet -> pnpm bootstrap -> pnpm e2e:lifecycle <vault> -> pnpm tsx scripts/e2e-fee.ts <vault>
 */
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
  fetchAdminPool,
  findAdminPoolPda,
  getWithdrawMoneyManagementFeeInstructionAsync,
} from '../src/generated/index.js';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const PROGRAM_ID = address(process.env.NEXT_PUBLIC_FBYT_PROGRAM_ID ?? '3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const VAULT = process.argv[2] as Address;
const addrEnc = getAddressEncoder();
const here = dirname(fileURLToPath(import.meta.url));

let id = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}
async function pda(p: Address, seeds: Array<Uint8Array | ReadonlyUint8Array>) { const [a] = await getProgramDerivedAddress({ programAddress: p, seeds }); return a; }
const ata = (owner: Address, mint: Address) => pda(ATA_PROGRAM, [addrEnc.encode(owner), addrEnc.encode(TOKEN_PROGRAM), addrEnc.encode(mint)]);
const bal = async (a: Address) => { const r = await rpc<{ value: { amount: string } | null }>('getTokenAccountBalance', [a]).catch(() => null); return r?.value ? BigInt(r.value.amount) : 0n; };

async function main() {
  if (!VAULT) throw new Error('usage: tsx scripts/e2e-fee.ts <vaultAddress>');
  const operator = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(here, '.keys', 'deployer.json'), 'utf8'))));
  const client = createClient().use(signer(operator)).use(solanaRpc({ rpcUrl: RPC_URL }));

  const d = (await fetchVaultPool(client.rpc, VAULT)).data;
  const [adminPoolAddr] = await findAdminPoolPda({ programAddress: PROGRAM_ID });
  const admin = (await fetchAdminPool(client.rpc, adminPoolAddr)).data;
  if (d.lastTradeAt === d.createdAt) throw new Error('vault has not traded — run e2e-lifecycle first');

  const outMint = await pda(PROGRAM_ID, [new TextEncoder().encode('demo-out-mint')]);
  const assets = [d.tokenMint, outMint];

  // move the clock one mm_withdraw_period past the last fee withdrawal (still within idle_period)
  const feeAt = Number(d.lastMmFeeWithdrawAt + d.mmWithdrawPeriod) + 60;
  const dormantAt = Number(d.lastTradeAt + admin.idlePeriod);
  if (feeAt > dormantAt) throw new Error('fee window is past idle_period — vault would be dormant');
  await rpc('surfnet_timeTravel', [{ absoluteTimestamp: feeAt * 1000 }]);

  // ensure the manager/protocol fee ATAs exist for every asset (empty)
  const remaining: AccountMeta[] = [];
  const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });
  const w = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });
  const before: Record<string, bigint> = {};
  for (const mint of assets) {
    await rpc('surfnet_setTokenAccount', [d.moneyManager, mint, { amount: 0 }]).catch(() => {});
    await rpc('surfnet_setTokenAccount', [admin.admin, mint, { amount: 0 }]).catch(() => {});
    const vaultAta = await ata(VAULT, mint);
    const managerAta = await ata(d.moneyManager, mint);
    const protocolAta = await ata(admin.admin, mint);
    before[mint] = (await bal(managerAta)) + (await bal(protocolAta));
    remaining.push(ro(mint), w(vaultAta), w(managerAta), w(protocolAta));
  }

  const base = await getWithdrawMoneyManagementFeeInstructionAsync({
    operator,
    vaultPool: VAULT,
    tokenProgram: TOKEN_PROGRAM,
    tokenProgram2022: TOKEN_2022,
  });
  console.log('withdrawing management fee…');
  const res = await client.sendTransaction([{ programAddress: base.programAddress, accounts: [...base.accounts, ...remaining] as AccountMeta[], data: base.data }]);
  console.log('signature', String(res.context.signature));

  let moved = 0n;
  for (const mint of assets) {
    const managerAta = await ata(d.moneyManager, mint);
    const protocolAta = await ata(admin.admin, mint);
    const after = (await bal(managerAta)) + (await bal(protocolAta));
    const delta = after - before[mint];
    moved += delta;
    console.log(`  ${String(mint).slice(0, 6)}… fee streamed: ${delta}`);
  }
  if (moved <= 0n) throw new Error('no fee was streamed');
  console.log('\n✅ management-fee withdrawal works end-to-end');
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); process.exit(1); });
