import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
} from '@solana/kit';
import { RPC_URL } from './config';

const FALLBACK_RPC_URL = process.env.SOLANA_RPC_URL_FALLBACK; // optional secondary provider

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A transport that retries transient failures with exponential backoff and, if a fallback RPC is
 * configured, fails over to it on the last attempt. Server reads go through this so a flaky or
 * rate-limited provider degrades gracefully instead of surfacing a 500.
 */
function resilientTransport(urls: string[]): RpcTransport {
  const transports = urls.map((url) => createDefaultRpcTransport({ url }));
  return async function transport<TResponse>(...args: Parameters<RpcTransport>): Promise<TResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = transports[Math.min(attempt, transports.length - 1)];
      try {
        return await t<TResponse>(...args);
      } catch (e) {
        lastErr = e;
        await sleep(150 * 2 ** attempt);
      }
    }
    throw lastErr;
  };
}

/**
 * A plain (wallet-less) RPC for server components and API routes. Reads only — anything that signs must
 * go through the wallet-backed client on the browser.
 */
export function serverRpc() {
  const urls = [RPC_URL, ...(FALLBACK_RPC_URL ? [FALLBACK_RPC_URL] : [])];
  return createSolanaRpcFromTransport(resilientTransport(urls));
}
