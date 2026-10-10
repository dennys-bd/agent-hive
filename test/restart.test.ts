import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { COMMIT_GONE_MESSAGE, discarded, dropStageStart, leftBehind, recordStageStart, restartPlan, restartWorktree, stageStartRef } from '../src/restart.js';
import { tempDir, type AfterHost } from './temp-dir.js';

const run = promisify(execFile);
const BRANCH = 'hive/7-fix';
const SLUG = 'hive-7-fix';

// The real git, with an identity of its own: the test machine's global config is never read for it.
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, '-c', 'user.email=hive@example.invalid', '-c', 'user.name=Hive', '-c', 'commit.gpgsign=false', ...args])).stdout.trim();

// A clone on BRANCH with one root commit, `ignored.txt` in .gitignore, and a bare `origin` next to it.
async function repoWithRemote(t: AfterHost): Promise<{ repo: string; remote: string }> {
  const remote = await tempDir(t, 'remote-');
  await git(remote, 'init', '--quiet', '--bare', '-b', 'main');
  const repo = await tempDir(t, 'repo-');
  await git(repo, 'init', '--quiet', '-b', 'main');
  await git(repo, 'remote', 'add', 'origin', remote);
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  await git(repo, 'add', '.gitignore');
  await git(repo, 'commit', '--quiet', '-m', 'root');
  await git(repo, 'switch', '--quiet', '-c', BRANCH);
  return { repo, remote };
}

async function commit(repo: string, file: string): Promise<void> {
  await writeFile(join(repo, file), file);
  await git(repo, 'add', file);
  await git(repo, 'commit', '--quiet', '-m', file);
}

// What a gc leaves: only what a ref still reaches.
async function collect(repo: string): Promise<void> {
  await git(repo, 'reflog', 'expire', '--expire=now', '--all');
  await git(repo, 'gc', '--quiet', '--prune=now');
}

test('recordStageStart answers HEAD and keeps it as refs/hive/<slug>/stage-start (#283)', async (t) => {
  const { repo } = await repoWithRemote(t);
  const sha = await recordStageStart(repo, repo, SLUG);
  assert.equal(sha, await git(repo, 'rev-parse', 'HEAD'));
  assert.equal(await git(repo, 'rev-parse', stageStartRef(SLUG)), sha);
});

test('restartPlan: a branch origin does not have, or has at the starting commit, is reset in place (#283)', async (t) => {
  const { repo } = await repoWithRemote(t);
  const start = (await recordStageStart(repo, repo, SLUG))!;
  await commit(repo, 'a.txt');
  assert.deepEqual(await restartPlan(repo, BRANCH, BRANCH, start), { mode: 'reset' }, 'never pushed');
  await git(repo, 'push', '--quiet', 'origin', `${start}:refs/heads/${BRANCH}`);
  assert.deepEqual(await restartPlan(repo, BRANCH, BRANCH, start), { mode: 'reset' }, 'origin sits at the starting commit');
});

