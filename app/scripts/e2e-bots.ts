/**
 * End-to-end check of the bot platform (needs the Next dev server + a surfnet with a past-fundraise
 * vault whose trading delegate is set to .keys/delegate.json). As the signed-in manager it registers a
 * DCA bot, runs the keeper in DB mode, and asserts the bot executed and recorded an order; then halts
 * the bot, reruns the keeper, and asserts nothing more executes.
 *
 *   pnpm dev  ->  pnpm tsx scripts/e2e-bots.ts <vault>
 */
import { execSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAddressDecoder } from '@solana/kit';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const BASE = 'D3mSMintFbyt1111111111111111111111111111111';
const OUT = '4EE11i26uYsTxY9kU41GjYZBso6UCx4dy1is3nZ6sFgC';
const here = dirname(fileURLToPath(import.meta.url));
const VAULT = process.argv[2];
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function key(path: string) {
  const b = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
  return { pub: getAddressDecoder().decode(b.slice(32, 64)), priv: createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(b.slice(0, 32))]), format: 'der', type: 'pkcs8' }) };
}
async function signIn(k: ReturnType<typeof key>): Promise<string> {
  const { nonce } = await (await fetch(`${APP_URL}/api/auth/nonce`)).json();
  const message = `app.fbyt.io wants you to sign in with your Solana account:\n${k.pub}\n\nNonce: ${nonce}`;
  const signature = sign(null, new TextEncoder().encode(message), k.priv).toString('base64');
  const res = await fetch(`${APP_URL}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: k.pub, message: Buffer.from(message).toString('base64'), signature }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('sign-in failed');
  return cookie;
}
// exercise the production Rust keeper by default (KEEPER=ts falls back to the TS keeper); both read
// the bots the app wrote and write executions back through the same SQLite DB.
const rustBin = join(here, '..', '..', 'keeper', 'target', 'debug', 'fbyt-keeper');
const runKeeper = () =>
  process.env.KEEPER === 'ts'
    ? execSync(`pnpm tsx scripts/keeper.ts --db .keys/delegate.json`, { cwd: join(here, '..'), encoding: 'utf8' })
    : execSync(`${rustBin} scripts/.keys/delegate.json --once`, { cwd: join(here, '..'), encoding: 'utf8', env: { ...process.env, FBYT_DB_PATH: process.env.FBYT_DB_PATH ?? join(here, '..', '.data', 'fbyt.db') } });

// fetch that retries transient network errors — undici may hold a keep-alive socket the server closed
// while the synchronous keeper run (execSync) blocked the event loop; a retry opens a fresh connection.
async function req(url: string, opts?: RequestInit): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw last;
}

async function main() {
  if (!VAULT) throw new Error('usage: tsx scripts/e2e-bots.ts <vault>');
  const cookie = await signIn(key(join(here, '.keys', 'manager.json')));

  // register a DCA bot (requires the vault's on-chain delegate to be set)
  const created = await (await req(`${APP_URL}/api/bots`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ vault: VAULT, strategy: { type: 'dca', inputMint: BASE, outputMint: OUT, inputAmount: '5000000', maxSlippageBps: 100 } }),
  })).json();
  if (!created.id) throw new Error(`create failed: ${JSON.stringify(created)}`);
  console.log('bot created:', created.id);

  // run the keeper in DB mode → should execute the bot once
  runKeeper();
  let got = await (await req(`${APP_URL}/api/bots/${created.id}`)).json();
  if ((got.bot.runCount ?? 0) < 1 || got.orders.length < 1) throw new Error(`bot did not execute: runCount=${got.bot.runCount} orders=${got.orders.length}`);
  console.log(`after run: runCount=${got.bot.runCount}, orders=${got.orders.length}`);

  // halt the bot, rerun the keeper → no further execution
  await req(`${APP_URL}/api/bots/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ enabled: false }) });
  const runCountBefore = got.bot.runCount;
  runKeeper();
  got = await (await req(`${APP_URL}/api/bots/${created.id}`)).json();
  if (got.bot.runCount !== runCountBefore) throw new Error('halted bot still executed');
  console.log(`after halt+rerun: runCount=${got.bot.runCount} (unchanged) — halt works`);

  console.log('\n✅ bot platform (register → run → orders → halt) works end-to-end');
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); console.error('cause:', (e as { cause?: unknown })?.cause); process.exit(1); });
