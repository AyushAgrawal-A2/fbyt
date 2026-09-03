'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { shortAddress } from '@/lib/format';

type Bot = {
  id: string;
  enabled: boolean;
  runCount: number;
  delegate: string;
  strategy: { type: string } & Record<string, unknown>;
};

/**
 * Manager UI for the vault's automation bots. Registers/enables/halts DCA/grid/rebalance bots (stored
 * off-chain, run by the keeper). Requires a signed-in session and a trading delegate set on the vault.
 */
export function BotsPanel({ vault, baseMint, outMint }: { vault: string; baseMint: string; outMint: string }) {
  const { data, mutate } = useSWR(['bots', vault], () =>
    fetch(`/api/bots?vault=${vault}`).then((r) => r.json()).then((j) => j.bots as Bot[]),
  );
  const [type, setType] = useState<'dca' | 'rebalance' | 'grid'>('dca');
  const [amount, setAmount] = useState('5000000');
  const [target, setTarget] = useState('6000');
  const [step, setStep] = useState('200');
  const [msg, setMsg] = useState<string | null>(null);

  function strategy() {
    if (type === 'dca') return { type, inputMint: baseMint, outputMint: outMint, inputAmount: amount, maxSlippageBps: 100 };
    if (type === 'rebalance') return { type, assetA: baseMint, assetB: outMint, targetABps: Number(target), maxTradeAmount: amount, maxSlippageBps: 100 };
    return { type, baseMint, quoteMint: outMint, stepBps: Number(step), tradeAmount: amount, maxSlippageBps: 100 };
  }

  async function create() {
    setMsg(null);
    const res = await fetch('/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vault, strategy: strategy() }) });
    const j = await res.json();
    if (!res.ok) { setMsg(j.error ?? 'failed'); return; }
    setMsg('bot created');
    await mutate();
  }
  async function toggle(b: Bot) {
    await fetch(`/api/bots/${b.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !b.enabled }) });
    await mutate();
  }
  async function remove(b: Bot) {
    await fetch(`/api/bots/${b.id}`, { method: 'DELETE' });
    await mutate();
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 font-semibold">Automation bots</h2>
      <p className="mb-3 text-sm opacity-60">
        Register DCA / rebalance / grid bots. They trade via the vault&rsquo;s trading delegate and run
        in the keeper (<code>pnpm keeper --db</code>). Requires a signed-in session and a delegate set above.
      </p>

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <select className="input" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="dca">DCA</option>
          <option value="rebalance">Rebalance</option>
          <option value="grid">Grid</option>
        </select>
        <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="amount (base units)" />
        {type === 'rebalance' ? (
          <input className="input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="target A (bps)" />
        ) : type === 'grid' ? (
          <input className="input" value={step} onChange={(e) => setStep(e.target.value)} placeholder="step (bps)" />
        ) : (
          <div className="text-xs opacity-40 self-center">base → out</div>
        )}
        <button className="btn" onClick={create}>Create bot</button>
      </div>
      {msg ? <p className="mb-2 text-xs opacity-60">{msg}</p> : null}

      {!data ? (
        <p className="text-sm opacity-50">Loading…</p>
      ) : data.length === 0 ? (
        <p className="text-sm opacity-50">No bots yet.</p>
      ) : (
        <div className="divide-y divide-[#1e2230]">
          {data.map((b) => (
            <div key={b.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <span className="font-medium capitalize">{b.strategy.type}</span>
                <span className="ml-2 text-xs opacity-50">delegate {shortAddress(b.delegate, 4, 4)} · {b.runCount} runs</span>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs ${b.enabled ? 'text-emerald-400' : 'opacity-40'}`}>{b.enabled ? 'enabled' : 'halted'}</span>
                <button className="text-xs text-[#3b82f6]" onClick={() => toggle(b)}>{b.enabled ? 'Halt' : 'Enable'}</button>
                <button className="text-xs text-red-400" onClick={() => remove(b)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