test('restartPlan: a published branch that moved gives the first <branch>-r<n> neither local nor on origin, and a failed ls-remote gives the branch mode too; the ref keeps the commit through an --amend, a push -f and a gc (#283)', async (t) => {
  const { repo } = await repoWithRemote(t);
  await commit(repo, 'a.txt');
  const start = (await recordStageStart(repo, repo, SLUG))!;
  await git(repo, 'push', '--quiet', 'origin', BRANCH);
  await git(repo, 'commit', '--quiet', '--amend', '-m', 'a amended');
  await git(repo, 'push', '--quiet', '-f', 'origin', BRANCH);
  await collect(repo);
  await git(repo, 'branch', `${BRANCH}-r2`);
  await git(repo, 'push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}-r3`);
  assert.deepEqual(await restartPlan(repo, BRANCH, BRANCH, start), { mode: 'branch', newBranch: `${BRANCH}-r4` });
  await git(repo, 'remote', 'set-url', 'origin', join(repo, 'no-such-remote'));
  assert.deepEqual(await restartPlan(repo, BRANCH, BRANCH, start), { mode: 'branch', newBranch: `${BRANCH}-r3` }, 'offline: only the local branches are known');
});

test('restartPlan refuses a starting commit git no longer has (#283)', async (t) => {
  const { repo } = await repoWithRemote(t);
  await commit(repo, 'a.txt');
  const start = (await recordStageStart(repo, repo, SLUG))!;
  await git(repo, 'update-ref', '-d', stageStartRef(SLUG));
  await git(repo, 'commit', '--quiet', '--amend', '-m', 'a amended');
  await collect(repo);
  await assert.rejects(restartPlan(repo, BRANCH, BRANCH, start), { message: COMMIT_GONE_MESSAGE });
});

test('restartWorktree resets to the commit and removes untracked files but keeps ignored ones; the branch mode then moves to the new branch there, leaving the old one as it was; discarded counts the commits the reset discards (#283)', async (t) => {
  const { repo } = await repoWithRemote(t);
  const start = (await recordStageStart(repo, repo, SLUG))!;
  await commit(repo, 'a.txt');
  assert.equal((await discarded(repo, BRANCH, start, { mode: 'reset' })).commits, 1);
  await writeFile(join(repo, 'untracked.txt'), 'x');
  await writeFile(join(repo, 'ignored.txt'), 'x');
  await writeFile(join(repo, '.gitignore'), 'changed\n'); // an uncommitted change
  await restartWorktree(repo, BRANCH, start, { mode: 'reset' });
  assert.deepEqual([await git(repo, 'rev-parse', 'HEAD'), await git(repo, 'branch', '--show-current')], [start, BRANCH]);
  assert.equal(await git(repo, 'status', '--porcelain', '--ignored'), '!! ignored.txt', 'no -x: node_modules and .env survive');
  await commit(repo, 'b.txt');
  const old = await git(repo, 'rev-parse', 'HEAD');
  await restartWorktree(repo, BRANCH, start, { mode: 'branch', newBranch: `${BRANCH}-r2` });
  assert.deepEqual([await git(repo, 'branch', '--show-current'), await git(repo, 'rev-parse', 'HEAD')], [`${BRANCH}-r2`, start]);
  assert.equal(await git(repo, 'rev-parse', BRANCH), old, 'the old branch is left as it is');
});

test('leftBehind lists the own branches a Restart moved the task away from, none while it is on the template; dropStageStart removes the ref, and a ref already gone is nothing (#283)', async (t) => {
  const { repo } = await repoWithRemote(t);
  await git(repo, 'branch', `${BRANCH}-r2`);
  await git(repo, 'branch', `${BRANCH}-rx`); // not a variant
  await git(repo, 'branch', 'hive/7-fix-other');
  assert.deepEqual(await leftBehind(repo, { branch: BRANCH }, BRANCH), []);
  assert.deepEqual(await leftBehind(repo, { branch: `${BRANCH}-r3` }, BRANCH), [BRANCH, `${BRANCH}-r2`]);
  await recordStageStart(repo, repo, SLUG);
  await dropStageStart(repo, SLUG);
  await assert.rejects(git(repo, 'rev-parse', '--verify', '--quiet', stageStartRef(SLUG)));
  await dropStageStart(repo, SLUG);
});

test('a second Restart on a published <template>-r2 that moved gives <template>-r3, never a variant of the variant (#283)', async (t) => {
  const { repo } = await repoWithRemote(t);
  await commit(repo, 'a.txt');
  const start = (await recordStageStart(repo, repo, SLUG))!;
  await git(repo, 'push', '--quiet', 'origin', BRANCH);
  await commit(repo, 'b.txt');
  await git(repo, 'push', '--quiet', 'origin', BRANCH); // published past the start: the first Restart branches off
  const first = await restartPlan(repo, BRANCH, BRANCH, start);
  assert.deepEqual(first, { mode: 'branch', newBranch: `${BRANCH}-r2` });
  await git(repo, 'switch', '--quiet', '-c', `${BRANCH}-r2`, start);
  await commit(repo, 'c.txt');
  await git(repo, 'push', '--quiet', 'origin', `${BRANCH}-r2`); // the variant is published and moved too
  assert.deepEqual(await restartPlan(repo, `${BRANCH}-r2`, BRANCH, start), { mode: 'branch', newBranch: `${BRANCH}-r3` });
  await git(repo, 'push', '--quiet', 'origin', `${start}:refs/heads/${BRANCH}-r2`, '-f');
  assert.deepEqual(await restartPlan(repo, `${BRANCH}-r2`, BRANCH, start), { mode: 'reset' }, 'the variant on origin sits at the start: reset in place');
});

test('restartWorktree and discarded refuse a worktree git does not see as its own checkout: a directory whose .git is gone would walk up to the main repo, which is left untouched (#283)', async (t) => {
  const { repo } = await repoWithRemote(t);
  const start = (await recordStageStart(repo, repo, SLUG))!;
  await commit(repo, 'a.txt');
  const worktree = join(repo, '.hive', 'worktrees', SLUG);
  await git(repo, 'worktree', 'add', '--quiet', '-b', 'hive/7-other', worktree);
  await rm(join(worktree, '.git')); // the pointer file a linked worktree has: without it git walks up
  await writeFile(join(repo, 'untracked.txt'), 'keep me');
  const head = await git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(restartWorktree(worktree, BRANCH, start, { mode: 'reset' }), /não é um checkout git próprio/);
  await assert.rejects(discarded(worktree, BRANCH, start, { mode: 'reset' }), /não é um checkout git próprio/);
  assert.deepEqual([await git(repo, 'rev-parse', 'HEAD'), await readFile(join(repo, 'untracked.txt'), 'utf8')], [head, 'keep me'], 'the main repo is untouched');
});

test('restartWorktree refuses a worktree checked out on another branch than the task\'s, and changes nothing there (#283)', async (t) => {
  const { repo } = await repoWithRemote(t);
  const start = (await recordStageStart(repo, repo, SLUG))!;
  const worktree = join(repo, '.hive', 'worktrees', SLUG);
  await mkdir(join(repo, '.hive', 'worktrees'), { recursive: true });
  await git(repo, 'worktree', 'add', '--quiet', '-b', 'hive/7-other', worktree);
  await commit(worktree, 'b.txt');
  const head = await git(worktree, 'rev-parse', 'HEAD');
  await assert.rejects(restartWorktree(worktree, BRANCH, start, { mode: 'reset' }), /hive\/7-other/);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), head);
});

