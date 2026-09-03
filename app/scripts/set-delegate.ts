/**
 * Set (or revoke) a vault's trading delegate, signed by the money manager. The delegate is a
 * trade-only key — it can call `swap` but never withdraw. Used to authorize the keeper bot.
 *
 *   pnpm tsx scripts/set-delegate.ts <vault> <delegatePubkey|revoke>
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { address, createClient, createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import { getSetTradingDelegateInstruction, getRevokeTradingDelegateInstruction } from '../src/generated/index.js';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const here = dirname(fileURLToPath(import.meta.url));
const [vault, arg] = process.argv.slice(2);

async function main() {
  if (!vault || !arg) throw new Error('usage: tsx scripts/set-delegate.ts <vault> <delegatePubkey|revoke>');
  const manager = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(here, '.keys', 'manager.json'), 'utf8'))));
  const client = createClient().use(signer(manager)).use(solanaRpc({ rpcUrl: RPC_URL }));
  const ix =
    arg === 'revoke'
      ? getRevokeTradingDelegateInstruction({ vaultPool: vault as Address, moneyManager: manager })
      : getSetTradingDelegateInstruction({ vaultPool: vault as Address, moneyManager: manager, tradingDelegate: address(arg) });
  const res = await client.sendTransaction([ix]);
  console.log(arg === 'revoke' ? 'delegate revoked' : `delegate set to ${arg}`, '—', String(res.context.signature).slice(0, 12), '…');
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); process.exit(1); });
