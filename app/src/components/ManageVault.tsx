'use client';

import { useEffect, useState } from 'react';
import {
  address,
  AccountRole,
  type Address,
  type AccountMeta,
  type Instruction,
} from '@solana/kit';
import { useAction } from '@solana/react';
import { useConnectedWallet, useSignMessage } from '@solana/kit-plugin-wallet/react';
import useSWR from 'swr';
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import {
  fetchMaybeVaultPool,
  fetchMaybeAdminPool,
  fetchMaybeOraclePool,
  fetchMaybeAssetRegistry,
  findAdminPoolPda,
  getSetTradingDelegateInstruction,
  getRevokeTradingDelegateInstruction,
  getSwapInstruction,
  getWithdrawMoneyManagementFeeInstructionAsync,
  getCloseVaultInstructionAsync,
} from '@/generated';
import { client } from '@/app/providers';
import { shortAddress } from '@/lib/format';
import {
  FBYT_PROGRAM_ID,
  JUPITER_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  USE_REAL_JUPITER,
} from '@/lib/config';
import { TRADABLE_ASSETS, assetByMint } from '@/lib/assets';
import { fetchJupiterRoute } from '@/lib/jupiterRoute';
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
import { BotsPanel } from '@/components/BotsPanel';

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
  const [jupOut, setJupOut] = useState(TRADABLE_ASSETS[0]?.mint ?? '');
  const [jupIn, setJupIn] = useState('');
  const [advanceMsg, setAdvanceMsg] = useState<string | null>(null);
  const signMessage = useSignMessage(client);
  const [profile, setProfile] = useState({ name: '', description: '', strategy: '' });
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const { data: meta } = useSWR(['metadata', vaultAddress], () =>
    fetch(`/api/vaults/${vaultAddress}/metadata`).then((r) => r.json()).then((j) => j.metadata as typeof profile | null),
  );
  const { data: outMint } = useSWR(['demoOutMint'], () => demoOutMint().then(String));
  useEffect(() => {
    if (meta) setProfile({ name: meta.name ?? '', description: meta.description ?? '', strategy: meta.strategy ?? '' });
  }, [meta]);

  const { data: adminPool } = useSWR(['adminPool'], async () => {
    const [a] = await findAdminPoolPda({ programAddress: FBYT_PROGRAM_ID });
    return fetchMaybeAdminPool(client.rpc, a);
  });

  const isManager =
    vault?.exists && connected && String(vault.data.moneyManager) === connected.account.address;
  const isOperator =
    adminPool?.exists && connected && String(adminPool.data.operator) === connected.account.address;

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

  // Real Jupiter (devnet/mainnet): fetch a quote + route, adapt it (jupiterRoute.ts), and pass the
  // route's data + accounts to the on-chain swap. The output amount, price impact and fees come from
  // Jupiter's quote — not an oracle mid — and both assets' oracles must already be onboarded.
  const jupiterTradeAction = useAction(async (signal: AbortSignal, outputMintStr: string, inRaw: string) => {
    if (!connected?.signer || !vault?.exists) throw new Error('Connect the manager wallet');
    const d = vault.data;
    const asset = assetByMint(outputMintStr);
    if (!asset) throw new Error('unknown output asset');
    const [adminPoolAddr] = await findAdminPoolPda({ programAddress: FBYT_PROGRAM_ID });
    const admin = await fetchMaybeAdminPool(client.rpc, adminPoolAddr);
    if (!admin.exists) throw new Error('Admin pool missing');
    const outputMint = address(asset.mint);
    const outputProgram = address(asset.tokenProgram);
    const baseOracle = await oraclePoolAddress(d.adminPool, d.tokenMint);
    const outOracle = await oraclePoolAddress(d.adminPool, outputMint);
    const [basePool, outPool] = await Promise.all([
      fetchMaybeOraclePool(client.rpc, baseOracle),
      fetchMaybeOraclePool(client.rpc, outOracle),
    ]);
    if (!basePool.exists || !outPool.exists) throw new Error('Onboard approved oracles for both assets first (Admin)');
    const basePrice = await canonicalPriceAccount(feedId32(basePool.data.feedId));
    const outPrice = await canonicalPriceAccount(feedId32(outPool.data.feedId));
    const assetRegistry = await assetRegistryAddress(vaultAddr);
    const vaultInput = await ata(vaultAddr, d.tokenMint);
    const vaultOutput = await ata(vaultAddr, outputMint);

    // the real Jupiter route: quote (price impact + fees) -> swap-instructions -> adapted route
    const route = await fetchJupiterRoute(String(d.tokenMint), asset.mint, inRaw, admin.data.maxSlippageBps, String(vaultAddr));
    const base = getSwapInstruction({
      adminPool: d.adminPool, admin: admin.data.admin, trader: connected.signer, tokenMint: d.tokenMint, vaultPool: vaultAddr,
      assetRegistry, inputMint: d.tokenMint, inputMintProgram: TOKEN_PROGRAM_ID, outputMint, outputMintProgram: outputProgram,
      vaultInputTokenAccount: vaultInput, vaultOutputTokenAccount: vaultOutput, oraclePoolFrom: baseOracle, oraclePoolTo: outOracle,
      inputPriceUpdate: basePrice, outputPriceUpdate: outPrice, jupiterProgram: JUPITER_PROGRAM_ID, systemProgram: SYSTEM_PROGRAM_ID,
      data: route.data,
    });
    // ensure the vault's output ATA exists (Token-2022 aware), then the swap with Jupiter's route accounts
    const createOut = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: connected.signer, owner: vaultAddr, mint: outputMint, tokenProgram: outputProgram });
    const swapIx = { programAddress: base.programAddress, accounts: [...base.accounts, ...route.remainingAccounts] as AccountMeta[], data: base.data };
    const res = await client.sendTransaction([createOut, swapIx], { abortSignal: signal });
    await mutate();
    return String(res.context.signature);
  });

  // Operator-only: stream the accrued management fee in kind for every vault asset. Passes a group of
  // 4 `[mint, vault_ata, manager_ata, protocol_ata]` per asset (base mint + everything the vault has
  // traded into, from the asset registry) and idempotently creates the fee-recipient ATAs first.
  const feeAction = useAction(async (signal: AbortSignal) => {
    if (!connected?.signer || !vault?.exists || !adminPool?.exists) throw new Error('Connect the operator wallet');
    const d = vault.data;
    const reg = await fetchMaybeAssetRegistry(client.rpc, await assetRegistryAddress(vaultAddr));
    const registryMints = reg.exists ? reg.data.assetMints.map((m) => String(m)) : [];
    const assetMints = [String(d.tokenMint), ...registryMints].filter((m, i, a) => a.indexOf(m) === i);

    const ixs: Instruction[] = [];
    const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });
    const w = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });
    const remaining: AccountMeta[] = [];
    for (const m of assetMints) {
      const mint = m as Address;
      ixs.push(await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: connected.signer, owner: d.moneyManager, mint }));
      ixs.push(await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: connected.signer, owner: adminPool.data.admin, mint }));
      remaining.push(ro(mint), w(await ata(vaultAddr, mint)), w(await ata(d.moneyManager, mint)), w(await ata(adminPool.data.admin, mint)));
    }
    const base = await getWithdrawMoneyManagementFeeInstructionAsync({
      operator: connected.signer,
      vaultPool: vaultAddr,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
    });
    ixs.push({ programAddress: base.programAddress, accounts: [...base.accounts, ...remaining] as AccountMeta[], data: base.data });

    const res = await client.sendTransaction(ixs, { abortSignal: signal });
    await mutate();
    return String(res.context.signature);
  });

  // Manager-only, past the fundraise: soft-close the vault (status → Closed). The program enforces the
  // timing and rejects a second close.
  const closeAction = useAction(async (signal: AbortSignal) => {
    if (!connected?.signer || !vault?.exists) throw new Error('Connect the manager wallet');
    const ix = await getCloseVaultInstructionAsync({
      moneyManager: connected.signer,
      vaultPool: vaultAddr,
      tokenMint: vault.data.tokenMint,
    });
    const res = await client.sendTransaction([ix], { abortSignal: signal });
    await mutate();
    return String(res.context.signature);
  });

  // Save the off-chain vault profile. The manager signs a canonical, time-bounded message; the API
  // verifies the signature is by the vault's on-chain money manager before storing.
  async function saveProfile() {
    if (!connected?.account) return;
    setProfileMsg('Sign to save…');
    try {
      const issuedAt = Date.now();
      const message = `FBYT vault profile\nvault: ${vaultAddress}\nissued: ${issuedAt}`;
      const sig = await signMessage.dispatchAsync(new TextEncoder().encode(message));
      const signature = btoa(String.fromCharCode(...sig));
      const res = await fetch(`/api/vaults/${vaultAddress}/metadata`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...profile, signer: connected.account.address, signature, issuedAt }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'save failed');
      setProfileMsg('Profile saved.');
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : String(e));
    }
  }

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
        <h2 className="mb-1 font-semibold">Vault profile</h2>
        <p className="mb-3 text-sm opacity-60">
          A public name, strategy, and description for this vault (stored off-chain). Saving requires a
          signature from the manager wallet.
        </p>
        <div className="space-y-2">
          <input className="input" placeholder="name" value={profile.name} disabled={!isManager} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} />
          <input className="input" placeholder="strategy (one line)" value={profile.strategy} disabled={!isManager} onChange={(e) => setProfile((p) => ({ ...p, strategy: e.target.value }))} />
          <textarea className="input min-h-20" placeholder="description" value={profile.description} disabled={!isManager} onChange={(e) => setProfile((p) => ({ ...p, description: e.target.value }))} />
        </div>
        <button className="btn mt-3" disabled={!isManager} onClick={saveProfile}>
          Save profile
        </button>
        {profileMsg ? <p className="mt-2 text-xs opacity-60">{profileMsg}</p> : null}
      </section>

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

      {USE_REAL_JUPITER ? (
        <section className="card p-5">
          <h2 className="mb-1 font-semibold">Trade via Jupiter (real)</h2>
          <p className="mb-3 text-sm opacity-60">
            Routes through real Jupiter — the output amount, price impact and fees come from Jupiter’s
            quote. The target asset must have an admin-approved oracle. Amount is in base-token units.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <select className="input" value={jupOut} onChange={(e) => setJupOut(e.target.value)}>
              {TRADABLE_ASSETS.map((a) => (
                <option key={a.mint} value={a.mint}>
                  {a.symbol} — {a.name.slice(0, 28)}
                </option>
              ))}
            </select>
            <input className="input font-mono" placeholder="input amount (base units)" value={jupIn} onChange={(e) => setJupIn(e.target.value)} inputMode="numeric" />
          </div>
          <button
            className="btn mt-2"
            disabled={!isManager || jupiterTradeAction.isRunning || !jupIn || !jupOut}
            onClick={() => jupiterTradeAction.dispatch(jupOut, jupIn)}
          >
            {jupiterTradeAction.isRunning ? 'Trading…' : 'Trade via Jupiter'}
          </button>
          {jupiterTradeAction.error ? (
            <p className="mt-2 text-xs text-red-400">{String(jupiterTradeAction.error)}</p>
          ) : jupiterTradeAction.data ? (
            <p className="mt-2 text-xs text-emerald-400">Traded — {shortAddress(String(jupiterTradeAction.data), 6, 6)}</p>
          ) : null}
        </section>
      ) : null}

      {isManager && outMint ? (
        <BotsPanel vault={vaultAddress} baseMint={String(vault.data.tokenMint)} outMint={outMint} />
      ) : null}

      <section className="card p-5">
        <h2 className="mb-1 font-semibold">Management fee</h2>
        <p className="mb-3 text-sm opacity-60">
          The accrued fee is streamed in kind and triggered by the protocol <em>operator</em> (not the
          manager) via <code>withdraw_money_management_fee</code>, at most once per{' '}
          <code>mm_withdraw_period</code>, split between the manager and the protocol. The vault must
          have traded and not be dormant.
        </p>
        {isOperator ? (
          <>
            <button
              className="btn"
              disabled={feeAction.isRunning}
              onClick={() => feeAction.dispatch()}
            >
              {feeAction.isRunning ? 'Withdrawing…' : 'Withdraw management fee'}
            </button>
            {feeAction.error ? (
              <p className="mt-2 text-xs text-red-400">{String(feeAction.error)}</p>
            ) : feeAction.data ? (
              <p className="mt-2 text-xs text-emerald-400">
                Streamed — {shortAddress(String(feeAction.data), 6, 6)}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs opacity-50">
            Connect the protocol operator wallet to trigger it.
          </p>
        )}
      </section>

      {isManager ? (
        <section className="card border border-red-500/20 p-5">
          <h2 className="mb-1 font-semibold">Close vault</h2>
          <p className="mb-3 text-sm opacity-60">
            Soft-closes the vault (status → Closed) once the fundraise has ended. Investors can still
            redeem their shares afterwards.
          </p>
          <button
            className="btn btn-ghost text-red-300"
            disabled={closeAction.isRunning || vault.data.vaultPoolStatus === 3}
            onClick={() => closeAction.dispatch()}
          >
            {vault.data.vaultPoolStatus === 3 ? 'Closed' : closeAction.isRunning ? 'Closing…' : 'Close vault'}
          </button>
          {closeAction.error ? (
            <p className="mt-2 text-xs text-red-400">{String(closeAction.error)}</p>
          ) : closeAction.data ? (
            <p className="mt-2 text-xs text-emerald-400">Closed — {shortAddress(String(closeAction.data), 6, 6)}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
