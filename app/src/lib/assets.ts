import catalog from '@/data/tradableAssets.json';

/**
 * The curated tradable-asset catalog (the real platform's 52 assets — majors, LSTs, memecoins, and
 * Token-2022 tokenized equities / xStocks). Each carries the Pyth feed id and token program needed to
 * onboard an oracle and trade it. `pythFeedId` is the 64-char hex (no 0x).
 */
export type TradableAsset = {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  pythFeedId: string;
  tokenProgram: string;
  assetType: 'Crypto' | 'Equity' | string;
  iconUrl: string | null;
};

export const TRADABLE_ASSETS = catalog as TradableAsset[];

const byMint = new Map(TRADABLE_ASSETS.map((a) => [a.mint, a]));
export function assetByMint(mint: string): TradableAsset | undefined {
  return byMint.get(mint);
}

export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export function isToken2022(a: TradableAsset): boolean {
  return a.tokenProgram === TOKEN_2022_PROGRAM;
}
