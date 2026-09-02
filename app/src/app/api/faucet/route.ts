import { NextRequest, NextResponse } from 'next/server';
import { RPC_URL } from '@/lib/config';

/**
 * POST /api/faucet  { address, mint, amount? }
 * Local-surfnet helper: tops up the wallet with SOL and gives it demo base-token balance via
 * surfnet cheatcodes, so a browser wallet can exercise the deposit flow without mainnet funds.
 * No-op / error against any non-surfnet RPC.
 */
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

export async function POST(req: NextRequest) {
  try {
    const { address, mint, amount } = await req.json();
    if (!address || !mint) {
      return NextResponse.json({ error: 'address and mint required' }, { status: 400 });
    }
    await cheat('surfnet_setAccount', [address, { lamports: 10_000_000_000 }]);
    await cheat('surfnet_setTokenAccount', [address, mint, { amount: amount ?? 1_000_000_000 }]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
