'use client';

import useSWR from 'swr';
import Link from 'next/link';
import { shortAddress } from '@/lib/format';

type Row = { address: string; displayName: string; points: number; referralCount: number };

export default function PointsPage() {
  const { data } = useSWR('points', () => fetch('/api/points').then((r) => r.json()).then((j) => j.leaderboard as Row[]));
  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Points leaderboard</h1>
      {!data ? (
        <div className="opacity-60">Loading…</div>
      ) : data.length === 0 ? (
        <div className="card p-6 text-sm opacity-70">No points yet. Sign in and accept terms to get started.</div>
      ) : (
        <div className="card divide-y divide-[#1e2230]">
          {data.map((r, i) => (
            <div key={r.address} className="flex items-center justify-between p-3 text-sm">
              <div className="flex items-center gap-3">
                <span className="w-6 text-right opacity-40">{i + 1}</span>
                <Link href={`/managers/${r.address}`} className="hover:underline">
                  {r.displayName || shortAddress(r.address, 5, 5)}
                </Link>
              </div>
              <div className="flex items-center gap-4">
                <span className="opacity-50">{r.referralCount} refs</span>
                <span className="font-semibold">{r.points}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
