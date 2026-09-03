import { AccountRole, address, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import { SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@/lib/config';
import { ata } from '@/lib/program';

/** Native mint (wrapped SOL). A vault whose base token is this trades SOL that's wrapped client-side. */
export const WSOL_MINT: Address = address('So11111111111111111111111111111111111111112');

function u64le(v: bigint): Uint8Array {
  const o = new Uint8Array(8);
  for (let i = 0; i < 8; i++) { o[i] = Number(v & 0xffn); v >>= 8n; }
  return o;
}

/** System `transfer` of `lamports` from `from` to `to`. */
function transferSol(from: Address, to: Address, lamports: bigint): Instruction {
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([2, 0, 0, 0, ...u64le(lamports)]), // System instruction 2 = Transfer
  };
}

/** SPL Token `SyncNative` on a wrapped-SOL account (index 17). */
function syncNative(account: Address): Instruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [{ address: account, role: AccountRole.WRITABLE }],
    data: new Uint8Array([17]),
  };
}

/**
 * Instructions to wrap `lamports` of native SOL into `owner`'s wrapped-SOL ATA: create the ATA
 * (idempotent), fund it with SOL, then sync so the token balance reflects the lamports. Used before a
 * deposit into a wSOL-base vault.
 */
export async function wrapSolInstructions(payer: TransactionSigner, owner: Address, lamports: bigint): Promise<Instruction[]> {
  const wsolAta = await ata(owner, WSOL_MINT);
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: WSOL_MINT }),
    transferSol(payer.address, wsolAta, lamports),
    syncNative(wsolAta),
  ];
}
