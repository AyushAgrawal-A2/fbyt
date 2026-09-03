'use client';

import { use } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { formatMicroUsd, shortAddress, vaultStatusLabel } from '@/lib/format';

type Profile = { address: string; displayName: string; bio: string; points: number };
type VaultRow = { address: string; name: string; status: number; raisedAmountUsd: string; investorCount: string };

export default function ManagerPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const { data } = useSWR(['manager', address], () =>
    fetch(`/api/managers/${address}`).then((r) => r.json() as Promise<{ profile: Profile; vaults: VaultRow[] }>),
  );

  if (!data) return <div className="opacity-60">Loading…</div>;
  const { profile, vaults } = data;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{profile.displayName || shortAddress(address, 6, 6)}</h1>
        <p className="font-mono text-xs opacity-50">{address}</p>
        {profile.bio ? <p className="mt-2 text-sm opacity-80">{profile.bio}</p> : null}
        <p className="mt-1 text-sm opacity-60">{profile.points} points · {vaults.length} vault{vaults.length === 1 ? '' : 's'}</p>
      </div>

      {vaults.length === 0 ? (
        <div className="card p-6 text-sm opacity-70">No vaults yet.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {vaults.map((v) => (
            <Link key={v.address} href={`/vaults/${v.address}`} className="card block p-4 hover:border-[#3b82f6]">
              <div className="flex items-center justify-between">
                <span className="font-medium">{v.name || shortAddress(v.address, 6, 6)}</span>
                <span className="rounded bg-[#1a1f2b] px-2 py-0.5 text-xs opacity-80">{vaultStatusLabel(v.status)}</span>
              </div>
              <div className="mt-2 text-sm opacity-70">
                {formatMicroUsd(BigInt(v.raisedAmountUsd))} raised · {v.investorCount} investors
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
