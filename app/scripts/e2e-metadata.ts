/**
 * End-to-end check of the off-chain vault-profile API (needs the Next dev server on :3000 and a
 * bootstrapped surfnet). Signs the canonical profile message with the vault's money-manager key,
 * PUTs the profile, and asserts it reads back and appears on the vaults list. Also asserts a write
 * signed by a non-manager key is rejected.
 *
 *   pnpm dev  (separately)  ->  pnpm tsx scripts/e2e-metadata.ts <vaultAddress>
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAddressDecoder } from '@solana/kit';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const VAULT = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyFromFile(path: string) {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
  const seed = Buffer.from(bytes.slice(0, 32));
  const pub = getAddressDecoder().decode(bytes.slice(32, 64));
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { pub, priv };
}
function signProfile(priv: ReturnType<typeof createPrivateKey>, vault: string, issuedAt: number): string {
  const message = `FBYT vault profile\nvault: ${vault}\nissued: ${issuedAt}`;
  return sign(null, new TextEncoder().encode(message), priv).toString('base64');
}

async function main() {
  if (!VAULT) throw new Error('usage: tsx scripts/e2e-metadata.ts <vaultAddress>');
  const mgr = keyFromFile(join(here, '.keys', 'manager.json'));
  const stranger = keyFromFile(join(here, '.keys', 'deployer.json')); // not the manager

  // 1. a non-manager signature is rejected
  const t0 = Date.now();
  const bad = await fetch(`${APP_URL}/api/vaults/${VAULT}/metadata`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Hijack', signer: stranger.pub, signature: signProfile(stranger.priv, VAULT, t0), issuedAt: t0 }),
  });
  if (bad.ok) throw new Error('non-manager write was accepted!');
  console.log('non-manager write rejected:', bad.status);

  // 2. the manager writes a profile
  const t1 = Date.now();
  const profile = { name: 'Blue-Chip Momentum', strategy: 'Rotate majors on trend', description: 'A demo vault profile.' };
  const put = await fetch(`${APP_URL}/api/vaults/${VAULT}/metadata`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...profile, signer: mgr.pub, signature: signProfile(mgr.priv, VAULT, t1), issuedAt: t1 }),
  });
  const putJson = await put.json();
  if (!put.ok) throw new Error(`manager write failed: ${JSON.stringify(putJson)}`);
  console.log('manager write accepted');

  // 3. it reads back and shows on the list
  const got = await (await fetch(`${APP_URL}/api/vaults/${VAULT}/metadata`)).json();
  if (got.metadata?.name !== profile.name) throw new Error('profile did not persist');
  const list = await (await fetch(`${APP_URL}/api/vaults`)).json();
  const row = list.vaults?.find((v: { address: string }) => v.address === VAULT);
  if (row?.name !== profile.name) throw new Error('name not merged into vaults list');
  console.log('profile persisted and merged into /api/vaults:', row.name);
  console.log('\n✅ vault-profile metadata (signature-gated) works end-to-end');
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); process.exit(1); });
