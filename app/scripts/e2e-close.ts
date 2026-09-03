/**
 * End-to-end check of close_vault against a running surfnet, as the vault's money manager. Jumps past
 * the fundraise if needed, soft-closes the vault, and asserts the status becomes Closed (3).
 *
 *   pnpm localnet -> pnpm bootstrap -> pnpm tsx scripts/e2e-close.ts <vaultAddress>
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { address, createClient, createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import { fetchVaultPool, getCloseVaultInstructionAsync } from '../src/generated/index.js';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const VAULT = process.argv[2] as Address;
const here = dirname(fileURLToPath(import.meta.url));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}

async function main() {
  if (!VAULT) throw new Error('usage: tsx scripts/e2e-close.ts <vaultAddress>');
  const manager = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(here, '.keys', 'manager.json'), 'utf8'))));
  const client = createClient().use(signer(manager)).use(solanaRpc({ rpcUrl: RPC_URL }));
  const d = (await fetchVaultPool(client.rpc, VAULT)).data;
  if (String(d.moneyManager) !== manager.address) throw new Error('manager keypair does not own this vault');

  // a vault can only be closed once its fundraise has ended
  const raiseEnd = Number(d.createdAt + d.raisePeriod) + 60;
  await rpc('surfnet_timeTravel', [{ absoluteTimestamp: raiseEnd * 1000 }]).catch(() => {});

  await client.sendTransaction([await getCloseVaultInstructionAsync({ moneyManager: manager, vaultPool: VAULT, tokenMint: d.tokenMint })]);
  const after = (await fetchVaultPool(client.rpc, VAULT)).data;
  console.log('vault status', d.vaultPoolStatus, '→', after.vaultPoolStatus);
  if (after.vaultPoolStatus !== 3) throw new Error('vault did not close');
  console.log('\n✅ close_vault works end-to-end');
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); process.exit(1); });
