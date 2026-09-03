import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/session';
import { guard } from '@/lib/guard';
import { dbGet, dbUpdate, dbPut, dbQuery } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Bot = { id: string; vault: string; owner: string; delegate: string; enabled: boolean; strategy: unknown; runCount: number };
type Order = { id: string; botId: string };

/** GET /api/bots/[id] — a bot plus its recent executions (orders). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bot = await dbGet<Bot>('bots', id);
  if (!bot) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const orders = (await dbQuery<Order>('botOrders', (o) => o.botId === id)).slice(-25).reverse();
  return NextResponse.json({ bot, orders });
}

/** PATCH /api/bots/[id]  { enabled } — enable/halt a bot. Session-gated to the owner. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guard(req, { limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const { id } = await params;
  const bot = await dbGet<Bot>('bots', id);
  if (!bot) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (bot.owner !== me) return NextResponse.json({ error: 'not the owner' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const next = await dbUpdate<Bot>('bots', id, { enabled: !!body.enabled });
  return NextResponse.json({ bot: next });
}

/** DELETE /api/bots/[id] — remove a bot. Session-gated to the owner. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guard(req, { limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const { id } = await params;
  const bot = await dbGet<Bot>('bots', id);
  if (!bot) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (bot.owner !== me) return NextResponse.json({ error: 'not the owner' }, { status: 403 });
  await dbUpdate<Bot>('bots', id, { enabled: false });
  // soft-delete: mark disabled + tombstoned so the keeper skips it and it drops from listings
  await dbPut<Bot & { deleted: boolean }>('bots', { ...bot, enabled: false, deleted: true });
  return NextResponse.json({ ok: true });
}
