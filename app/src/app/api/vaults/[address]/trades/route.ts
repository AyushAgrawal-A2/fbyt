import { NextRequest, NextResponse } from 'next/server';
import { RPC_URL } from '@/lib/config';
import { fetchTrades } from '@/lib/trades';

export const dynamic = 'force-dynamic';

/** GET /api/vaults/[address]/trades — the vault's decoded swap history (most recent first). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const trades = await fetchTrades(address, RPC_URL);
    return NextResponse.json({ trades });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
