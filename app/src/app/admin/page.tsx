'use client';

import { useEffect, useState } from 'react';
import { address, type Address, type Instruction } from '@solana/kit';
import { useAction } from '@solana/react';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import useSWR from 'swr';
import {
  fetchMaybeAdminPool,
  fetchMaybeOraclePool,
  findAdminPoolPda,
  getCreateOraclePoolInstructionAsync,
  getApproveOraclePoolInstructionAsync,
  getAdminModifyFeeInstructionAsync,
  getAdminUpdateOperatorInstructionAsync,
  getAdminTransferOwnershipInstructionAsync,
  getAdminAcceptOwnershipInstructionAsync,
  getAdminUpdateContributionAmountMinUsdInstructionAsync,
  getAdminUpdateDustThresholdUsdInstructionAsync,
  getAdminUpdateFundrisingPeriodMaxInstructionAsync,
  getAdminUpdateIdlePeriodInstructionAsync,
  getAdminUpdateMaxAssetCountInstructionAsync,
  getAdminUpdateMaxSlippageBpsInstructionAsync,
  getAdminUpdateOracleMaxAgeInstructionAsync,
  getAdminUpdateRaiseAmountMinUsdInstructionAsync,
  getAdminUpdateWithdrawCooldownMaxInstructionAsync,
} from '@/generated';
import { client } from '@/app/providers';
import { FBYT_PROGRAM_ID } from '@/lib/config';
import { oraclePoolAddress } from '@/lib/program';
import { shortAddress } from '@/lib/format';

