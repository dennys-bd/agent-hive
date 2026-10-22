import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARM_OVERRIDES } from '../../src/benchmark/schemas.js';

test('arm overrides refuse an items key that is not an item id, which would drop the experiment on the next load (#462)', () => {
  assert.equal(ARM_OVERRIDES.safeParse({ items: { 'a/../b': 'v1' } }).success, false);
  assert.equal(ARM_OVERRIDES.safeParse({ stages: { build: { agent: 'codex', model: null } } }).success, true);
});
