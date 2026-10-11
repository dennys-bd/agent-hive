import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMemoryCap, memoryCapTokens } from '../src/ui/lib/memory-cap.js';

test('isMemoryCap takes a whole number from 300 to 20000 as typed; memoryCapTokens is (cap + 400) / 4, rounded (#73)', () => {
  for (const ok of ['300', ' 4000 ', '20000']) assert.equal(isMemoryCap(ok), true, ok);
  for (const bad of ['', ' ', '299', '20001', '4000.5', '-300', '1e4', 'x']) assert.equal(isMemoryCap(bad), false, JSON.stringify(bad));
  assert.deepEqual([memoryCapTokens(4000), memoryCapTokens(300), memoryCapTokens(20000), memoryCapTokens(8000)], [1100, 175, 5100, 2100]);
});
