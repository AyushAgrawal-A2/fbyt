import { createSolanaRpc, type Address, type Signature } from '@solana/kit';
import { getTradingEventEventDecoder, TRADING_EVENT_EVENT_DISCRIMINATOR } from '@/generated';

export type Trade = {
  signature: string;
  blockTime: number | null;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  inputDecimals: number;
  outputDecimals: number;
  trader: string;
};

function startsWithDiscriminator(bytes: Uint8Array): boolean {
  const disc = TRADING_EVENT_EVENT_DISCRIMINATOR;
  if (bytes.length < disc.length) return false;
  for (let i = 0; i < disc.length; i++) if (bytes[i] !== disc[i]) return false;
  return true;
}

/**
 * Read a vault's trade history by scanning the transactions that reference the vault PDA and decoding
 * the Anchor `TradingEvent` logged (as `Program data:`) by `swap`. The real platform serves this from
 * an indexer/DB; on a local surfnet we read it on demand from recent signatures.
 */
export async function fetchTrades(vault: string, rpcUrl: string, limit = 25): Promise<Trade[]> {
  const rpc = createSolanaRpc(rpcUrl);
  const sigs = await rpc.getSignaturesForAddress(vault as Address, { limit }).send();
  const trades: Trade[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc
      .getTransaction(s.signature as Signature, { maxSupportedTransactionVersion: 0, encoding: 'json' })
      .send()
      .catch(() => null);
    const logs = tx?.meta?.logMessages ?? [];
    for (const line of logs) {
      const m = line.match(/^Program data: (.+)$/);
      if (!m) continue;
      const bytes = Uint8Array.from(Buffer.from(m[1], 'base64'));
      if (!startsWithDiscriminator(bytes)) continue;
      try {
        const e = getTradingEventEventDecoder().decode(bytes);
        if (String(e.vaultPool) !== vault) continue;
        trades.push({
          signature: s.signature,
          blockTime: s.blockTime != null ? Number(s.blockTime) : null,
          inputMint: String(e.inputMint),
          outputMint: String(e.outputMint),
          inputAmount: e.inputAmount.toString(),
          outputAmount: e.outputAmount.toString(),
          inputDecimals: e.inputMintDecimals,
          outputDecimals: e.outputMintDecimals,
          trader: String(e.trader),
        });
      } catch {
        // not a trading event we can decode; skip
      }
    }
  }
  return trades;
}
