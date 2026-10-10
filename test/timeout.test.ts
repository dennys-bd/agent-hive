import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMEOUT_MAX_MS, timeoutMs } from '../src/timeout.js';

test('timeoutMs reads 30s, 10m, 1h, trimmed; refuses 0, other units, decimals, empty and anything over a day (#511)', () => {
  assert.deepEqual(['30s', '10m', '1h', ' 5m '].map(timeoutMs), [30_000, 600_000, 3_600_000, 300_000]);
  for (const bad of ['', '0s', '05m', '1d', '1.5h', 'm', '10', '-1m', '25h', '1441m']) assert.equal(timeoutMs(bad), undefined, bad);
  assert.equal(timeoutMs('24h'), TIMEOUT_MAX_MS);
});
