/**
 * FBYT indexer — the local stand-in for the platform's indexer/DB. On an interval it snapshots every
 * vault's NAV (building the pnl-history time series the on-chain state can't give you after the fact)
 * and persists decoded trades. It reads through the app's own API and writes into the file-backed DB
 * (.data/db), which the app then serves back as history + charts.
 *
 *   pnpm dev            # the app must be running (the indexer reads its NAV/trades endpoints)
 *   pnpm indexer        # snapshots every 30s; override with INDEX_INTERVAL_SEC / APP_URL
 */
import { dbAppend, dbPut } from '../src/lib/db.js';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const INTERVAL = Number(process.env.INDEX_INTERVAL_SEC ?? 30) * 1000;
const BUCKET_MS = Number(process.env.INDEX_BUCKET_MS ?? 60_000); // one snapshot per bucket per vault
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type NavResp = { navMicroUsd: string; raisedMicroUsd: string; pnlBps: number; holdings: unknown[] };
type Trade = { signature: string; blockTime: number | null; inputMint: string; outputMint: string; inputAmount: string; outputAmount: string; inputDecimals: number; outputDecimals: number; trader: string };

async function tick(): Promise<void> {
  const list = await fetch(`${APP_URL}/api/vaults`).then((r) => r.json()).catch(() => null);
  const vaults: Array<{ address: string }> = list?.vaults ?? [];
  const now = Date.now();
  let snaps = 0;
  let trades = 0;
  for (const v of vaults) {
    const nav = (await fetch(`${APP_URL}/api/vaults/${v.address}/nav`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as NavResp | null;
    if (nav) {
      // one snapshot per vault per bucket keeps the series compact and idempotent
      const bucket = Math.floor(now / BUCKET_MS);
      await dbAppend('navSnapshots', { vault: v.address, t: now, navMicroUsd: nav.navMicroUsd, raisedMicroUsd: nav.raisedMicroUsd, pnlBps: nav.pnlBps }, `${v.address}-${bucket}`);
      snaps++;
    }
    const ts = (await fetch(`${APP_URL}/api/vaults/${v.address}/trades`).then((r) => (r.ok ? r.json() : { trades: [] })).catch(() => ({ trades: [] }))).trades as Trade[];
    for (const t of ts) {
      await dbPut('trades', { id: t.signature, vault: v.address, ...t });
      trades++;
    }
  }
  console.log(`[indexer] ${new Date().toISOString()} vaults=${vaults.length} snapshots=${snaps} trades=${trades}`);
}

async function main() {
  console.log(`[indexer] indexing ${APP_URL} every ${INTERVAL / 1000}s`);
  // run forever; each tick is idempotent (bucketed snapshots, trades keyed by signature)
  // a single pass runs if INDEX_ONCE=1 (used by the e2e check)
  const once = process.env.INDEX_ONCE === '1';
  do {
    try {
      await tick();
    } catch (e) {
      console.error('[indexer] tick error:', (e as Error)?.message ?? e);
    }
    if (!once) await sleep(INTERVAL);
  } while (!once);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
