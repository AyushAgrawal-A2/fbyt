import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-only-secret-change-me';
export const SESSION_COOKIE = 'fbyt_session';

/** The HMAC-signed session cookie value binding a wallet address. */
export function signSession(address: string): string {
  const mac = createHmac('sha256', SESSION_SECRET).update(address).digest('hex');
  return `${address}.${mac}`;
}

/** Verify a `${address}.${mac}` cookie value and return the address, or null. */
export function verifySession(value: string | undefined): string | null {
  if (!value) return null;
  const i = value.lastIndexOf('.');
  if (i < 0) return null;
  const address = value.slice(0, i);
  const mac = value.slice(i + 1);
  const expected = createHmac('sha256', SESSION_SECRET).update(address).digest('hex');
  try {
    if (mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return address;
  } catch {
    /* fall through */
  }
  return null;
}

/** The signed-in wallet address for the current request, or null. */
export async function currentUser(): Promise<string | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}
