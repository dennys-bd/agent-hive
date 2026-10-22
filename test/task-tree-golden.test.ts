import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskTree } from '../src/server-tree.js';
import { buildTree, type TreeNode } from '../src/ui/lib/file-tree.js';
import type { Exec, TaskTree } from '../src/types.js';
import { TODAY_TREE } from './fixtures/task-tree-golden.js';
import { realExec, treeRepo } from './fixtures/tree-repo.js';

// What the sidebar draws before any folder read: an unloaded ignored folder shows collapsed and empty (HIVE-22), whatever buildTree put under it
const drawn = (nodes: TreeNode[]): TreeNode[] =>
  nodes.map((node) => (node.children === undefined ? node : { ...node, children: node.isUnloaded ? [] : drawn(node.children) }));
const draw = (tree: Omit<TaskTree, 'root'>, showHidden: boolean): TreeNode[] => drawn(buildTree(tree.files, tree.marks, showHidden, tree.folders, tree.ignored));

test('the 3-run taskTree draws the tree the recorded 5-run answer drew, with the same files, marks, folders, branch and ignored folders; only the ignored files under an ignored folder are gone (#502)', async (t) => {
  const repo = await treeRepo(t);
  const { root, ...now } = await taskTree(repo, realExec);
  assert.equal(root, repo);
  for (const showHidden of [false, true]) assert.deepEqual(draw(now, showHidden), draw(TODAY_TREE, showHidden), `showHidden: ${showHidden}`);
  assert.deepEqual([now.files, now.marks, now.folders, now.branch, now.ignored.folders], [TODAY_TREE.files, TODAY_TREE.marks, TODAY_TREE.folders, TODAY_TREE.branch, TODAY_TREE.ignored.folders]);
  const isInIgnoredFolder = (path: string): boolean => TODAY_TREE.ignored.folders.some((folder) => path.startsWith(`${folder}/`));
  assert.deepEqual(now.ignored.files, TODAY_TREE.ignored.files.filter((path) => !isInIgnoredFolder(path)));
  // expanded and read from disk, logs/ now draws each of its files once (the recorded answer drew them twice: route and ignored list)
  const loaded = new Map([['logs', { files: ['a.log', 'b.log'], folders: [] }]]);
  const logs = buildTree(now.files, now.marks, false, now.folders, now.ignored, loaded).find((node) => node.path === 'logs');
  assert.deepEqual(logs?.children?.map((node) => node.path), ['logs/a.log', 'logs/b.log']);
});

test('taskTree spawns exactly 3 git runs: the listing, one status v2 and the --directory listing (#502)', async (t) => {
  const repo = await treeRepo(t);
  const calls: string[][] = [];
  const counting: Exec = (file, args, opts) => { calls.push(args); return realExec(file, args, opts); };
  await taskTree(repo, counting);
  // the 7 leading args are gitIn's: --no-optional-locks -C <root> -c core.fsmonitor=false -c core.quotepath=off
  assert.deepEqual(calls.map((args) => args.slice(7).join(' ')).sort(), [
    'ls-files -z --cached --others --exclude-standard',
    'ls-files -z --others --directory --exclude-standard',
    'status --porcelain=v2 -z --branch --untracked-files=normal --ignored=traditional',
  ]);
});
