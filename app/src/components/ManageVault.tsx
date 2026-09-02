'use client';

import { useState } from 'react';
import {
  address,
  AccountRole,
  type Address,
  type AccountMeta,
} from '@solana/kit';
import { useAction } from '@solana/react';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import useSWR from 'swr';
import {
  fetchMaybeVaultPool,
  fetchMaybeAdminPool,
  fetchMaybeOraclePool,
  findAdminPoolPda,
  getSetTradingDelegateInstruction,
  getRevokeTradingDelegateInstruction,
  getSwapInstruction,
} from '@/generated';
import { client } from '@/app/providers';
import { shortAddress } from '@/lib/format';
import {
  FBYT_PROGRAM_ID,
  JUPITER_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@/lib/config';
import {
  ata,
  assetRegistryAddress,
  canonicalPriceAccount,
  demoOutMint,
  demoOutPriceAccount,
  feedId32,
  jupiterPoolPda,
  oraclePoolAddress,
} from '@/lib/program';

const DEFAULT_DELEGATE = '11111111111111111111111111111111';

const le = (v: bigint, n: number) => {
  const out = new Uint8Array(n);
  let x = v;
  for (let i = 0; i < n; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};

export function ManageVault({ address: vaultAddress }: { address: string }) {
  const vaultAddr = vaultAddress as Address;
  const connected = useConnectedWallet(client);
  const { data: vault, mutate } = useSWR(['vault', vaultAddress], () =>
    fetchMaybeVaultPool(client.rpc, vaultAddr),
  );
  const [delegate, setDelegate] = useState('');
  const [tradeIn, setTradeIn] = useState('');
  const [tradeOut, setTradeOut] = useState('');
  const [advanceMsg, setAdvanceMsg] = useState<string | null>(null);

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

  // Trade the vault's base token into the demo output asset via the jupiter-mock (localnet). The route
  // is the 7 accounts the mock consumes; `data` is [input_amount, output_amount] little-endian. The
  // on-chain `swap` values both legs against their oracles and rejects trades outside max slippage.
  const tradeAction = useAction(async (signal: AbortSignal, inRaw: string, outRaw: string) => {
    if (!connected?.signer || !vault?.exists) throw new Error('Connect the manager wallet');
    const d = vault.data;
    const [adminPoolAddr] = await findAdminPoolPda({ programAddress: FBYT_PROGRAM_ID });
    const admin = await fetchMaybeAdminPool(client.rpc, adminPoolAddr);
    if (!admin.exists) throw new Error('Admin pool missing');
    const outMint = await demoOutMint();
    const baseOracle = await oraclePoolAddress(d.adminPool, d.tokenMint);
    const outOracle = await oraclePoolAddress(d.adminPool, outMint);
    const baseOraclePool = await fetchMaybeOraclePool(client.rpc, baseOracle);
    if (!baseOraclePool.exists) throw new Error('Base oracle missing');
    const basePrice = await canonicalPriceAccount(feedId32(baseOraclePool.data.feedId));
    const outPrice = await demoOutPriceAccount();
    const assetRegistry = await assetRegistryAddress(vaultAddr);
    const poolPda = await jupiterPoolPda();
    const vaultInput = await ata(vaultAddr, d.tokenMint);
    const vaultOutput = await ata(vaultAddr, outMint);
    const inputSink = await ata(poolPda, d.tokenMint);
    const outputSource = await ata(poolPda, outMint);

    const data = new Uint8Array(16);
    data.set(le(BigInt(inRaw), 8), 0);
    data.set(le(BigInt(outRaw), 8), 8);
    const base = getSwapInstruction({
      adminPool: d.adminPool,
      admin: admin.data.admin,
      trader: connected.signer,
      tokenMint: d.tokenMint,
      vaultPool: vaultAddr,
      assetRegistry,
      inputMint: d.tokenMint,
      inputMintProgram: TOKEN_PROGRAM_ID,
      outputMint: outMint,
      outputMintProgram: TOKEN_PROGRAM_ID,
      vaultInputTokenAccount: vaultInput,
      vaultOutputTokenAccount: vaultOutput,
      oraclePoolFrom: baseOracle,
      oraclePoolTo: outOracle,
      inputPriceUpdate: basePrice,
      outputPriceUpdate: outPrice,
      jupiterProgram: JUPITER_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      data,
    });
    const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });
    const w = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });
    const route = [
      ro(TOKEN_PROGRAM_ID),
      w(vaultInput),
      w(inputSink),
      w(outputSource),
      w(vaultOutput),
      ro(vaultAddr),
      ro(poolPda),
    ];
    const res = await client.sendTransaction(
      [{ programAddress: base.programAddress, accounts: [...base.accounts, ...route] as AccountMeta[], data: base.data }],
      { abortSignal: signal },
    );
    await mutate();
    return String(res.context.signature);
  });

  async function advanceToTrading() {
    setAdvanceMsg('Advancing…');
    try {
      const res = await fetch('/api/dev/advance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vault: vaultAddress }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'advance failed');
      setAdvanceMsg(`Clock now past fundraise (t=${j.advancedTo}). Trading open.`);
      await mutate();
    } catch (e) {
      setAdvanceMsg(e instanceof Error ? e.message : String(e));
    }
  }

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

      <section className="card p-5">
        <h2 className="mb-1 font-semibold">Trade (Jupiter)</h2>
        <p className="mb-3 text-sm opacity-60">
          <code>swap</code> CPIs into Jupiter to trade the vault’s base token for another asset, valuing
          both legs against their oracles. Trading only opens once the vault is past its fundraise. On
          localnet the trade runs through the bundled <code>jupiter-mock</code> against the seeded demo
          output asset; amounts are base units and a fair trade at the seeded prices is{' '}
          <span className="font-mono">out ≈ in × 1.5</span>.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <input
            className="input font-mono"
            placeholder="input amount"
            value={tradeIn}
            onChange={(e) => setTradeIn(e.target.value)}
            inputMode="numeric"
          />
          <input
            className="input font-mono"
            placeholder="output amount"
            value={tradeOut}
            onChange={(e) => setTradeOut(e.target.value)}
            inputMode="numeric"
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            className="btn"
            disabled={!isManager || tradeAction.isRunning || !tradeIn || !tradeOut}
            onClick={() => tradeAction.dispatch(tradeIn, tradeOut)}
          >
            {tradeAction.isRunning ? 'Trading…' : 'Trade'}
          </button>
          <button className="btn btn-ghost text-xs" onClick={advanceToTrading}>
            Advance to trading (localnet)
          </button>
        </div>
        {tradeAction.error ? (
          <p className="mt-2 text-xs text-red-400">{String(tradeAction.error)}</p>
        ) : tradeAction.data ? (
          <p className="mt-2 text-xs text-emerald-400">
            Traded — {shortAddress(String(tradeAction.data), 6, 6)}
          </p>
        ) : null}
        {advanceMsg ? <p className="mt-2 text-xs opacity-60">{advanceMsg}</p> : null}
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
