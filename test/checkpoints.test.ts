import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkpointRef, captureCheckpoint, dropCheckpoints, restoreWorktree } from '../src/checkpoints.js';
import type { Checkpoint } from '../src/types.js';
import { tempDir, type AfterHost } from './temp-dir.js';

const run = promisify(execFile);
const BRANCH = 'hive/7-fix';
const SLUG = 'hive-7-fix';

// The real git, with an identity of its own: the test machine's global config is never read for it. captureCheckpoint brings its own.
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, '-c', 'user.email=hive@example.invalid', '-c', 'user.name=Hive', '-c', 'commit.gpgsign=false', ...args])).stdout.trim();

// A repo on BRANCH with tracked.txt and gone.txt committed and `ignored.txt` in .gitignore
async function repoOn(t: AfterHost): Promise<string> {
  const repo = await tempDir(t, 'repo-');
  await git(repo, 'init', '--quiet', '-b', 'main');
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(repo, 'tracked.txt'), 'one');
  await writeFile(join(repo, 'gone.txt'), 'gone');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '--quiet', '-m', 'root');
  await git(repo, 'switch', '--quiet', '-c', BRANCH);
  return repo;
}

async function commit(repo: string, file: string): Promise<void> {
  await writeFile(join(repo, file), file);
  await git(repo, 'add', file);
  await git(repo, 'commit', '--quiet', '-m', file);
}

const checkpointOf = (n: number, point: { head: string; commit: string; branch: string }): Checkpoint =>
  ({ n, stage: 'dev', start: point.head, ...point, at: new Date().toISOString(), ended: 'done' });

test('captureCheckpoint on a clean worktree keeps HEAD itself as the point under refs/hive/<slug>/checkpoint/<n> (#619)', async (t) => {
  const repo = await repoOn(t);
  const head = await git(repo, 'rev-parse', 'HEAD');
  assert.deepEqual(await captureCheckpoint(repo, repo, SLUG, 1), { head, commit: head, branch: BRANCH });
  assert.equal(await git(repo, 'rev-parse', checkpointRef(SLUG, 1)), head);
});

test('captureCheckpoint on a dirty worktree commits a modified, a deleted and an untracked file on top of HEAD, leaves an ignored one out, and never touches the user\'s index (#619)', async (t) => {
  const repo = await repoOn(t);
  const head = await git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'tracked.txt'), 'changed');
  await rm(join(repo, 'gone.txt'));
  await writeFile(join(repo, 'new.txt'), 'new');
  await writeFile(join(repo, 'ignored.txt'), 'secret');
  await writeFile(join(repo, 'staged.txt'), 'staged');
  await git(repo, 'add', 'staged.txt');
  const index = await git(repo, 'diff', '--cached', '--name-only');
  const point = await captureCheckpoint(repo, repo, SLUG, 2);
  assert.notEqual(point.commit, head);
  assert.equal(await git(repo, 'rev-parse', `${point.commit}^`), head, 'the point\'s parent is HEAD');
  assert.deepEqual((await git(repo, 'ls-tree', '--name-only', point.commit)).split('\n').sort(), ['.gitignore', 'new.txt', 'staged.txt', 'tracked.txt']);
  assert.equal(await git(repo, 'show', `${point.commit}:tracked.txt`), 'changed');
  assert.equal(await git(repo, 'diff', '--cached', '--name-only'), index, 'the user\'s index is as it was');
  assert.equal(await git(repo, 'rev-parse', checkpointRef(SLUG, 2)), point.commit);
});

test('captureCheckpoint refuses when git prints no HEAD, writing no ref (#619)', async () => {
  const calls: string[][] = [];
  await assert.rejects(captureCheckpoint('/repo', '/wt', SLUG, 1, async (_file, args) => { calls.push(args); return { stdout: '' }; }));
  assert.deepEqual(calls, [['-C', '/wt', 'rev-parse', 'HEAD']]);
});

test('restoreWorktree in reset mode moves the branch back to the checkpoint\'s head and puts its work back unstaged, its untracked file untracked (#619)', async (t) => {
  const repo = await repoOn(t);
  await writeFile(join(repo, 'tracked.txt'), 'checkpoint work');
  await writeFile(join(repo, 'new.txt'), 'new');
  const checkpoint = checkpointOf(1, await captureCheckpoint(repo, repo, SLUG, 1));
  await git(repo, 'checkout', '--', 'tracked.txt');
  await rm(join(repo, 'new.txt'));
  await commit(repo, 'later.txt');
  await restoreWorktree(repo, BRANCH, checkpoint, { mode: 'reset' });
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), checkpoint.head);
  assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'checkpoint work');
  assert.equal(await git(repo, 'diff', '--cached', '--name-only'), '', 'nothing staged');
  assert.equal(await git(repo, 'diff', '--name-only'), 'tracked.txt');
  assert.equal(await git(repo, 'ls-files', '--others', '--exclude-standard'), 'new.txt');
});

test('restoreWorktree in branch mode leaves the published branch at its commits and checks the new branch out at the checkpoint\'s head, its work unstaged (#619)', async (t) => {
  const repo = await repoOn(t);
  await writeFile(join(repo, 'tracked.txt'), 'checkpoint work');
  const checkpoint = checkpointOf(1, await captureCheckpoint(repo, repo, SLUG, 1));
  await git(repo, 'checkout', '--', 'tracked.txt');
  await commit(repo, 'later.txt');
  const published = await git(repo, 'rev-parse', 'HEAD');
  await restoreWorktree(repo, BRANCH, checkpoint, { mode: 'branch', newBranch: `${BRANCH}-r2` });
  assert.equal(await git(repo, 'symbolic-ref', '--short', 'HEAD'), `${BRANCH}-r2`);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), checkpoint.head);
  assert.equal(await git(repo, 'rev-parse', BRANCH), published, 'the published branch keeps its commits');
  assert.equal(await git(repo, 'diff', '--name-only'), 'tracked.txt');
});

test('dropCheckpoints deletes every checkpoint ref of the slug, leaves another slug\'s, and none is nothing to drop (#619)', async (t) => {
  const repo = await repoOn(t);
  await dropCheckpoints(repo, SLUG);
  await captureCheckpoint(repo, repo, SLUG, 1);
  await captureCheckpoint(repo, repo, SLUG, 2);
  await captureCheckpoint(repo, repo, 'hive-8-other', 1);
  await dropCheckpoints(repo, SLUG);
  assert.equal(await git(repo, 'for-each-ref', `refs/hive/${SLUG}/`), '');
  assert.notEqual(await git(repo, 'for-each-ref', 'refs/hive/hive-8-other/'), '');
});
