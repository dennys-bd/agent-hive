import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTreeWatch, MIN_PUSH_MS } from '../src/tree-watch.js';
import type { TreeChange } from '../src/types.js';
import { gitAt, realExec } from './fixtures/tree-repo.js';
import { tempDir } from './temp-dir.js';

const WAIT_MS = 2_000; // Linux's inotify and macOS's FSEvents both answer well inside it; CI runners are slow
const STEP_MS = 25;
const SETTLE_MS = 500; // Linux's recursive watch walks the tree after watch() returns

async function waitFor(check: () => boolean): Promise<boolean> {
  const until = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() > until) return false;
    await sleep(STEP_MS);
  }
  return true;
}

test('on a real worktree an edit, git add, git commit and git switch each push a tree event, git\'s own with no paths; an idle tree pushes nothing and runs no git (#502)', async (t) => {
  const repo = await tempDir(t, 'watch-repo-');
  await realExec('git', ['init', '--quiet', '--initial-branch=main', repo]);
  await writeFile(join(repo, 'a.txt'), 'a');
  await gitAt(repo, 'add', 'a.txt');
  await gitAt(repo, 'commit', '--quiet', '-m', 'init');
  const wt = join(await tempDir(t, 'watch-wt-'), 'wt');
  await gitAt(repo, 'worktree', 'add', '--quiet', '-b', 'feature', wt);
  const changes: TreeChange[] = [];
  const calls: string[][] = [];
  const tree = createTreeWatch({
    log: { warn: (line) => assert.fail(line), debug: () => undefined },
    notify: (change) => changes.push(change),
    exec: async (_file, args) => { calls.push(args); return { stdout: '' }; },
  });
  t.after(() => tree.close());
  await tree.lease('a-1', wt, 'L1', false);
  await sleep(SETTLE_MS);
  changes.length = 0;
  const step = async (name: string, act: () => Promise<unknown>): Promise<TreeChange[]> => {
    await sleep(MIN_PUSH_MS); // the previous step's push window is over: this step's event is its own
    const from = changes.length;
    await act();
    assert.ok(await waitFor(() => changes.length > from), `${name}: no tree event within ${WAIT_MS} ms`);
    return changes.slice(from);
  };
  const edit = await step('edit', () => writeFile(join(wt, 'a.txt'), 'edited'));
  assert.ok(edit.some((change) => change.paths?.includes('a.txt')), 'the edit names its file');
  for (const [name, args] of [['add', ['add', 'a.txt']], ['commit', ['commit', '--quiet', '-m', 'edit']], ['switch', ['switch', '--quiet', '-c', 'other']]] as const) {
    const heard = await step(name, () => gitAt(wt, ...args));
    assert.ok(heard.some((change) => change.paths === undefined), `${name}: the gitdir's index or HEAD pushed with no paths`);
  }
  const idleFrom = changes.length;
  await sleep(3_000);
  assert.equal(changes.length, idleFrom, 'nothing changed: no event');
  assert.deepEqual(calls, [], 'a watching root runs no git');
});
