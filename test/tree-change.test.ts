import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldersToReread, isTreeRead } from '../src/ui/lib/tree-change.js';

const IGNORED = { files: ['debug.log'], folders: ['docs', 'node_modules'] };

test('isTreeRead reads with no paths or no tree yet, and when a path is neither an ignored file nor in an ignored folder; a new path counts as not ignored (#502)', () => {
  assert.equal(isTreeRead(undefined, IGNORED), true);
  assert.equal(isTreeRead(['src/a.ts'], undefined), true);
  assert.equal(isTreeRead(['src/new.ts'], IGNORED), true);
  assert.equal(isTreeRead(['debug.log', 'node_modules/pkg/index.js', 'src/a.ts'], IGNORED), true);
  assert.equal(isTreeRead(['debug.log', 'node_modules/pkg/index.js', 'docs/agent/a.md'], IGNORED), false);
  assert.equal(isTreeRead(['docs'], IGNORED), false, 'Q1 (a): a nested repository\'s own push reads no tree');
  assert.equal(isTreeRead(['node_modules2/x'], IGNORED), true, 'a sibling with the same prefix is not inside');
});

test('foldersToReread answers every expanded folder with no paths, else those a path lies in at any depth and those under a path (a nested repository\'s push), in their order (#502, #1)', () => {
  const folders = ['dist', 'docs', 'docs/agent', 'node_modules'];
  assert.deepEqual(foldersToReread(undefined, folders), folders);
  assert.deepEqual(foldersToReread(['node_modules/pkg/index.js'], folders), ['node_modules']);
  assert.deepEqual(foldersToReread(['docs/agent/deep/a.md'], folders), ['docs', 'docs/agent']);
  assert.deepEqual(foldersToReread(['docs'], folders), ['docs', 'docs/agent']);
  assert.deepEqual(foldersToReread(['src/a.ts', 'dist2/x'], folders), []);
});
