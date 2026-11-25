import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mrState } from '../../src/gitlab/mr-state.js';

test('mrState maps a merge request state to the Hive\'s PR state, a locked one (merging) still open', () => {
  assert.equal(mrState('opened'), 'open');
  assert.equal(mrState('locked'), 'open');
  assert.equal(mrState('merged'), 'merged');
  assert.equal(mrState('closed'), 'closed');
});

test('mrState is undefined for any other state, case and padding included', () => {
  for (const state of ['', 'open', 'OPENED', ' merged', 'draft', 'all']) assert.equal(mrState(state), undefined, state);
});
