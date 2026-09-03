import { createPublicKey, verify } from 'node:crypto';
import { getAddressEncoder, type Address } from '@solana/kit';

// DER/SPKI prefix for an Ed25519 public key (RFC 8410).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Verify an Ed25519 signature by `signerAddress` over `message` (raw bytes). */
export function verifyEd25519(signerAddress: string, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const pubkey = Buffer.from(getAddressEncoder().encode(signerAddress as Address));
    const spki = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pubkey]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message), spki, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Canonical message a vault manager signs to authorize a profile write. */
export function metadataMessage(vault: string, issuedAt: number): string {
  return `FBYT vault profile\nvault: ${vault}\nissued: ${issuedAt}`;
}
