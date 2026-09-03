/**
 * End-to-end check of the Sign-In-With-Solana session flow (needs the Next dev server on :3000).
 * Signs a nonce'd message with a keypair, exchanges it for a session cookie, confirms /api/auth/me
 * returns the address, and that a tampered cookie is rejected.
 *
 *   pnpm dev  ->  pnpm tsx scripts/e2e-auth.ts
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAddressDecoder } from '@solana/kit';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const here = dirname(fileURLToPath(import.meta.url));
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

async function main() {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(join(here, '.keys', 'manager.json'), 'utf8')));
  const pub = getAddressDecoder().decode(bytes.slice(32, 64));
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(bytes.slice(0, 32))]), format: 'der', type: 'pkcs8' });

  const { nonce } = await (await fetch(`${APP_URL}/api/auth/nonce`)).json();
  const message = `app.fbyt.io wants you to sign in with your Solana account:\n${pub}\n\nNonce: ${nonce}`;
  const signature = sign(null, new TextEncoder().encode(message), priv).toString('base64');

  const res = await fetch(`${APP_URL}/api/auth/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: pub, message: Buffer.from(message).toString('base64'), signature }),
  });
  if (!res.ok) throw new Error(`verify failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('no session cookie set');
  console.log('signed in, cookie issued');

  const me = await (await fetch(`${APP_URL}/api/auth/me`, { headers: { cookie } })).json();
  if (me.address !== pub) throw new Error(`me returned ${me.address}, expected ${pub}`);
  console.log('/api/auth/me →', me.address.slice(0, 8), '…');

  const tampered = cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
  const meBad = await (await fetch(`${APP_URL}/api/auth/me`, { headers: { cookie: tampered } })).json();
  if (meBad.address) throw new Error('tampered cookie was accepted!');
  console.log('tampered cookie rejected');

  console.log('\n✅ SIWS session auth works end-to-end');
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); process.exit(1); });
