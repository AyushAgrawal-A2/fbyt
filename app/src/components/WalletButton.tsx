'use client';

import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useWallets,
  WalletReadyGate,
} from '@solana/kit-plugin-wallet/react';
import { client } from '@/app/providers';
import { shortAddress } from '@/lib/format';

function Inner() {
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const { dispatch: connect } = useConnect(client);
  const { dispatch: disconnect } = useDisconnect(client);

  if (connected) {
    return (
      <button className="btn btn-ghost" onClick={() => disconnect()}>
        {shortAddress(connected.account.address)} · Disconnect
      </button>
    );
  }
  if (wallets.length === 0) {
    return <span className="text-sm opacity-60">No wallet found</span>;
  }
  return (
    <div className="flex gap-2">
      {wallets.map((w) => (
        <button key={w.name} className="btn" onClick={() => connect(w)}>
          Connect {w.name}
        </button>
      ))}
    </div>
  );
}

export function WalletButton() {
  return (
    <WalletReadyGate client={client} fallback={<span className="text-sm opacity-60">Loading…</span>}>
      <Inner />
    </WalletReadyGate>
  );
}
