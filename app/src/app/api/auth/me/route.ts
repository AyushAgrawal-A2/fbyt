import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** GET /api/auth/me — the signed-in wallet address, or null. */
export async function GET() {
  return NextResponse.json({ address: await currentUser() });
}
