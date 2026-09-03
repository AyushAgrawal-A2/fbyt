import { NextRequest, NextResponse } from 'next/server';
import { createSolanaRpc, type Address } from '@solana/kit';
import { RPC_URL } from '@/lib/config';
import { fetchMaybeVaultPool } from '@/generated';
import { currentUser } from '@/lib/session';
import { guard } from '@/lib/guard';
import { dbAll, dbAppend } from '@/lib/db';

export const dynamic = 'force-dynamic';

const DEFAULT_PK = '11111111111111111111111111111111';

type Bot = { id: string; vault: string; owner: string; delegate: string; enabled: boolean; strategy: unknown; createdAt: number; runCount: number; lastRunAt: number | null; deleted?: boolean };

/** GET /api/bots?vault=<addr> — the (non-deleted) bots registered for a vault (public). */
export async function GET(req: NextRequest) {
  const vault = req.nextUrl.searchParams.get('vault');
  const bots = (await dbAll<Bot>('bots')).filter((b) => !b.deleted && (!vault || b.vault === vault));
  return NextResponse.json({ bots });
}

/**
 * POST /api/bots  { vault, strategy }
 * Registers a bot for a vault. Session-gated; the signed-in user must be the vault's on-chain money
 * manager, and the vault must already have a trading delegate set (the key the keeper signs with).
 */
export async function POST(req: NextRequest) {
  const blocked = guard(req, { limit: 20, windowMs: 60_000 });
  if (blocked) return blocked;
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { vault, strategy } = body ?? {};
  if (!vault || !strategy?.type) return NextResponse.json({ error: 'vault and strategy required' }, { status: 400 });

  const rpc = createSolanaRpc(RPC_URL);
  const v = await fetchMaybeVaultPool(rpc, vault as Address);
  if (!v.exists) return NextResponse.json({ error: 'no vault at this address' }, { status: 404 });
  if (String(v.data.moneyManager) !== me) return NextResponse.json({ error: 'not the vault manager' }, { status: 403 });
  const delegate = String(v.data.tradingDelegate);
  if (delegate === DEFAULT_PK) return NextResponse.json({ error: 'set a trading delegate first' }, { status: 400 });

  const id = await dbAppend('bots', { vault, owner: me, delegate, enabled: true, strategy, createdAt: Date.now(), runCount: 0, lastRunAt: null });
  return NextResponse.json({ id });
}
