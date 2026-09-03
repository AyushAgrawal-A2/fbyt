/**
 * End-to-end check of uploads + token launches (needs the Next dev server on :3000). Signs in, uploads
 * a tiny PNG, creates a launch referencing it, lists it, toggles a vote on/off, and confirms an
 * unauthenticated create is rejected.
 *
 *   pnpm dev  ->  pnpm tsx scripts/e2e-launches.ts
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAddressDecoder } from '@solana/kit';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const here = dirname(fileURLToPath(import.meta.url));
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function keyOf(path: string) {
  const b = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
  return { pub: getAddressDecoder().decode(b.slice(32, 64)), priv: createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(b.slice(0, 32))]), format: 'der', type: 'pkcs8' }) };
}
async function signIn(k: ReturnType<typeof keyOf>): Promise<string> {
  const { nonce } = await (await fetch(`${APP_URL}/api/auth/nonce`)).json();
  const message = `app.fbyt.io wants you to sign in with your Solana account:\n${k.pub}\n\nNonce: ${nonce}`;
  const signature = sign(null, new TextEncoder().encode(message), k.priv).toString('base64');
  const res = await fetch(`${APP_URL}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: k.pub, message: Buffer.from(message).toString('base64'), signature }) });
  return res.headers.get('set-cookie')!.split(';')[0];
}

async function main() {
  const cookie = await signIn(keyOf(join(here, '.keys', 'manager.json')));

  // unauth create is rejected
  const bad = await fetch(`${APP_URL}/api/launches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', symbol: 'X' }) });
  if (bad.ok) throw new Error('unauth create accepted');
  console.log('unauth create rejected:', bad.status);

  // upload an image
  const up = await (await fetch(`${APP_URL}/api/uploads`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ dataUrl: PNG }) })).json();
  if (!up.url) throw new Error(`upload failed: ${JSON.stringify(up)}`);
  const img = await fetch(`${APP_URL}${up.url}`);
  if (!img.ok || !img.headers.get('content-type')?.startsWith('image/')) throw new Error('image not served');
  console.log('uploaded + served:', up.url, img.headers.get('content-type'));

  // create a launch
  const created = await (await fetch(`${APP_URL}/api/launches`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Demo Coin', symbol: 'demo', description: 'A test launch', imageUrl: up.url, launchAt: Date.now() + 86400000 }) })).json();
  if (!created.id) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const list = (await (await fetch(`${APP_URL}/api/launches`)).json()).launches as Array<{ id: string; symbol: string }>;
  if (!list.find((l) => l.id === created.id && l.symbol === 'DEMO')) throw new Error('launch not listed / symbol not upcased');
  console.log('launch created + listed:', created.id);

  // vote toggles on then off
  const v1 = await (await fetch(`${APP_URL}/api/launches/${created.id}/vote`, { method: 'POST', headers: { cookie } })).json();
  const v2 = await (await fetch(`${APP_URL}/api/launches/${created.id}/vote`, { method: 'POST', headers: { cookie } })).json();
  if (v1.votes !== 1 || v2.votes !== 0) throw new Error(`vote toggle wrong: ${v1.votes}/${v2.votes}`);
  console.log('vote toggled 1 → 0');

  console.log('\n✅ uploads + token launches work end-to-end');
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); process.exit(1); });
