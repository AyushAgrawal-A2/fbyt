'use client';

import { formatMicroUsd } from '@/lib/format';

type Point = { t: number; navMicroUsd: string; raisedMicroUsd: string; pnlBps: number };

/** A dependency-free SVG sparkline of a vault's NAV over time (from the indexer's snapshots). */
export function NavChart({ series }: { series: Point[] }) {
  if (series.length < 2) {
    return <p className="text-sm opacity-50">Not enough history yet — run <code>pnpm indexer</code> to record NAV over time.</p>;
  }
  const W = 480, H = 120, pad = 6;
  const navs = series.map((p) => Number(BigInt(p.navMicroUsd)));
  const min = Math.min(...navs), max = Math.max(...navs);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (series.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const line = navs.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(series.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
  const last = series[series.length - 1];
  const up = last.pnlBps >= 0;
  const stroke = up ? '#34d399' : '#f87171';

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-lg font-semibold">{formatMicroUsd(BigInt(last.navMicroUsd))}</span>
        <span className={`text-sm ${up ? 'text-emerald-400' : 'text-red-400'}`}>
          {up ? '+' : ''}{(last.pnlBps / 100).toFixed(2)}%
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" role="img" aria-label="NAV over time">
        <path d={area} fill={stroke} fillOpacity="0.08" />
        <path d={line} fill="none" stroke={stroke} strokeWidth="1.5" />
      </svg>
      <div className="mt-1 flex justify-between text-xs opacity-40">
        <span>{new Date(series[0].t).toLocaleString()}</span>
        <span>{new Date(last.t).toLocaleString()}</span>
      </div>
    </div>
  );
}
