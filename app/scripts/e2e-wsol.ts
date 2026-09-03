/**
 * End-to-end check of the native-SOL wrap primitive used for wSOL-base vault deposits: create the
 * investor's wrapped-SOL ATA, fund it with SOL, and sync — asserting the wSOL token balance equals the
 * wrapped amount. (Mirrors src/lib/wsol.ts; the deposit path itself is covered by e2e-deposit.)
 *
 *   pnpm localnet -> pnpm tsx scripts/e2e-wsol.ts
 */
import {
  address,
  createClient,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  AccountRole,
  type Address,
} from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const WSOL = address('So11111111111111111111111111111111111111112');
const SYSTEM = address('11111111111111111111111111111111');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const addrEnc = getAddressEncoder();

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}
const u64le = (v: bigint) => { const o = new Uint8Array(8); for (let i = 0; i < 8; i++) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };

async function main() {
  const investor = await generateKeyPairSigner();
  const client = createClient().use(signer(investor)).use(solanaRpc({ rpcUrl: RPC_URL }));
  await rpc('surfnet_setAccount', [investor.address, { lamports: 10_000_000_000 }]);

  const [wsolAta] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [addrEnc.encode(investor.address), addrEnc.encode(TOKEN_PROGRAM), addrEnc.encode(WSOL)] });
  const amount = 1_000_000_000n; // 1 SOL
  const ixs = [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: investor, owner: investor.address, mint: WSOL }),
    { programAddress: SYSTEM, accounts: [{ address: investor.address as Address, role: AccountRole.WRITABLE_SIGNER }, { address: wsolAta, role: AccountRole.WRITABLE }], data: new Uint8Array([2, 0, 0, 0, ...u64le(amount)]) },
    { programAddress: TOKEN_PROGRAM, accounts: [{ address: wsolAta, role: AccountRole.WRITABLE }], data: new Uint8Array([17]) },
  ];
  await client.sendTransaction(ixs);

  const b = await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [wsolAta]);
  console.log('wSOL balance after wrap:', b.value.amount);
  if (BigInt(b.value.amount) !== amount) throw new Error(`expected ${amount}, got ${b.value.amount}`);
  console.log('\n✅ native SOL wrap (create ATA → fund → sync) works end-to-end');
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); process.exit(1); });
