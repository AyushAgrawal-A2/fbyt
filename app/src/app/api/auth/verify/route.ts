import { NextRequest, NextResponse } from 'next/server';
import { createHmac, createPublicKey, verify } from 'node:crypto';
import { getAddressEncoder } from '@solana/kit';

const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-only-secret-change-me';
// DER/SPKI prefix for an Ed25519 public key (RFC 8410).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * POST /api/auth/verify  { address, message, signature }  (message + signature base64)
 * Verifies the wallet's Ed25519 signature over the SIWS message and issues an HMAC-signed session
 * cookie bound to the address. Stateless demo auth — no DB.
 */
export async function POST(req: NextRequest) {
  try {
    const { address, message, signature } = await req.json();
    if (!address || !message || !signature) {
      return NextResponse.json({ error: 'address, message, signature required' }, { status: 400 });
    }
    const pubkey = Buffer.from(getAddressEncoder().encode(address));
    const spki = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pubkey]),
      format: 'der',
      type: 'spki',
    });
    const ok = verify(null, Buffer.from(message, 'base64'), spki, Buffer.from(signature, 'base64'));
    if (!ok) return NextResponse.json({ error: 'bad signature' }, { status: 401 });

    const mac = createHmac('sha256', SESSION_SECRET).update(address).digest('hex');
    const res = NextResponse.json({ ok: true, address });
    res.cookies.set('fbyt_session', `${address}.${mac}`, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24,
    });
    return res;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
