import { NextRequest, NextResponse } from 'next/server';

const JUP_SWAP_IX = 'https://lite-api.jup.ag/swap/v1/swap-instructions';

/**
 * POST /api/jupiter/swap-instructions  { quoteResponse, userPublicKey }
 * Server-side proxy to Jupiter's swap-instructions API. This is how a real (devnet/mainnet) trade is
 * built: the frontend gets a quote (/api/jupiter/quote), asks here for the route instruction, and
 * passes that instruction's `data` (and its accounts as the swap's remaining accounts) to the on-chain
 * `swap`, which CPIs into Jupiter. On a local surfnet there is no real Jupiter liquidity — the bundled
 * jupiter-mock stands in — so use this against a devnet/mainnet-configured deployment.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body?.quoteResponse || !body?.userPublicKey) {
      return NextResponse.json({ error: 'quoteResponse and userPublicKey required' }, { status: 400 });
    }
    const res = await fetch(JUP_SWAP_IX, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        quoteResponse: body.quoteResponse,
        userPublicKey: body.userPublicKey,
        wrapAndUnwrapSol: body.wrapAndUnwrapSol ?? true,
        useSharedAccounts: body.useSharedAccounts ?? true,
      }),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