export default function AdminPage() {
  const connected = useConnectedWallet(client);
  const me = connected?.account.address as Address | undefined;

  const { data: admin, mutate } = useSWR(['adminPool'], async () => {
    const [a] = await findAdminPoolPda({ programAddress: FBYT_PROGRAM_ID });
    return fetchMaybeAdminPool(client.rpc, a);
  });

  const isAdmin = admin?.exists && me && String(admin.data.admin) === me;
  const isPendingAdmin = admin?.exists && me && String(admin.data.pendingAdmin) === me;

  // One generic transaction runner shared by every admin action (an admin tool sends one at a time).
  const runTx = useAction(async (signal: AbortSignal, build: () => Promise<Instruction[]>) => {
    if (!connected?.signer) throw new Error('Connect the admin wallet');
    const ixs = await build();
    const res = await client.sendTransaction(ixs, { abortSignal: signal });
    await mutate();
    return String(res.context.signature);
  });
  const signer = connected?.signer;

  if (!admin) return <div className="opacity-60">Loading protocol config…</div>;
  if (!admin.exists)
    return (
      <div className="card p-6">
        <h1 className="mb-1 text-xl font-bold">Admin</h1>
        <p className="text-sm opacity-70">
          No <code>AdminPool</code> on this network. It is created by the program&rsquo;s upgrade
          authority via <code>create_admin_pool</code> — run <code>pnpm bootstrap</code> against a
          local surfnet.
        </p>
      </div>
    );

  const d = admin.data;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Protocol admin</h1>
        <span className="text-xs opacity-60">
          {isAdmin ? 'admin wallet connected' : isPendingAdmin ? 'pending-admin connected' : 'read-only'}
        </span>
      </div>

      {runTx.error ? (
        <p className="text-xs text-red-400">{String(runTx.error)}</p>
      ) : runTx.data ? (
        <p className="text-xs text-emerald-400">Sent — {shortAddress(String(runTx.data), 6, 6)}</p>
      ) : null}

      {/* config overview */}
      <section className="card p-5">
        <h2 className="mb-3 font-semibold">Config</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <KV k="admin" v={shortAddress(String(d.admin), 5, 5)} />
          <KV k="operator" v={shortAddress(String(d.operator), 5, 5)} />
          <KV k="pending admin" v={String(d.pendingAdmin) === '11111111111111111111111111111111' ? 'none' : shortAddress(String(d.pendingAdmin), 5, 5)} />
          <KV k="vaults" v={d.vaultPoolCount.toString()} />
          <KV k="creation fee (lamports)" v={d.creationFee.toString()} />
          <KV k="trading fee (lamports)" v={d.tradingFee.toString()} />
          <KV k="protocol perf fee (bps)" v={d.protocolPerformanceFee.toString()} />
          <KV k="protocol mm fee (bps)" v={d.protocolMoneyManagementFee.toString()} />
          <KV k="mm yearly fee max (bps)" v={d.moneyManagementYearlyFeeMax.toString()} />
          <KV k="perf fee max (bps)" v={d.performanceFeeMax.toString()} />
          <KV k="max slippage (bps)" v={d.maxSlippageBps.toString()} />
          <KV k="max assets" v={d.maxAssetCount.toString()} />
          <KV k="oracle max age (s)" v={d.oracleMaxAge.toString()} />
          <KV k="idle period (s)" v={d.idlePeriod.toString()} />
          <KV k="fundraise max (s)" v={d.fundrisingPeriodMax.toString()} />
          <KV k="cooldown max (s)" v={d.withdrawCooldownMax.toString()} />
          <KV k="raise min (usd)" v={d.raiseAmountMinUsd.toString()} />
          <KV k="contribution min (usd)" v={d.contributionAmountMinUsd.toString()} />
          <KV k="dust threshold (usd)" v={d.dustThresholdUsd.toString()} />
        </div>
      </section>

      <OracleOnboarding
        disabled={!isAdmin || runTx.isRunning}
        onSubmit={(mint, feedId) =>
          runTx.dispatch(async () => {
            if (!signer) throw new Error('Connect the admin wallet');
            const tokenMint = address(mint.trim());
            const feed = `0x${feedId.trim().replace(/^0x/, '')}`;
            const oraclePool = await oraclePoolAddress(await adminPoolAddr(), tokenMint);
            const existing = await fetchMaybeOraclePool(client.rpc, oraclePool);
            const ixs: Instruction[] = [];
            if (!existing.exists)
              ixs.push(await getCreateOraclePoolInstructionAsync({ requester: signer, tokenMint, feedId: feed }));
            ixs.push(await getApproveOraclePoolInstructionAsync({ admin: signer, tokenMint }));
            return ixs;
          })
        }
      />

      {/* fees */}
      <FeeEditor
        disabled={!isAdmin || runTx.isRunning}
        initial={{
          creationFee: d.creationFee.toString(),
          tradingFee: d.tradingFee.toString(),
          protocolPerformanceFee: d.protocolPerformanceFee.toString(),
          protocolMoneyManagementFee: d.protocolMoneyManagementFee.toString(),
          moneyManagementYearlyFeeMax: d.moneyManagementYearlyFeeMax.toString(),
          performanceFeeMax: d.performanceFeeMax.toString(),
        }}
        onSubmit={(f) =>
          runTx.dispatch(async () => {
            if (!signer) throw new Error('Connect the admin wallet');
            return [
              await getAdminModifyFeeInstructionAsync({
                admin: signer,
                creationFee: BigInt(f.creationFee),
                tradingFee: BigInt(f.tradingFee),
                protocolPerformanceFee: Number(f.protocolPerformanceFee),
                protocolMoneyManagementFee: Number(f.protocolMoneyManagementFee),
                moneyManagementYearlyFeeMax: Number(f.moneyManagementYearlyFeeMax),
                performanceFeeMax: Number(f.performanceFeeMax),
              }),
            ];
          })
        }
      />

      {/* scalar limit setters */}
      <section className="card p-5">
        <h2 className="mb-3 font-semibold">Limits &amp; caps</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {SCALARS.map((s) => (
            <ScalarRow
              key={s.label}
              label={s.label}
              current={s.get(d).toString()}
              disabled={!isAdmin || runTx.isRunning}
              onSubmit={(val) =>
                runTx.dispatch(async () => {
                  if (!signer) throw new Error('Connect the admin wallet');
                  return [await s.build(signer, val)];
                })
              }
            />
          ))}
        </div>
      </section>

      {/* roles */}
      <section className="card p-5">
        <h2 className="mb-3 font-semibold">Roles &amp; ownership</h2>
        <div className="space-y-3">
          <AddressAction
            label="Set operator"
            placeholder="new operator address"
            disabled={!isAdmin || runTx.isRunning}
            onSubmit={(v) =>
              runTx.dispatch(async () => {
                if (!signer) throw new Error('Connect the admin wallet');
                return [await getAdminUpdateOperatorInstructionAsync({ admin: signer, operator: address(v.trim()) })];
              })
            }
          />
          <AddressAction
            label="Transfer ownership (proposes a pending admin)"
            placeholder="pending admin address"
            disabled={!isAdmin || runTx.isRunning}
            onSubmit={(v) =>
              runTx.dispatch(async () => {
                if (!signer) throw new Error('Connect the admin wallet');
                return [await getAdminTransferOwnershipInstructionAsync({ admin: signer, pendingAdmin: address(v.trim()) })];
              })
            }
          />
          <div className="flex items-center justify-between rounded border border-[#1e2230] p-3">
            <span className="text-sm">Accept ownership (pending admin)</span>
            <button
              className="btn"
              disabled={!isPendingAdmin || runTx.isRunning}
              onClick={() =>
                runTx.dispatch(async () => {
                  if (!signer) throw new Error('Connect the pending-admin wallet');
                  return [await getAdminAcceptOwnershipInstructionAsync({ pendingAdmin: signer })];
                })
              }
            >
              Accept
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

async function adminPoolAddr(): Promise<Address> {
  const [a] = await findAdminPoolPda({ programAddress: FBYT_PROGRAM_ID });
  return a;
}

type Signer = NonNullable<NonNullable<ReturnType<typeof useConnectedWallet>>['signer']>;

const SCALARS: Array<{
  label: string;
  get: (d: Record<string, unknown>) => bigint | number;
  build: (admin: Signer, v: string) => Promise<Instruction>;
}> = [
  { label: 'max slippage (bps)', get: (d) => d.maxSlippageBps as number, build: (a, v) => getAdminUpdateMaxSlippageBpsInstructionAsync({ admin: a, newMaxSlippageBps: Number(v) }) },
  { label: 'max assets', get: (d) => d.maxAssetCount as number, build: (a, v) => getAdminUpdateMaxAssetCountInstructionAsync({ admin: a, newMaxAssetCount: Number(v) }) },
  { label: 'oracle max age (s)', get: (d) => d.oracleMaxAge as bigint, build: (a, v) => getAdminUpdateOracleMaxAgeInstructionAsync({ admin: a, newOracleMaxAge: BigInt(v) }) },
  { label: 'idle period (s)', get: (d) => d.idlePeriod as bigint, build: (a, v) => getAdminUpdateIdlePeriodInstructionAsync({ admin: a, newIdlePeriod: BigInt(v) }) },
  { label: 'fundraise max (s)', get: (d) => d.fundrisingPeriodMax as bigint, build: (a, v) => getAdminUpdateFundrisingPeriodMaxInstructionAsync({ admin: a, newFundrisingPeriodMax: BigInt(v) }) },
  { label: 'cooldown max (s)', get: (d) => d.withdrawCooldownMax as bigint, build: (a, v) => getAdminUpdateWithdrawCooldownMaxInstructionAsync({ admin: a, newWithdrawCooldownMax: BigInt(v) }) },
  { label: 'raise min (usd)', get: (d) => d.raiseAmountMinUsd as bigint, build: (a, v) => getAdminUpdateRaiseAmountMinUsdInstructionAsync({ admin: a, newRaiseAmountMinUsd: BigInt(v) }) },
  { label: 'contribution min (usd)', get: (d) => d.contributionAmountMinUsd as bigint, build: (a, v) => getAdminUpdateContributionAmountMinUsdInstructionAsync({ admin: a, newContributionAmountMinUsd: BigInt(v) }) },
  { label: 'dust threshold (usd)', get: (d) => d.dustThresholdUsd as bigint, build: (a, v) => getAdminUpdateDustThresholdUsdInstructionAsync({ admin: a, newDustThresholdUsd: BigInt(v) }) },
];

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-xs opacity-50">{k}</div>
      <div className="font-mono text-sm">{v}</div>
    </div>
  );
}

