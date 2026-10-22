import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskTree } from '../src/server-tree.js';
import { TODAY_TREE } from './fixtures/task-tree-golden.js';
import { realExec, treeRepo } from './fixtures/tree-repo.js';

test('taskTree on the #502 fixture answers what the 5-run read answered (recorded golden)', async (t) => {
  const repo = await treeRepo(t);
  const { root, ...tree } = await taskTree(repo, realExec);
  assert.equal(root, repo);
  assert.deepEqual(tree, TODAY_TREE);
});
