'use client';

import { useState } from 'react';
import { address, type Address } from '@solana/kit';
import { useAction } from '@solana/react';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import {
  fetchMaybeAdminPool,
  fetchMaybeMoneyManagerPool,
  fetchMaybeOraclePool,
  findAdminPoolPda,
  findMoneyManagerPoolPda,
  getCreateMoneyManagerPoolInstructionAsync,
  getCreateVaultInstructionAsync,
} from '@/generated';
import { client } from '@/app/providers';
import { FBYT_PROGRAM_ID } from '@/lib/config';
import {
  assetRegistryAddress,
  canonicalPriceAccount,
  feedId32,
  oraclePoolAddress,
  vaultPoolAddress,
} from '@/lib/program';
import { shortAddress } from '@/lib/format';

const DEFAULTS = {
  baseMint: '',
  minContributeAmount: '10000',
  raisePeriod: '2592000',
  minRaiseAmount: '10000',
  mmWithdrawPeriod: '604800',
  withdrawCooldown: '3888000',
  moneyManagementFee: '1000',
  performanceFee: '1500',
  isOpenEnded: true,
};

export default function CreatePage() {
  const connected = useConnectedWallet(client);
  const [form, setForm] = useState(DEFAULTS);
  const set = (k: keyof typeof form) => (v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const create = useAction(async (signal: AbortSignal) => {
    if (!connected?.signer) throw new Error('Connect a wallet');
    const manager = connected.signer;
    const managerAddr = connected.account.address as Address;
    const tokenMint = address(form.baseMint.trim());

    const [adminPoolAddr] = await findAdminPoolPda({ programAddress: FBYT_PROGRAM_ID });
    const admin = await fetchMaybeAdminPool(client.rpc, adminPoolAddr);
    if (!admin.exists) throw new Error('Admin pool not bootstrapped');

    const oraclePool = await oraclePoolAddress(adminPoolAddr, tokenMint);
    const oracle = await fetchMaybeOraclePool(client.rpc, oraclePool);
    if (!oracle.exists || !oracle.data.isApproved)
      throw new Error('This base mint has no approved oracle');
    const priceUpdate = await canonicalPriceAccount(feedId32(oracle.data.feedId));

    const [mmPool] = await findMoneyManagerPoolPda(
      { adminPool: adminPoolAddr, moneyManager: managerAddr },
      { programAddress: FBYT_PROGRAM_ID },
    );
    const index = admin.data.vaultPoolCount;
    const vaultPool = await vaultPoolAddress(adminPoolAddr, managerAddr, index);
    const assetRegistry = await assetRegistryAddress(vaultPool);

    const ixs = [];
    const existingMm = await fetchMaybeMoneyManagerPool(client.rpc, mmPool);
    if (!existingMm.exists) {
      ixs.push(await getCreateMoneyManagerPoolInstructionAsync({ moneyManager: manager }));
    }
    ixs.push(
      await getCreateVaultInstructionAsync({
        admin: admin.data.admin,
        moneyManager: manager,
        vaultPool,
        assetRegistry,
        oraclePool,
        priceUpdate,
        tokenMint,
        minContributeAmount: BigInt(form.minContributeAmount),
        raisePeriod: BigInt(form.raisePeriod),
        minRaiseAmount: BigInt(form.minRaiseAmount),
        mmWithdrawPeriod: BigInt(form.mmWithdrawPeriod),
        withdrawCooldown: BigInt(form.withdrawCooldown),
        moneyManagementFee: Number(form.moneyManagementFee),
        performanceFee: Number(form.performanceFee),
        isOpenEnded: form.isOpenEnded,
      }),
    );
    const res = await client.sendTransaction(ixs, { abortSignal: signal });
    return { signature: String(res.context.signature), vault: String(vaultPool) };
  });

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-1 text-2xl font-bold">Create a vault</h1>
      <p className="mb-6 opacity-60">
        You become the money manager. The base mint must already have an admin-approved oracle.
      </p>

      <div className="card space-y-4 p-5">
        <Field label="Base token mint">
          <input
            className="input font-mono"
            placeholder="mint address (e.g. the bootstrap demo mint)"
            value={form.baseMint}
            onChange={(e) => set('baseMint')(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min contribution (base units)">
            <input className="input" value={form.minContributeAmount} onChange={(e) => set('minContributeAmount')(e.target.value)} />
          </Field>
          <Field label="Min raise (base units)">
            <input className="input" value={form.minRaiseAmount} onChange={(e) => set('minRaiseAmount')(e.target.value)} />
          </Field>
          <Field label="Raise period (s)">
            <input className="input" value={form.raisePeriod} onChange={(e) => set('raisePeriod')(e.target.value)} />
          </Field>
          <Field label="Withdraw cooldown (s)">
            <input className="input" value={form.withdrawCooldown} onChange={(e) => set('withdrawCooldown')(e.target.value)} />
          </Field>
          <Field label="Mgmt fee /yr (bps)">
            <input className="input" value={form.moneyManagementFee} onChange={(e) => set('moneyManagementFee')(e.target.value)} />
          </Field>
          <Field label="Performance fee (bps)">
            <input className="input" value={form.performanceFee} onChange={(e) => set('performanceFee')(e.target.value)} />
          </Field>
          <Field label="Fee-withdraw period (s)">
            <input className="input" value={form.mmWithdrawPeriod} onChange={(e) => set('mmWithdrawPeriod')(e.target.value)} />
          </Field>
          <label className="flex items-end gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isOpenEnded}
              onChange={(e) => set('isOpenEnded')(e.target.checked)}
            />
            Open-ended
          </label>
        </div>

        <button
          className="btn w-full"
          disabled={!connected || create.isRunning || !form.baseMint}
          onClick={() => create.dispatch()}
        >
          {create.isRunning ? 'Creating…' : 'Create vault'}
        </button>
        {create.error ? (
          <p className="text-xs text-red-400">{String(create.error)}</p>
        ) : create.data ? (
          <p className="text-xs text-emerald-400">
            Created vault {shortAddress(create.data.vault, 6, 6)} — tx{' '}
            {shortAddress(create.data.signature, 6, 6)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs opacity-60">{label}</span>
      {children}
    </label>
  );
}
