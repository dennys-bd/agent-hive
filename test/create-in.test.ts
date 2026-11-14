import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canCreate } from '../src/create-in.js';

test('canCreate: a GitHub source can create only with a repository for new issues (#811)', () => {
  assert.equal(canCreate({ type: 'github', repository: 'acme/app' }), true);
  assert.equal(canCreate({ type: 'github' }), false);
});
