import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { dbPut } from '@/lib/db';

export const dynamic = 'force-dynamic';

const NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * GET /api/auth/nonce — issue a one-time nonce for Sign-In-With-Solana. It is persisted with a short
 * TTL and consumed on verify, so a signature can't be replayed.
 */
export async function GET() {
  const nonce = randomBytes(16).toString('hex');
  await dbPut('authNonces', { id: nonce, exp: Date.now() + NONCE_TTL_MS });
  return NextResponse.json({ nonce });
}
