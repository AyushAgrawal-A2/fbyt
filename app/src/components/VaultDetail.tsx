'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { AccountRole, type Address, type AccountMeta, type Instruction } from '@solana/kit';
import { useAction } from '@solana/react';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import {
  fetchMint,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';
import {
  fetchMaybeVaultPool,
  fetchMaybeInvestorPool,
  fetchMaybeAdminPool,
  findAdminPoolPda,
  getCreateInvestorPoolInstructionAsync,
  getDepositTokenFundInstructionAsync,
  getWithdrawTokenFundInstructionAsync,
} from '@/generated';
import { FBYT_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@/lib/config';
import { client } from '@/app/providers';
import {
  ata,
  canonicalPriceAccount,
  feedId32,
  investorPoolAddress,
  oraclePoolAddress,
} from '@/lib/program';
import { fetchMaybeOraclePool } from '@/generated';
import {
  formatBps,
  formatMicroUsd,
  formatTokenAmount,
  formatUnix,
  shortAddress,
  toBaseUnits,
  vaultStatusLabel,
} from '@/lib/format';
import { TOKEN_PROGRAM_ID } from '@/lib/config';

export function VaultDetail({ address }: { address: string }) {
  const vaultAddr = address as Address;
  const connected = useConnectedWallet(client);
  const investor = connected?.account.address as Address | undefined;

  const { data: vault, error, mutate } = useSWR(['vault', address], () =>
    fetchMaybeVaultPool(client.rpc, vaultAddr),
  );

  const { data: meta } = useSWR(['metadata', address], () =>
    fetch(`/api/vaults/${address}/metadata`).then((r) => r.json()).then((j) => j.metadata as { name?: string; description?: string; strategy?: string } | null),
  );

  const mintAddr = vault?.exists ? vault.data.tokenMint : undefined;
  const { data: mint } = useSWR(mintAddr ? ['mint', mintAddr] : null, () =>
    fetchMint(client.rpc, mintAddr!),
  );
  const decimals = mint?.data.decimals ?? 6;

  const { data: position, mutate: mutatePosition } = useSWR(
    vault?.exists && investor ? ['investorPool', address, investor] : null,
    async () => {
      if (!vault?.exists || !investor) return undefined;
      const ip = await investorPoolAddress(
        investor,
        vault.data.adminPool,
        vaultAddr,
        vault.data.tokenMint,
      );
      return fetchMaybeInvestorPool(client.rpc, ip);
    },
  );

  const [amount, setAmount] = useState('');

  const deposit = useAction(async (signal: AbortSignal, human: string) => {
    if (!vault?.exists || !connected?.signer || !investor) throw new Error('Connect a wallet');
    const d = vault.data;
    const signer = connected.signer;
    const oraclePool = await oraclePoolAddress(d.adminPool, d.tokenMint);
    const oracle = await fetchMaybeOraclePool(client.rpc, oraclePool);
    if (!oracle.exists) throw new Error('Vault has no approved oracle');
    const priceUpdate = await canonicalPriceAccount(feedId32(oracle.data.feedId));
    const fromAccount = await ata(investor!, d.tokenMint);
    const investorPool = await investorPoolAddress(investor!, d.adminPool, vaultAddr, d.tokenMint);

    const ixs = [];
    // the vault's base ATA must exist before the first deposit (the program does not init it);
    // create it idempotently so the first depositor bears the one-time rent.
    ixs.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: signer,
        owner: vaultAddr,
        mint: d.tokenMint,
      }),
    );
    if (!position?.exists) {
      ixs.push(
        await getCreateInvestorPoolInstructionAsync({
          investor: signer,
          vaultPool: vaultAddr,
          tokenMint: d.tokenMint,
        }),
      );
    }
    ixs.push(
      await getDepositTokenFundInstructionAsync({
        investor: signer,
        vaultPool: vaultAddr,
        oraclePool,
        fromAccount,
        tokenMint: d.tokenMint,
        priceUpdate,
        tokenProgram: TOKEN_PROGRAM_ID,
        amount: toBaseUnits(human, decimals),
      }),
    );
    const res = await client.sendTransaction(ixs, { abortSignal: signal });
    await Promise.all([mutate(), mutatePosition()]);
    return res.context.signature;
  });

  const redeem = useAction(async (signal: AbortSignal) => {
    if (!vault?.exists || !connected?.signer || !investor) throw new Error('Connect a wallet');
    if (!position?.exists || position.data.shares <= 0n) throw new Error('No shares to redeem');
    const dd = vault.data;
    const signer = connected.signer;
    const shares = position.data.shares;

    const [adminPoolAddr] = await findAdminPoolPda({ programAddress: FBYT_PROGRAM_ID });
    const adminPool = await fetchMaybeAdminPool(client.rpc, adminPoolAddr);
    if (!adminPool.exists) throw new Error('Admin pool missing');
    const oraclePool = await oraclePoolAddress(dd.adminPool, dd.tokenMint);
    const oracle = await fetchMaybeOraclePool(client.rpc, oraclePool);
    if (!oracle.exists) throw new Error('No oracle');
    const priceUpdate = await canonicalPriceAccount(feedId32(oracle.data.feedId));
    const investorPool = await investorPoolAddress(investor, dd.adminPool, vaultAddr, dd.tokenMint);
    const vaultAta = await ata(vaultAddr, dd.tokenMint);
    const investorAta = await ata(investor, dd.tokenMint);
    const mgrFee = await ata(dd.moneyManager, dd.tokenMint);
    const protoFee = await ata(adminPool.data.admin, dd.tokenMint);

    // the manager/protocol fee ATAs must exist; create idempotently (investor pays rent)
    const ixs: Instruction[] = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: dd.moneyManager, mint: dd.tokenMint }),
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: adminPool.data.admin, mint: dd.tokenMint }),
    ];
    const base = await getWithdrawTokenFundInstructionAsync({
      investor: signer,
      moneyManager: dd.moneyManager,
      vaultPool: vaultAddr,
      investorPool,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      shares,
    });
    const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });
    const w = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });
    const group = [ro(oraclePool), ro(priceUpdate), ro(dd.tokenMint), w(vaultAta), w(investorAta), w(mgrFee), w(protoFee)];
    ixs.push({
      programAddress: base.programAddress,
      accounts: [...base.accounts, ...group] as AccountMeta[],
      data: base.data,
    });

    const res = await client.sendTransaction(ixs, { abortSignal: signal });
    await Promise.all([mutate(), mutatePosition()]);
    return res.context.signature;
  });

  if (error) return <Panel title="Can’t load vault">{String(error)}</Panel>;
  if (!vault) return <Panel title="Loading…">Reading vault state…</Panel>;
  if (!vault.exists) return <Panel title="Not found">No VaultPool at this address.</Panel>;

  const d = vault.data;
  return (
    <div className="grid gap-6 md:grid-cols-3">
      <section className="md:col-span-2">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">{meta?.name || shortAddress(address, 8, 8)}</h1>
            {meta?.name ? <p className="font-mono text-xs opacity-50">{shortAddress(address, 6, 6)}</p> : null}
            {meta?.strategy ? <p className="text-xs opacity-60">{meta.strategy}</p> : null}
          </div>
          <div className="flex items-center gap-3">
            <a href={`/manage/${address}`} className="text-xs text-[#3b82f6]">
              Manage
            </a>
            <span className="rounded bg-[#1a1f2b] px-2 py-1 text-xs">
              {vaultStatusLabel(d.vaultPoolStatus)}
            </span>
          </div>
        </div>
        <div className="card grid grid-cols-2 gap-4 p-5 sm:grid-cols-3">
          <Stat label="Raised" value={formatMicroUsd(d.raisedAmountUsd)} />
          <Stat label="Total shares" value={d.totalShares.toLocaleString()} />
          <Stat label="Investors" value={d.investorCount.toString()} />
          <Stat label="Perf fee" value={formatBps(d.performanceFee)} />
          <Stat label="Mgmt fee / yr" value={formatBps(d.moneyManagementYearlyFee)} />
          <Stat label="Created" value={formatUnix(d.createdAt)} />
          <Stat label="Base mint" value={shortAddress(String(d.tokenMint), 5, 5)} />
          <Stat label="Manager" value={shortAddress(String(d.moneyManager), 5, 5)} />
          <Stat label="Open-ended" value={d.isOpenEnded ? 'Yes' : 'No'} />
        </div>
      </section>

      <aside className="space-y-4">
        <div className="card p-5">
          <h2 className="mb-3 font-semibold">Your position</h2>
          {!connected ? (
            <p className="text-sm opacity-60">Connect a wallet to deposit.</p>
          ) : position?.exists && position.data.shares > 0n ? (
            <>
              <p className="text-sm">
                <span className="opacity-60">Shares:</span>{' '}
                {position.data.shares.toLocaleString()}
              </p>
              <button
                className="btn btn-ghost mt-3 w-full"
                disabled={redeem.isRunning}
                onClick={() => redeem.dispatch()}
              >
                {redeem.isRunning ? 'Redeeming…' : 'Redeem all'}
              </button>
              {redeem.error ? (
                <p className="mt-2 text-xs text-red-400">{String(redeem.error)}</p>
              ) : redeem.data ? (
                <p className="mt-2 text-xs text-emerald-400">
                  Redeemed — {shortAddress(String(redeem.data), 6, 6)}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm opacity-60">No position yet.</p>
          )}
        </div>

        <div className="card p-5">
          <h2 className="mb-3 font-semibold">Deposit</h2>
          <div className="flex gap-2">
            <input
              className="input"
              placeholder={`amount (${decimals} dp)`}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
            <button
              className="btn"
              disabled={!connected || deposit.isRunning || !amount}
              onClick={() => deposit.dispatch(amount)}
            >
              {deposit.isRunning ? '…' : 'Deposit'}
            </button>
          </div>
          {deposit.error ? (
            <p className="mt-2 text-xs text-red-400">{String(deposit.error)}</p>
          ) : deposit.data ? (
            <p className="mt-2 text-xs text-emerald-400">
              Sent: {shortAddress(String(deposit.data), 6, 6)}
            </p>
          ) : (
            <p className="mt-2 text-xs opacity-40">
              Shares price against tracked cost basis (donation-resistant).
            </p>
          )}
          {mint ? (
            <p className="mt-2 text-xs opacity-40">
              min contribution {formatTokenAmount(d.minContributeAmountUsd, decimals)}
            </p>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs opacity-50">{label}</div>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-6">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm opacity-70">{children}</p>
    </div>
  );
}
