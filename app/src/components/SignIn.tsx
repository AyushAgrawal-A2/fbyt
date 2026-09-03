'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useConnectedWallet, useSignMessage } from '@solana/kit-plugin-wallet/react';
import { client } from '@/app/providers';
import { shortAddress } from '@/lib/format';

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Sign-In-With-Solana: signs a nonce'd message and exchanges it for a session cookie. */
export function SignIn() {
  const connected = useConnectedWallet(client);
  const signMessage = useSignMessage(client);
  const [busy, setBusy] = useState(false);
  const { data: me, mutate } = useSWR('auth-me', () =>
    fetch('/api/auth/me').then((r) => r.json()).then((j) => j.address as string | null),
  );

  // if the wallet disconnects, drop the stale "signed in" label
  useEffect(() => {
    if (me && connected && me !== connected.account.address) mutate();
  }, [connected, me, mutate]);

  const signedIn = me && connected && me === connected.account.address;

  async function signIn() {
    if (!connected?.account) return;
    setBusy(true);
    try {
      const { nonce } = await fetch('/api/auth/nonce').then((r) => r.json());
      const message = `app.fbyt.io wants you to sign in with your Solana account:\n${connected.account.address}\n\nNonce: ${nonce}`;
      const sig = await signMessage.dispatchAsync(new TextEncoder().encode(message));
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: connected.account.address, message: btoa(message), signature: toB64(sig) }),
      });
      if (res.ok) await mutate();
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    await mutate();
  }

  if (!connected) return null;
  return signedIn ? (
    <button className="text-xs opacity-60 hover:opacity-100" onClick={signOut} title={String(me)}>
      signed in · {shortAddress(String(me), 4, 4)} ✕
    </button>
  ) : (
    <button className="text-xs text-[#3b82f6] hover:underline disabled:opacity-50" disabled={busy} onClick={signIn}>
      {busy ? 'signing…' : 'Sign in'}
    </button>
  );
}
