import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitIn, parseStatus, TREE_STATUS_ARGS } from '../src/git-status.js';
import { head, ignoredEntry, ordinary, renamed, statusText, unmerged, untracked } from './fixtures/porcelain-v2.js';
import { realExec, treeRepo } from './fixtures/tree-repo.js';

test('parseStatus marks changed files M, untracked or renamed ones A and deleted ones D, which it also lists as deleted; a rename\'s old path is skipped (#903, #502)', () => {
  const { marks, deleted } = parseStatus(statusText(ordinary('.M', 'src/b.ts'), ordinary('.D', 'gone.txt'), untracked('new.txt'), renamed('R.', 'moved.ts', 'old.ts'), ordinary('A.', 'added.ts')));
  assert.deepEqual(marks, { 'src/b.ts': 'M', 'gone.txt': 'D', 'new.txt': 'A', 'moved.ts': 'A', 'added.ts': 'A' });
  assert.deepEqual([...deleted], ['gone.txt']);
  const staged = parseStatus(statusText(ordinary('D.', 'staged.txt'), ordinary('AD', 'added-gone.txt')));
  assert.deepEqual([staged.marks, [...staged.deleted]], [{ 'staged.txt': 'D', 'added-gone.txt': 'D' }, ['staged.txt', 'added-gone.txt']]);
  // a staged delete re-created on disk: `1 D.` then `?`; the later entry wins, the file is back and new
  const back = parseStatus(statusText(ordinary('D.', 'back.txt'), untracked('back.txt')));
  assert.deepEqual([back.marks, [...back.deleted]], [{ 'back.txt': 'A' }, []]);
});

test('parseStatus reads an unmerged entry\'s ten fields and a path with spaces whole (#502)', () => {
  const { marks, deleted } = parseStatus(statusText(unmerged('UU', 'src/con flict.ts'), unmerged('DU', 'a b/gone.ts'), ordinary('.M', 'docs/my notes.md')));
  assert.deepEqual(marks, { 'src/con flict.ts': 'M', 'a b/gone.ts': 'D', 'docs/my notes.md': 'M' });
  assert.deepEqual([...deleted], ['a b/gone.ts']);
});

test('parseStatus lists ignored entries as written and untracked folders apart, marking neither (#502)', () => {
  const status = parseStatus(statusText(ignoredEntry('logs/'), ignoredEntry('debug.log'), untracked('newdir/'), untracked('vendor/lib/'), untracked('loose.txt')));
  assert.deepEqual([status.ignored, status.untracked, status.marks], [['logs/', 'debug.log'], ['newdir/', 'vendor/lib/'], { 'loose.txt': 'A' }]);
});

test('parseStatus reads the branch from # branch.head: a branch, none when detached, the branch of a repository with no commit, none without --branch (#713, #502)', () => {
  assert.equal(parseStatus(statusText(head('feature/x'), '# branch.ab +1 -0')).branch, 'feature/x');
  assert.equal('branch' in parseStatus(statusText(head('(detached)'))), false);
  assert.equal(parseStatus(statusText('# branch.oid (initial)', '# branch.head main')).branch, 'main');
  assert.equal('branch' in parseStatus(statusText(ordinary('.M', 'a.txt'))), false);
});

test('parseStatus reads a real git status run of the tree read (#502)', async (t) => {
  const repo = await treeRepo(t);
  const status = parseStatus(await gitIn(repo, TREE_STATUS_ARGS, realExec));
  assert.deepEqual(status.marks, { 'src/b.ts': 'M', 'gone.txt': 'D', 'moved.ts': 'A' });
  assert.deepEqual([...status.deleted], ['gone.txt']);
  assert.deepEqual([...status.untracked].sort(), ['newdir/', 'vendor/']); // git names the folder holding the untracked nested repo, not the repo
  // traditional + normal: the outermost ignored folder (logs/, not its files), the ignored file of a mixed folder
  assert.deepEqual([...status.ignored].sort(), ['build/app.log', 'debug.log', 'logs/', 'node_modules/']);
  assert.equal(status.branch, 'main');
});
