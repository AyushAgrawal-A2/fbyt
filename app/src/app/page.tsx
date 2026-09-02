import Link from 'next/link';
import { serverRpc } from '@/lib/rpc-server';
import { fetchVaults, sortVaults, type VaultSummary } from '@/lib/vaults';
import { formatBps, formatMicroUsd, shortAddress, vaultStatusLabel } from '@/lib/format';
import { RPC_URL } from '@/lib/config';

export const dynamic = 'force-dynamic';

async function loadVaults(): Promise<{ vaults?: VaultSummary[]; error?: string }> {
  try {
    const vaults = await fetchVaults(serverRpc());
    return { vaults: sortVaults(vaults) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function VaultCard({ v }: { v: VaultSummary }) {
  const d = v.data;
  const status = vaultStatusLabel(d.vaultPoolStatus);
  return (
    <Link href={`/vaults/${v.address}`} className="card block p-4 hover:border-[#3b82f6]">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm">{shortAddress(v.address, 6, 6)}</span>
        <span className="rounded bg-[#1a1f2b] px-2 py-0.5 text-xs opacity-80">{status}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <Stat label="Raised" value={formatMicroUsd(d.raisedAmountUsd)} />
        <Stat label="Shares" value={d.totalShares.toLocaleString()} />
        <Stat label="Investors" value={d.investorCount.toString()} />
        <Stat label="Perf fee" value={formatBps(d.performanceFee)} />
      </div>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs opacity-50">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

export default async function Home() {
  const { vaults, error } = await loadVaults();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Vaults</h1>
        <p className="opacity-60">Manager-run funds, ranked by capital raised.</p>
      </div>

      {error ? (
        <div className="card p-6">
          <p className="font-semibold text-amber-400">Can’t reach the network</p>
          <p className="mt-1 text-sm opacity-70">
            The app talks to <code className="opacity-90">{RPC_URL}</code>. Start the local surfnet and
            bootstrap it:
          </p>
          <pre className="mt-3 overflow-x-auto rounded bg-black/40 p-3 text-xs">
{`# terminal 1
pnpm localnet
# terminal 2
pnpm bootstrap`}
          </pre>
          <p className="mt-2 text-xs opacity-40">{error}</p>
        </div>
      ) : vaults && vaults.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {vaults.map((v) => (
            <VaultCard key={v.address} v={v} />
          ))}
        </div>
      ) : (
        <div className="card p-6">
          <p className="font-semibold">No vaults yet</p>
          <p className="mt-1 text-sm opacity-70">
            Run <code>pnpm bootstrap</code> to seed a demo vault, or{' '}
            <Link href="/create" className="text-[#3b82f6]">
              create one
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  );
}
