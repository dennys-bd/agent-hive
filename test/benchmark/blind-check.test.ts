import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blindLeak } from '../../src/benchmark/blind-check.js';

test('blindLeak finds a forbidden word whole, in any case and with accents, and names where it is (#471)', () => {
  const inputs = [{ where: 'task T1', text: 'An experimental build' }, { where: 'stage spec', text: 'Pick the BRAÇO, then (arm) it' }];
  assert.deepEqual(blindLeak(inputs, ['experiment', 'braço']), { where: 'stage spec', word: 'braço' });
  assert.deepEqual(blindLeak(inputs, ['arm']), { where: 'stage spec', word: 'arm' });
  assert.equal(blindLeak([{ where: 'x', text: 'braços e armas' }], ['braço', 'arm']), undefined);
  assert.equal(blindLeak([{ where: 'x', text: 'axb+c' }], ['a.b', '', ' ']), undefined, 'a word is literal, a blank one never matches');
  assert.deepEqual(blindLeak([{ where: 'x', text: 'see a.b now' }], ['a.b']), { where: 'x', word: 'a.b' });
});
