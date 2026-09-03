import { NextResponse } from 'next/server';
import { TRADABLE_ASSETS } from '@/lib/assets';

/** GET /api/assets — the curated tradable-asset catalog (symbol, mint, decimals, Pyth feed, token program). */
export function GET() {
  return NextResponse.json({ assets: TRADABLE_ASSETS });
}
