import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../src/lib/guard.js';

test('rateLimit allows up to the limit then blocks', () => {
  const key = `k-${Math.random()}`;
  for (let i = 0; i < 5; i++) assert.equal(rateLimit(key, 5, 60_000), true, `req ${i + 1} should pass`);
  assert.equal(rateLimit(key, 5, 60_000), false, '6th should be blocked');
});

test('rateLimit resets after the window', async () => {
  const key = `k-${Math.random()}`;
  assert.equal(rateLimit(key, 1, 30), true);
  assert.equal(rateLimit(key, 1, 30), false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rateLimit(key, 1, 30), true, 'should reset after the window');
});
