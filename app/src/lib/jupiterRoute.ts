import { AccountRole, type Address, type AccountMeta } from '@solana/kit';

/**
 * Adapt a Jupiter swap instruction into what the on-chain `swap` needs: its `data` becomes the swap's
 * route data, and its accounts become the swap's remaining accounts. The one crucial transform is the
 * vault-PDA authority: Jupiter marks the `userPublicKey` (here the vault PDA) as a signer, but the
 * vault can't sign a client transaction — the fbyt program CPIs into Jupiter with `invoke_signed`, so
 * we downgrade that account to a non-signer and let the program provide the signature.
 *
 * On localnet there's no real Jupiter liquidity, so the bundled jupiter-mock stands in; this path is
 * for a devnet/mainnet deployment where /api/jupiter/quote + /api/jupiter/swap-instructions return a
 * real route.
 */
export type JupiterInstruction = {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string; // base64
};

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function roleOf(isSigner: boolean, isWritable: boolean): AccountRole {
  if (isSigner && isWritable) return AccountRole.WRITABLE_SIGNER;
  if (isSigner) return AccountRole.READONLY_SIGNER;
  if (isWritable) return AccountRole.WRITABLE;
  return AccountRole.READONLY;
}

/** Build the `swap` route `data` + remaining accounts from a Jupiter swap instruction. */
export function buildJupiterRoute(
  swapInstruction: JupiterInstruction,
  vaultPda: string,
): { data: Uint8Array; remainingAccounts: AccountMeta[] } {
  const remainingAccounts = swapInstruction.accounts.map((a) => {
    // the vault PDA is signed for by the program's CPI, never by the outer transaction
    const isSigner = a.pubkey === vaultPda ? false : a.isSigner;
    return { address: a.pubkey as Address, role: roleOf(isSigner, a.isWritable) };
  });
  return { data: b64ToBytes(swapInstruction.data), remainingAccounts };
}

/**
 * Fetch a real Jupiter route for a vault: quote, then swap-instructions with the vault PDA as the user,
 * returning the on-chain `swap` data + remaining accounts. Use on a devnet/mainnet deployment.
 */
export async function fetchJupiterRoute(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
  vaultPda: string,
): Promise<{ data: Uint8Array; remainingAccounts: AccountMeta[]; outAmount: string }> {
  const q = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: String(slippageBps) });
  const quoteResponse = await fetch(`/api/jupiter/quote?${q}`).then((r) => r.json());
  const res = await fetch('/api/jupiter/swap-instructions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse, userPublicKey: vaultPda }),
  }).then((r) => r.json());
  if (!res.swapInstruction) throw new Error(res.error ?? 'no swap instruction from Jupiter');
  const route = buildJupiterRoute(res.swapInstruction as JupiterInstruction, vaultPda);
  return { ...route, outAmount: quoteResponse.outAmount };
}
