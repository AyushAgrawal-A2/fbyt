import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createSolanaRpc, getProgramDerivedAddress, type Address } from '@solana/kit';
import { RPC_URL, DEMO_OUT_FEED_HEX } from '@/lib/config';
import { guard } from '@/lib/guard';
import { fetchVaultPool, fetchOraclePool } from '@/generated';
import {
  PYTH_PUSH_ORACLE_ID,
  oraclePoolAddress,
  feedId32,
  feed32FromHex,
} from '@/lib/program';

/**
 * POST /api/dev/advance  { vault }
 * Local-surfnet only. Time-travels the clock just past a vault's fundraise end (`created_at +
 * raise_period`) so the manager can trade, and re-publishes both the base and demo-output Pyth prices
 * at the new "now" so they pass the oracle staleness check. Returns the timestamp jumped to.
 *
 * This exposes surfnet cheatcodes the protocol itself never uses; it exists purely to walk a demo
 * vault through its raise -> trade lifecycle on a single local clock. No-op against a non-surfnet RPC.
 */
const le = (v: number | bigint, n: number) => {
  const out = new Uint8Array(n);
  let x = BigInt(v);
  for (let i = 0; i < n; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};
function concat(...parts: Array<ArrayLike<number>>): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(Uint8Array.from(p), o);
    o += p.length;
  }
  return out;
}
async function cheat(method: string, params: unknown[]) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}
async function publishPrice(feed32: Uint8Array, priceMicro: bigint, publishTime: number) {
  const [acct] = await getProgramDerivedAddress({
    programAddress: PYTH_PUSH_ORACLE_ID,
    seeds: [new Uint8Array([0, 0]), feed32],
  });
  const disc = new Uint8Array(createHash('sha256').update('account:PriceUpdateV2').digest()).slice(0, 8);
  const data = concat(
    disc,
    new Uint8Array(32),
    [1],
    feed32,
    le(priceMicro, 8),
    le(1n, 8),
    le(0xfffffff8, 4),
    le(publishTime, 8),
    le(publishTime, 8),
    le(priceMicro, 8),
    le(1n, 8),
    le(0n, 8),
  );
  await cheat('surfnet_setAccount', [
    acct,
    { lamports: 5_000_000, data: Buffer.from(data).toString('hex'), owner: 'rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp', executable: false, rent_epoch: 0 },
  ]);
}

export async function POST(req: NextRequest) {
  const blocked = guard(req, { limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  try {
    const { vault } = await req.json();
    if (!vault) return NextResponse.json({ error: 'vault required' }, { status: 400 });

    const rpc = createSolanaRpc(RPC_URL);
    const v = await fetchVaultPool(rpc, vault as Address);
    const d = v.data;
    const when = Number(d.createdAt + d.raisePeriod) + 60;

    // refresh the base price, then the demo-output price, then jump the clock to `when`.
    const baseOracle = await oraclePoolAddress(d.adminPool, d.tokenMint);
    const baseFeed = feedId32((await fetchOraclePool(rpc, baseOracle)).data.feedId);
    await publishPrice(baseFeed, 150_000_000n, when);
    await publishPrice(feed32FromHex(DEMO_OUT_FEED_HEX), 100_000_000n, when);
    await cheat('surfnet_timeTravel', [{ absoluteTimestamp: when * 1000 }]);

    return NextResponse.json({ ok: true, advancedTo: when });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
