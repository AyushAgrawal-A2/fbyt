import { NextRequest, NextResponse } from 'next/server';
import { RPC_URL } from '@/lib/config';
import { computeNav } from '@/lib/nav';

export const dynamic = 'force-dynamic';

/** GET /api/vaults/[address]/nav — live NAV, per-asset holdings, and PnL vs capital raised. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const nav = await computeNav(address, RPC_URL);
    if (!nav) return NextResponse.json({ error: 'no vault at this address' }, { status: 404 });
    return NextResponse.json(nav);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
