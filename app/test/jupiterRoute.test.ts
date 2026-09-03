import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountRole } from '@solana/kit';
import { buildJupiterRoute, type JupiterInstruction } from '../src/lib/jupiterRoute.js';

const VAULT = 'VaU1t1111111111111111111111111111111111111';

// a representative Jupiter swap instruction: the user authority (vault PDA) is marked as a signer,
// alongside a writable token account, a readonly program, and a readonly account.
const fixture: JupiterInstruction = {
  programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  accounts: [
    { pubkey: VAULT, isSigner: true, isWritable: true }, // userTransferAuthority = vault PDA
    { pubkey: 'So11111111111111111111111111111111111111112', isSigner: false, isWritable: true },
    { pubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', isSigner: false, isWritable: false },
    { pubkey: 'Sysvar1nstructions1111111111111111111111111', isSigner: false, isWritable: false },
  ],
  data: Buffer.from([1, 2, 3, 4]).toString('base64'),
};

test('buildJupiterRoute decodes data and preserves account order', () => {
  const { data, remainingAccounts } = buildJupiterRoute(fixture, VAULT);
  assert.deepEqual([...data], [1, 2, 3, 4]);
  assert.equal(remainingAccounts.length, 4);
  assert.equal(remainingAccounts[0].address, VAULT);
});

test('the vault PDA signer flag is downgraded (the program CPI-signs for it)', () => {
  const { remainingAccounts } = buildJupiterRoute(fixture, VAULT);
  // vault PDA was isSigner+isWritable -> must become WRITABLE (non-signer)
  assert.equal(remainingAccounts[0].role, AccountRole.WRITABLE);
});

test('non-vault account roles are preserved', () => {
  const { remainingAccounts } = buildJupiterRoute(fixture, VAULT);
  assert.equal(remainingAccounts[1].role, AccountRole.WRITABLE); // writable, non-signer
  assert.equal(remainingAccounts[2].role, AccountRole.READONLY); // readonly program
  assert.equal(remainingAccounts[3].role, AccountRole.READONLY);
});
