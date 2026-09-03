import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/session';
import { dbAll, dbAppend } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Launch = { id: string; name: string; symbol: string; description: string; imageUrl: string; launchAt: number; createdBy: string; voters: string[]; createdAt: number };

function view(l: Launch) {
  return { id: l.id, name: l.name, symbol: l.symbol, description: l.description, imageUrl: l.imageUrl, launchAt: l.launchAt, createdBy: l.createdBy, votes: l.voters?.length ?? 0 };
}

/** GET /api/launches — upcoming token launches, most-voted first. */
export async function GET() {
  const launches = (await dbAll<Launch>('launches')).sort((a, b) => (b.voters?.length ?? 0) - (a.voters?.length ?? 0)).map(view);
  return NextResponse.json({ launches });
}

/** POST /api/launches  { name, symbol, description?, imageUrl?, launchAt } — create a launch. Session-gated. */
export async function POST(req: NextRequest) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  if (!b.name || !b.symbol) return NextResponse.json({ error: 'name and symbol required' }, { status: 400 });
  const id = await dbAppend('launches', {
    name: String(b.name).slice(0, 60),
    symbol: String(b.symbol).slice(0, 12).toUpperCase(),
    description: String(b.description ?? '').slice(0, 500),
    imageUrl: typeof b.imageUrl === 'string' && b.imageUrl.startsWith('/api/uploads/') ? b.imageUrl : '',
    launchAt: Number(b.launchAt) || Date.now(),
    createdBy: me,
    voters: [],
    createdAt: Date.now(),
  });
  return NextResponse.json({ id });
}