function OracleOnboarding({ disabled, onSubmit }: { disabled: boolean; onSubmit: (mint: string, feedId: string) => void }) {
  const [mint, setMint] = useState('');
  const [feed, setFeed] = useState('');
  return (
    <section className="card p-5">
      <h2 className="mb-1 font-semibold">Onboard a tradeable asset</h2>
      <p className="mb-3 text-sm opacity-60">
        Registers and approves a Pyth-backed <code>OraclePool</code> for a mint (create_oracle_pool +
        approve_oracle_pool). Assets must be onboarded before a vault can raise in or trade them.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input font-mono" placeholder="token mint" value={mint} onChange={(e) => setMint(e.target.value)} />
        <input className="input font-mono" placeholder="pyth feed id (32-byte hex)" value={feed} onChange={(e) => setFeed(e.target.value)} />
      </div>
      <button className="btn mt-3" disabled={disabled || !mint || !feed} onClick={() => onSubmit(mint, feed)}>
        Onboard &amp; approve
      </button>
    </section>
  );
}

function FeeEditor({
  disabled,
  initial,
  onSubmit,
}: {
  disabled: boolean;
  initial: Record<string, string>;
  onSubmit: (f: Record<string, string>) => void;
}) {
  const [f, setF] = useState(initial);
  useEffect(() => setF(initial), [initial.creationFee, initial.tradingFee]); // eslint-disable-line react-hooks/exhaustive-deps
  const fields: Array<[string, string]> = [
    ['creationFee', 'creation fee (lamports)'],
    ['tradingFee', 'trading fee (lamports)'],
    ['protocolPerformanceFee', 'protocol perf fee (bps)'],
    ['protocolMoneyManagementFee', 'protocol mm fee (bps)'],
    ['moneyManagementYearlyFeeMax', 'mm yearly fee max (bps)'],
    ['performanceFeeMax', 'perf fee max (bps)'],
  ];
  return (
    <section className="card p-5">
      <h2 className="mb-3 font-semibold">Fees</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {fields.map(([k, label]) => (
          <label key={k} className="block">
            <span className="mb-1 block text-xs opacity-60">{label}</span>
            <input className="input" value={f[k]} onChange={(e) => setF((p) => ({ ...p, [k]: e.target.value }))} />
          </label>
        ))}
      </div>
      <button className="btn mt-3" disabled={disabled} onClick={() => onSubmit(f)}>
        Update fees
      </button>
    </section>
  );
}

function ScalarRow({ label, current, disabled, onSubmit }: { label: string; current: string; disabled: boolean; onSubmit: (v: string) => void }) {
  const [v, setV] = useState(current);
  useEffect(() => setV(current), [current]);
  return (
    <div className="flex items-end gap-2">
      <label className="flex-1">
        <span className="mb-1 block text-xs opacity-60">{label}</span>
        <input className="input" value={v} onChange={(e) => setV(e.target.value)} />
      </label>
      <button className="btn btn-ghost" disabled={disabled || v === current} onClick={() => onSubmit(v)}>
        Set
      </button>
    </div>
  );
}

function AddressAction({ label, placeholder, disabled, onSubmit }: { label: string; placeholder: string; disabled: boolean; onSubmit: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="flex items-end gap-2">
      <label className="flex-1">
        <span className="mb-1 block text-xs opacity-60">{label}</span>
        <input className="input font-mono" placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
      </label>
      <button className="btn" disabled={disabled || !v} onClick={() => onSubmit(v)}>
        Submit
      </button>
    </div>
  );
}
