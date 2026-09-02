'use client';

import React from 'react';
import { createClient } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { walletSigner } from '@solana/kit-plugin-wallet';
import { ClientProvider } from '@solana/react';
import { RPC_URL, WALLET_CHAIN } from '@/lib/config';

/**
 * One wallet-backed Kit client for the whole app. The connected wallet fills the payer + identity
 * roles; `solanaRpc` bundles RPC, subscriptions, and transaction planning/sending against the surfnet.
 */
export const client = createClient()
  .use(walletSigner({ chain: WALLET_CHAIN }))
  .use(solanaRpc({ rpcUrl: RPC_URL }));

/** Exported so every `useClient<AppClient>()` is fully typed (rpc, wallet, sendTransaction, …). */
export type AppClient = Awaited<typeof client>;

export function Providers({ children }: { children: React.ReactNode }) {
  return <ClientProvider client={client}>{children}</ClientProvider>;
}
