import { NextResponse } from 'next/server';
import { serverRpc } from '@/lib/rpc-server';
import { dbGet } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — liveness/readiness for orchestration. `ok` reflects the critical dependency (the
 * datastore); the RPC is reported separately so a flaky provider shows as degraded rather than down.
 */
export async function GET() {
  const checks: { db: boolean; rpc: boolean } = { db: false, rpc: false };
  try {
    await dbGet('__health', 'probe');
    checks.db = true;
  } catch {
    /* db down */
  }
  try {
    await serverRpc().getSlot().send({ abortSignal: AbortSignal.timeout(3000) });
    checks.rpc = true;
  } catch {
    /* rpc down/degraded */
  }
  const ok = checks.db;
  return NextResponse.json({ ok, checks, ts: Date.now() }, { status: ok ? 200 : 503 });
}
