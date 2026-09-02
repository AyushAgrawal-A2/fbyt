import { createSolanaRpc } from '@solana/kit';
import { RPC_URL } from './config';

/**
 * A plain (wallet-less) RPC for server components and API routes. Reads only — anything that signs
 * must go through the wallet-backed client on the browser.
 */
export function serverRpc() {
  return createSolanaRpc(RPC_URL);
}
