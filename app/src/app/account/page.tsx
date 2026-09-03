'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { client } from '@/app/providers';
import { shortAddress } from '@/lib/format';

type User = { address: string; displayName: string; bio: string; points: number; referredBy: string | null; referralCount: number; termsAcceptedAt: number | null };

export default function AccountPage() {
  const connected = useConnectedWallet(client);
  const { data, mutate, error } = useSWR('users-me', () =>
    fetch('/api/users/me').then((r) => (r.ok ? r.json().then((j) => j.user as User) : null)),
  );
  const [form, setForm] = useState({ displayName: '', bio: '' });
  const [referral, setReferral] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data) setForm({ displayName: data.displayName ?? '', bio: data.bio ?? '' });
  }, [data]);

  async function put(body: Record<string, unknown>) {
    setMsg(null);
    const res = await fetch('/api/users/me', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!res.ok) { setMsg(j.error ?? 'failed'); return; }
    await mutate();
    setMsg('saved');
  }

  if (!connected) return <div className="card p-6">Connect a wallet to view your account.</div>;
  if (error || (!data && data !== null)) return <div className="opacity-60">Loading…</div>;
  if (data === null)
    return <div className="card p-6 text-sm opacity-70">Sign in (top-right) to create your account.</div>;

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-bold">Account</h1>

      <section className="card p-5">
        <h2 className="mb-3 font-semibold">Profile</h2>
        <label className="mb-2 block">
          <span className="mb-1 block text-xs opacity-60">Display name</span>
          <input className="input" value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs opacity-60">Bio</span>
          <textarea className="input min-h-20" value={form.bio} onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))} />
        </label>
        <button className="btn mt-3" onClick={() => put(form)}>Save profile</button>
      </section>

      <section className="card p-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs opacity-50">Points</div>
            <div className="text-2xl font-bold">{data.points}</div>
          </div>
          <div className="text-right text-sm opacity-70">
            <div>{data.referralCount} referrals</div>
            <div>{data.termsAcceptedAt ? 'terms accepted' : 'terms not accepted'}</div>
          </div>
        </div>
        {!data.termsAcceptedAt ? (
          <button className="btn mt-3" onClick={() => put({ acceptTerms: true })}>Accept terms (+100 points)</button>
        ) : null}
      </section>

      <section className="card p-5">
        <h2 className="mb-1 font-semibold">Referrals</h2>
        <p className="mb-3 text-sm opacity-60">Share your code; you earn points when someone signs up with it.</p>
        <div className="mb-3 text-sm">
          <span className="opacity-60">Your code:</span> <span className="font-mono">{data.address}</span>
        </div>
        {data.referredBy ? (
          <p className="text-sm opacity-60">Referred by {shortAddress(data.referredBy, 5, 5)}.</p>
        ) : (
          <div className="flex gap-2">
            <input className="input font-mono" placeholder="referrer address" value={referral} onChange={(e) => setReferral(e.target.value)} />
            <button className="btn" disabled={!referral} onClick={() => put({ referralCode: referral })}>Apply</button>
          </div>
        )}
      </section>

      {msg ? <p className="text-xs opacity-60">{msg}</p> : null}
    </div>
  );
}
