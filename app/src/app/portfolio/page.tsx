'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { type Address } from '@solana/kit';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { fetchAllMaybeInvestorPool } from '@/generated';
import { client } from '@/app/providers';
import { fetchVaults } from '@/lib/vaults';
import { investorPoolAddress } from '@/lib/program';
import { formatMicroUsd, shortAddress } from '@/lib/format';

export default function PortfolioPage() {
  const connected = useConnectedWallet(client);
  const investor = connected?.account.address as Address | undefined;

  const { data, error, isLoading } = useSWR(
    investor ? ['portfolio', investor] : null,
    async () => {
      const vaults = await fetchVaults(client.rpc);
      const ips = await Promise.all(
        vaults.map((v) =>
          investorPoolAddress(investor!, v.data.adminPool, v.address as Address, v.data.tokenMint),
        ),
      );
      const pools = await fetchAllMaybeInvestorPool(client.rpc, ips);
      return vaults
        .map((v, i) => ({ vault: v, pool: pools[i] }))
        .filter((r) => r.pool.exists && r.pool.data.shares > 0n);
    },
  );

  if (!connected) {
    return <div className="card p-6">Connect a wallet to see your positions.</div>;
  }
  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Portfolio</h1>
      {isLoading ? (
        <div className="opacity-60">Loading positions…</div>
      ) : error ? (
        <div className="card p-6 text-sm opacity-70">{String(error)}</div>
      ) : !data || data.length === 0 ? (
        <div className="card p-6 text-sm opacity-70">No positions yet.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.map(({ vault, pool }) => (
            <Link
              key={vault.address}
              href={`/vaults/${vault.address}`}
              className="card block p-4 hover:border-[#3b82f6]"
            >
              <div className="font-mono text-sm">{shortAddress(vault.address, 6, 6)}</div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <div className="text-xs opacity-50">Shares</div>
                  <div>{pool.exists ? pool.data.shares.toLocaleString() : '0'}</div>
                </div>
                <div>
                  <div className="text-xs opacity-50">Vault raised</div>
                  <div>{formatMicroUsd(vault.data.raisedAmountUsd)}</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
