import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/session';
import { dbGet, dbUpdate } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Launch = { id: string; voters: string[] };

/** POST /api/launches/[id]/vote — upvote a launch (one per user, toggles off). Session-gated. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const { id } = await params;
  const l = await dbGet<Launch>('launches', id);
  if (!l) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const voters = new Set(l.voters ?? []);
  if (voters.has(me)) voters.delete(me);
  else voters.add(me);
  const next = await dbUpdate<Launch>('launches', id, { voters: [...voters] });
  return NextResponse.json({ votes: next.voters.length, voted: voters.has(me) });
}
