'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { shortAddress } from '@/lib/format';

type Launch = { id: string; name: string; symbol: string; description: string; imageUrl: string; launchAt: number; createdBy: string; votes: number };

export default function LaunchesPage() {
  const { data, mutate } = useSWR('launches', () => fetch('/api/launches').then((r) => r.json()).then((j) => j.launches as Launch[]));
  const [form, setForm] = useState({ name: '', symbol: '', description: '', launchAt: '' });
  const [imageUrl, setImageUrl] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
    const up = await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl }) });
    const j = await up.json();
    if (up.ok) setImageUrl(j.url); else setMsg(j.error ?? 'upload failed');
  }
  async function create() {
    setMsg(null);
    const res = await fetch('/api/launches', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...form, imageUrl, launchAt: form.launchAt ? new Date(form.launchAt).getTime() : Date.now() }),
    });
    const j = await res.json();
    if (!res.ok) { setMsg(j.error ?? 'failed'); return; }
    setForm({ name: '', symbol: '', description: '', launchAt: '' }); setImageUrl('');
    await mutate();
  }
  async function vote(id: string) {
    await fetch(`/api/launches/${id}/vote`, { method: 'POST' });
    await mutate();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Token launches</h1>

      <section className="card p-5">
        <h2 className="mb-3 font-semibold">Submit a launch</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="input" placeholder="name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <input className="input" placeholder="symbol" value={form.symbol} onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value }))} />
          <input className="input" type="datetime-local" value={form.launchAt} onChange={(e) => setForm((f) => ({ ...f, launchAt: e.target.value }))} />
          <input className="input" type="file" accept="image/*" onChange={onFile} />
        </div>
        <textarea className="input mt-2 min-h-16" placeholder="description" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        {imageUrl ? <img src={imageUrl} alt="" className="mt-2 h-16 w-16 rounded object-cover" /> : null}
        <button className="btn mt-3" disabled={!form.name || !form.symbol} onClick={create}>Submit (sign in required)</button>
        {msg ? <p className="mt-2 text-xs opacity-60">{msg}</p> : null}
      </section>

      {!data ? (
        <div className="opacity-60">Loading…</div>
      ) : data.length === 0 ? (
        <div className="card p-6 text-sm opacity-70">No launches yet.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.map((l) => (
            <div key={l.id} className="card flex gap-4 p-4">
              {l.imageUrl ? <img src={l.imageUrl} alt="" className="h-14 w-14 rounded object-cover" /> : <div className="h-14 w-14 rounded bg-[#1a1f2b]" />}
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{l.name} <span className="opacity-50">${l.symbol}</span></span>
                  <button className="text-xs text-[#3b82f6]" onClick={() => vote(l.id)}>▲ {l.votes}</button>
                </div>
                {l.description ? <p className="mt-1 text-sm opacity-70">{l.description}</p> : null}
                <p className="mt-1 text-xs opacity-40">
                  {new Date(l.launchAt).toLocaleString()} · by {shortAddress(l.createdBy, 4, 4)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
