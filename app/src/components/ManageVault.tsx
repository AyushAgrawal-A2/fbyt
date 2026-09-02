'use client';

import { useState } from 'react';
import { address, type Address } from '@solana/kit';
import { useAction } from '@solana/react';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import useSWR from 'swr';
import {
  fetchMaybeVaultPool,
  getSetTradingDelegateInstruction,
  getRevokeTradingDelegateInstruction,
} from '@/generated';
import { client } from '@/app/providers';
import { shortAddress } from '@/lib/format';

const DEFAULT_DELEGATE = '11111111111111111111111111111111';

export function ManageVault({ address: vaultAddress }: { address: string }) {
  const vaultAddr = vaultAddress as Address;
  const connected = useConnectedWallet(client);
  const { data: vault, mutate } = useSWR(['vault', vaultAddress], () =>
    fetchMaybeVaultPool(client.rpc, vaultAddr),
  );
  const [delegate, setDelegate] = useState('');

  const isManager =
    vault?.exists && connected && String(vault.data.moneyManager) === connected.account.address;

  const setDelegateAction = useAction(async (signal: AbortSignal, value: string) => {
    if (!connected?.signer) throw new Error('Connect the manager wallet');
    const ix = getSetTradingDelegateInstruction({
      vaultPool: vaultAddr,
      moneyManager: connected.signer,
      tradingDelegate: address(value.trim()),
    });
    const res = await client.sendTransaction([ix], { abortSignal: signal });
    await mutate();
    return String(res.context.signature);
  });

  const revokeAction = useAction(async (signal: AbortSignal) => {
    if (!connected?.signer) throw new Error('Connect the manager wallet');
    const ix = getRevokeTradingDelegateInstruction({
      vaultPool: vaultAddr,
      moneyManager: connected.signer,
    });
    const res = await client.sendTransaction([ix], { abortSignal: signal });
    await mutate();
    return String(res.context.signature);
  });

  if (!vault) return <div className="opacity-60">Loading…</div>;
  if (!vault.exists) return <div className="card p-6">No vault at this address.</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-lg">{shortAddress(vaultAddress, 8, 8)}</h1>
        <p className="opacity-60">Manager controls</p>
      </div>

      {!isManager ? (
        <div className="card p-5 text-sm opacity-70">
          Connect the vault’s money-manager wallet (
          {shortAddress(String(vault.data.moneyManager), 5, 5)}) to manage it.
        </div>
      ) : null}

      <section className="card p-5">
        <h2 className="mb-1 font-semibold">Trading delegate</h2>
        <p className="mb-3 text-sm opacity-60">
          A delegate (bot key) may trade the vault but never withdraw. Current:{' '}
          <span className="font-mono">
            {String(vault.data.tradingDelegate) === DEFAULT_DELEGATE
              ? 'none'
              : shortAddress(String(vault.data.tradingDelegate), 5, 5)}
          </span>
        </p>
        <div className="flex gap-2">
          <input
            className="input font-mono"
            placeholder="delegate address"
            value={delegate}
            onChange={(e) => setDelegate(e.target.value)}
          />
          <button
            className="btn"
            disabled={!isManager || setDelegateAction.isRunning || !delegate}
            onClick={() => setDelegateAction.dispatch(delegate)}
          >
            Set
          </button>
          <button
            className="btn btn-ghost"
            disabled={!isManager || revokeAction.isRunning}
            onClick={() => revokeAction.dispatch()}
          >
            Revoke
          </button>
        </div>
        {setDelegateAction.error || revokeAction.error ? (
          <p className="mt-2 text-xs text-red-400">
            {String(setDelegateAction.error ?? revokeAction.error)}
          </p>
        ) : null}
      </section>

      <section className="card p-5 opacity-90">
        <h2 className="mb-1 font-semibold">Trade (Jupiter)</h2>
        <p className="text-sm opacity-60">
          The <code>swap</code> instruction CPIs into Jupiter with the route built off-chain (see{' '}
          <code>/api/jupiter/quote</code>). On a local surfnet, drive it through the bundled
          <code> jupiter-mock</code> program the tests deploy at the Jupiter id. Wiring the browser
          trade flow is the remaining manager-side integration.
        </p>
      </section>

      <section className="card p-5 opacity-90">
        <h2 className="mb-1 font-semibold">Management fee</h2>
        <p className="text-sm opacity-60">
          Fees are streamed in kind and triggered by the protocol <em>operator</em> (not the manager)
          via <code>withdraw_money_management_fee</code>, once per <code>mm_withdraw_period</code>. It
          takes per-asset recipient accounts; the bootstrap operator key can exercise it.
        </p>
      </section>
    </div>
  );
}