// After the stage start: a.txt and b.txt committed, then a.txt changed again, kept.txt (tracked before the start) modified, staged.txt staged
// and never committed, untracked.txt new, and ignored.txt, which .gitignore covers
async function dirtyAfterStart(t: AfterHost): Promise<{ repo: string; start: string }> {
  const { repo } = await repoWithRemote(t);
  await commit(repo, 'kept.txt');
  const start = (await recordStageStart(repo, repo, SLUG))!;
  await commit(repo, 'a.txt');
  await commit(repo, 'b.txt');
  await writeFile(join(repo, 'a.txt'), 'changed');
  await writeFile(join(repo, 'kept.txt'), 'changed');
  await writeFile(join(repo, 'staged.txt'), 's');
  await git(repo, 'add', 'staged.txt');
  await writeFile(join(repo, 'untracked.txt'), 'u');
  await writeFile(join(repo, 'ignored.txt'), 'i');
  return { repo, start };
}

test('discarded in reset mode counts the commits past the start and each file the reset and the clean discard once: committed, modified, staged and untracked, never an ignored one (#580)', async (t) => {
  const { repo, start } = await dirtyAfterStart(t);
  assert.deepEqual(await discarded(repo, BRANCH, start, { mode: 'reset' }), { commits: 2, files: 5 }, 'a.txt, b.txt, kept.txt, staged.txt, untracked.txt');
});

test('discarded in branch mode counts only the uncommitted and untracked files: the commits stay on the published branch (#580)', async (t) => {
  const { repo, start } = await dirtyAfterStart(t);
  assert.deepEqual(await discarded(repo, BRANCH, start, { mode: 'branch', newBranch: `${BRANCH}-r2` }), { commits: 2, files: 4 }, 'b.txt is committed: it stays');
});
