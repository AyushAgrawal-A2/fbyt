import { NextRequest, NextResponse } from 'next/server';
import { createPublicKey, verify } from 'node:crypto';
import { getAddressEncoder } from '@solana/kit';
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, signSession } from '@/lib/session';
import { dbGet, dbDelete } from '@/lib/db';
import { guard } from '@/lib/guard';

// DER/SPKI prefix for an Ed25519 public key (RFC 8410).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * POST /api/auth/verify  { address, message, signature }  (message + signature base64)
 * Verifies the wallet's Ed25519 signature over the SIWS message, consumes the one-time nonce, and
 * issues the HMAC-signed session cookie. Rate-limited and same-origin-checked.
 */
export async function POST(req: NextRequest) {
  const blocked = guard(req, { limit: 10, windowMs: 60_000 });
  if (blocked) return blocked;
  try {
    const { address, message, signature } = await req.json();
    if (!address || !message || !signature) {
      return NextResponse.json({ error: 'address, message, signature required' }, { status: 400 });
    }
    const text = Buffer.from(message, 'base64').toString('utf8');
    const nonce = text.match(/Nonce:\s*([0-9a-f]+)/)?.[1];
    if (!nonce) return NextResponse.json({ error: 'message missing nonce' }, { status: 400 });
    const rec = await dbGet<{ id: string; exp: number }>('authNonces', nonce);
    if (!rec || rec.exp < Date.now()) return NextResponse.json({ error: 'stale or unknown nonce' }, { status: 401 });
    await dbDelete('authNonces', nonce); // one-time

    const pubkey = Buffer.from(getAddressEncoder().encode(address));
    const spki = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pubkey]), format: 'der', type: 'spki' });
    const ok = verify(null, Buffer.from(message, 'base64'), spki, Buffer.from(signature, 'base64'));
    if (!ok) return NextResponse.json({ error: 'bad signature' }, { status: 401 });

    const res = NextResponse.json({ ok: true, address });
    res.cookies.set(SESSION_COOKIE, signSession(address), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS / 1000,
    });
    return res;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
