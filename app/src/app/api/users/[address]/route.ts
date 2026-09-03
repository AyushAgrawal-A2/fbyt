import { NextRequest, NextResponse } from 'next/server';
import { getUser } from '@/lib/users';

export const dynamic = 'force-dynamic';

/** GET /api/users/[address] — a user's public profile (display name, points, referral count). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const u = await getUser(address);
  if (!u) return NextResponse.json({ user: null });
  return NextResponse.json({ user: { address: u.id, displayName: u.displayName, bio: u.bio, points: u.points, referralCount: u.referralCount } });
}
