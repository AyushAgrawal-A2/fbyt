import { NextResponse } from 'next/server';
import { serverRpc } from '@/lib/rpc-server';
import { fetchVaults, sortVaults } from '@/lib/vaults';
import { getAllMetadata } from '@/lib/metadataStore';

export const dynamic = 'force-dynamic';

/** GET /api/vaults — the decoded VaultPool list (merged with off-chain profiles), ranked by capital raised. */
export async function GET() {
  try {
    const [vaults, meta] = await Promise.all([
      fetchVaults(serverRpc()).then(sortVaults),
      getAllMetadata(),
    ]);
    const body = vaults.map((v) => ({
      address: v.address,
      name: meta[v.address]?.name ?? '',
      strategy: meta[v.address]?.strategy ?? '',
      status: v.data.vaultPoolStatus,
      tokenMint: String(v.data.tokenMint),
      moneyManager: String(v.data.moneyManager),
      raisedAmountUsd: v.data.raisedAmountUsd.toString(),
      totalShares: v.data.totalShares.toString(),
      investorCount: v.data.investorCount.toString(),
      performanceFeeBps: v.data.performanceFee,
      moneyManagementFeeBps: v.data.moneyManagementYearlyFee,
      createdAt: v.data.createdAt.toString(),
      isOpenEnded: v.data.isOpenEnded,
    }));
    return NextResponse.json({ vaults: body });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
