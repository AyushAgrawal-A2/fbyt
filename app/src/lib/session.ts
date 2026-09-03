import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

const DEFAULT_SECRET = 'dev-only-secret-change-me';
export const SESSION_COOKIE = 'fbyt_session';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * The HMAC secret for session cookies. In production a real secret is mandatory — the app refuses to
 * mint or accept sessions with the dev default, so a leaked default can't be used to forge cookies.
 */
function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s === DEFAULT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET must be set to a strong, non-default value in production');
    }
    return DEFAULT_SECRET;
  }
  return s;
}

function mac(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('hex');
}

/** The signed session cookie value: `address.issuedAt.mac`, bound to a strong secret. */
export function signSession(address: string): string {
  const issuedAt = Date.now();
  const payload = `${address}.${issuedAt}`;
  return `${payload}.${mac(payload)}`;
}

/** Verify a session cookie: checks the HMAC and that it hasn't expired. Returns the address, or null. */
export function verifySession(value: string | undefined): string | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [address, issuedAtStr, sig] = parts;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > SESSION_MAX_AGE_MS) return null;
  const expected = mac(`${address}.${issuedAt}`);
  try {
    if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return address;
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
