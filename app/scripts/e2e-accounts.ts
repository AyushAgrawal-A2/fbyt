/**
 * End-to-end check of accounts + points + referrals (needs the Next dev server on :3000). Signs in two
 * users (SIWS), has them accept terms (welcome points), applies a referral A→B, and asserts the points
 * and referral counts, the points leaderboard, and the manager profile endpoint.
 *
 *   pnpm dev  ->  pnpm tsx scripts/e2e-accounts.ts
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAddressDecoder } from '@solana/kit';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const here = dirname(fileURLToPath(import.meta.url));
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
  if (!cookie) throw new Error('no cookie');
  return cookie;
}
const putMe = (cookie: string, body: unknown) => fetch(`${APP_URL}/api/users/me`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }).then((r) => r.json());

async function main() {
  const A = key(join(here, '.keys', 'manager.json'));
  const B = key(join(here, '.keys', 'deployer.json'));
  const ca = await signIn(A);
  const cb = await signIn(B);

  // A accepts terms → +100
  let ua = (await putMe(ca, { displayName: 'Alice', acceptTerms: true })).user;
  if (ua.points !== 100) throw new Error(`A points ${ua.points} != 100`);
  // B accepts terms → +100, then refers A → B +25, A +50
  await putMe(cb, { displayName: 'Bob', acceptTerms: true });
  const refRes = await putMe(cb, { referralCode: A.pub });
  if (refRes.error) throw new Error(`referral failed: ${refRes.error}`);
  const ub = refRes.user;
  if (ub.points !== 125) throw new Error(`B points ${ub.points} != 125`);
  ua = (await (await fetch(`${APP_URL}/api/users/${A.pub}`)).json()).user;
  if (ua.points !== 150) throw new Error(`A points ${ua.points} != 150 after referral`);
  if (ua.referralCount !== 1) throw new Error(`A referralCount ${ua.referralCount} != 1`);
  console.log(`points: Alice=${ua.points} (refs ${ua.referralCount}), Bob=${ub.points}`);

  // a second referral attempt by B is rejected
  const dup = await putMe(cb, { referralCode: A.pub });
  if (!dup.error) throw new Error('duplicate referral was accepted');
  console.log('duplicate referral rejected:', dup.error);

  // leaderboard + manager profile
  const lb = (await (await fetch(`${APP_URL}/api/points`)).json()).leaderboard as Array<{ address: string; points: number }>;
  if (!lb.find((r) => r.address === A.pub && r.points === 150)) throw new Error('A not on leaderboard');
  const mgr = await (await fetch(`${APP_URL}/api/managers/${A.pub}`)).json();
  console.log(`manager profile: ${mgr.profile.displayName}, ${mgr.vaults.length} vault(s)`);

  console.log('\n✅ accounts + points + referrals work end-to-end');
}

main().catch((e) => { console.error('❌', (e as Error)?.message ?? e); process.exit(1); });
