import { NextResponse } from 'next/server';
import { allUsers } from '@/lib/users';

export const dynamic = 'force-dynamic';

/** GET /api/points — the points leaderboard (top users by points). */
export async function GET() {
  const users = (await allUsers())
    .filter((u) => u.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 50)
    .map((u) => ({ address: u.id, displayName: u.displayName, points: u.points, referralCount: u.referralCount }));
  return NextResponse.json({ leaderboard: users });
}
