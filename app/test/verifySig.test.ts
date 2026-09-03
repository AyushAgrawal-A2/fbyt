import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { getAddressDecoder } from '@solana/kit';
import { verifyEd25519, metadataMessage } from '../src/lib/verifySig.js';

function newSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { address: getAddressDecoder().decode(new Uint8Array(raw)), privateKey };
}

test('a valid Ed25519 signature verifies', () => {
  const s = newSigner();
  const msg = new TextEncoder().encode(metadataMessage('Vau1t', 123));
  const sig = sign(null, msg, s.privateKey);
  assert.equal(verifyEd25519(s.address, msg, new Uint8Array(sig)), true);
});

test('a tampered message fails', () => {
  const s = newSigner();
  const sig = sign(null, new TextEncoder().encode(metadataMessage('Vau1t', 123)), s.privateKey);
  const other = new TextEncoder().encode(metadataMessage('Vau1t', 124));
  assert.equal(verifyEd25519(s.address, other, new Uint8Array(sig)), false);
});

test('a signature from a different key fails', () => {
  const a = newSigner();
  const b = newSigner();
  const msg = new TextEncoder().encode(metadataMessage('Vau1t', 123));
  const sig = sign(null, msg, b.privateKey);
  assert.equal(verifyEd25519(a.address, msg, new Uint8Array(sig)), false);
});
