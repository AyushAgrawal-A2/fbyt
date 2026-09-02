import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';

// GET /api/auth/nonce — entropy the client folds into the Sign-In-With-Solana message.
export function GET() {
  return NextResponse.json({ nonce: randomBytes(16).toString('hex') });
}
