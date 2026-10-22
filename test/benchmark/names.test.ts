import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as git from '../../src/benchmark/git.js';
import * as names from '../../src/benchmark/names.js';
import * as store from '../../src/benchmark/store.js';

test('the blind names and the upload name live in names.ts; git.ts and store.ts re-export the same values (#463)', () => {
  assert.equal(names.runBranch('k3x9'), 'work/k3x9');
  assert.equal(names.runPrefix('k3x9'), 'K3X9');
  assert.equal(names.taskBranchPrefix('K3X9'), 'hive/K3X9-');
  assert.deepEqual(names.EXPERIMENT_PATHS, ['scripts/experiment', 'test/experiment']);
  assert.equal(names.UPLOAD_PREFIX, 'upload:');
  assert.deepEqual(['print-1.png', '../x', 'my shot.png'].map((n) => names.UPLOAD_NAME.test(n)), [true, false, false]);
  assert.equal(git.EXPERIMENT_PATHS, names.EXPERIMENT_PATHS);
  assert.equal(git.runBranch, names.runBranch);
  assert.equal(git.runPrefix, names.runPrefix);
  assert.equal(git.taskBranchPrefix, names.taskBranchPrefix);
  assert.equal(store.UPLOAD_PREFIX, names.UPLOAD_PREFIX);
  assert.equal(store.UPLOAD_NAME, names.UPLOAD_NAME);
});

test('names.ts imports nothing, so the UI bundles it without node (#463)', async () => {
  const text = await readFile(new URL('../../../src/benchmark/names.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /^import /m);
});
