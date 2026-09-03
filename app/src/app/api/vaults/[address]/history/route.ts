import { NextRequest, NextResponse } from 'next/server';
import { dbQuery } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Snapshot = { id: string; vault: string; t: number; navMicroUsd: string; raisedMicroUsd: string; pnlBps: number };

/**
 * GET /api/vaults/[address]/history — the vault's NAV/PnL time series, as recorded by the indexer.
 * Empty until the indexer (`pnpm indexer`) has taken snapshots.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const series = (await dbQuery<Snapshot>('navSnapshots', (s) => s.vault === address)).sort((a, b) => a.t - b.t);
  return NextResponse.json({
    series: series.map((s) => ({ t: s.t, navMicroUsd: s.navMicroUsd, raisedMicroUsd: s.raisedMicroUsd, pnlBps: s.pnlBps })),
  });
}
