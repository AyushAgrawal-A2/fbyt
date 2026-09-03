import { NextRequest, NextResponse } from 'next/server';
import { serverRpc } from '@/lib/rpc-server';
import { fetchVaults } from '@/lib/vaults';
import { getAllMetadata } from '@/lib/metadataStore';
import { getUser } from '@/lib/users';

export const dynamic = 'force-dynamic';

/** GET /api/managers/[address] — a manager's public profile plus the vaults they run. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const [vaults, meta, user] = await Promise.all([fetchVaults(serverRpc()), getAllMetadata(), getUser(address)]);
    const managed = vaults
      .filter((v) => String(v.data.moneyManager) === address)
      .map((v) => ({
        address: v.address,
        name: meta[v.address]?.name ?? '',
        status: v.data.vaultPoolStatus,
        raisedAmountUsd: v.data.raisedAmountUsd.toString(),
        investorCount: v.data.investorCount.toString(),
      }));
    return NextResponse.json({
      profile: user ? { address: user.id, displayName: user.displayName, bio: user.bio, points: user.points } : { address, displayName: '', bio: '', points: 0 },
      vaults: managed,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
