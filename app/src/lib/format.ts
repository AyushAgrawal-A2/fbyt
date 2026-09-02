import { USD_DECIMALS } from './config';

const usdFmt = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

/** micro-USD (6 dp) -> "$1,234.56" */
export function formatMicroUsd(micro: bigint | number): string {
  const n = Number(micro) / 10 ** USD_DECIMALS;
  return usdFmt.format(n);
}

/** basis points -> "1.50%" */
export function formatBps(bps: number | bigint): string {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

/** Raw token base units -> decimal string with the mint's decimals. */
export function formatTokenAmount(raw: bigint | number, decimals: number, maxFrac = 4): string {
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

/** Parse a human decimal (e.g. "12.5") into raw base units for `decimals`. */
export function toBaseUnits(human: string, decimals: number): bigint {
  const [whole, frac = ''] = human.trim().split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const digits = `${whole || '0'}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return BigInt(digits || '0');
}

/** Shorten an address for display: "3yw2…za5Y". */
export function shortAddress(a: string, head = 4, tail = 4): string {
  return a.length <= head + tail ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/** Unix seconds -> localized date. */
export function formatUnix(secs: bigint | number): string {
  return new Date(Number(secs) * 1000).toLocaleDateString();
}

/** VaultPool.vaultPoolStatus byte -> label. */
export function vaultStatusLabel(status: number): 'Active' | 'Dormant' | 'Closed' | 'Unknown' {
  return status === 1 ? 'Active' : status === 2 ? 'Dormant' : status === 3 ? 'Closed' : 'Unknown';
}
