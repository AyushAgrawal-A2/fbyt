import { NextRequest, NextResponse } from 'next/server';

const JUP_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';

/**
 * GET /api/jupiter/quote?inputMint&outputMint&amount&slippageBps
 * Server-side proxy to Jupiter's quote API (avoids browser CORS and hides any key). The `swap`
 * handler on-chain measures realized amounts itself; this quote drives the manager's trade UI.
 * Note: on a local surfnet, real Jupiter routing is unavailable — use it against mainnet-configured
 * mints, or the local jupiter-mock for the actual on-chain swap.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const inputMint = p.get('inputMint');
  const outputMint = p.get('outputMint');
  const amount = p.get('amount');
  if (!inputMint || !outputMint || !amount) {
    return NextResponse.json({ error: 'inputMint, outputMint, amount required' }, { status: 400 });
  }
  const url =
    `${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}` +
    `&slippageBps=${p.get('slippageBps') ?? '100'}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
