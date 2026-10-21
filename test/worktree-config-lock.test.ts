import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceBase } from '../src/fork.js';
import type { Exec } from '../src/types.js';
import { ensureWorktree, worktreePath } from '../src/worktree.js';
import { tempDir } from './temp-dir.js';

const SLUG = 'hive-7-fix';
const BRANCH = 'hive/7-fix-the-login';
const ORIGIN: WorkspaceBase = { remote: 'origin', fork: null }; // not a fork (#854)
const LOCK = 'error: could not lock config file .git/config: File exists\nerror: unable to write upstream branch configuration\n';
const refused = (stderr: string): Error => Object.assign(new Error('Command failed: git'), { stderr });

// Two tasks starting at once (two daemons on one repo, or two workers of one) each run `worktree add -b <branch> <path> origin/<base>`,
// and git records the new branch's upstream in .git/config under a lock: the loser gets the lock error after the branch and the
// worktree already exist. `upstreamLocks` is how many set-upstream calls lose the lock too.
function racingGit(path: string, upstreamLocks: number, worktreeLeft = true): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  let added = false;
  let branched = false;
  let locks = upstreamLocks;
  const exec: Exec = async (_file, args) => {
    const command = args.slice(2);
    calls.push(command.join(' '));
    if (command[0] === 'worktree' && command[1] === 'list') return { stdout: added ? `worktree ${path}\nHEAD abc\nbranch refs/heads/${BRANCH}\n\n` : '' };
    if (command[0] === 'worktree' && command[1] === 'add' && command[2] === '-b') { branched = true; added = worktreeLeft; throw refused(LOCK); }
    if (command[0] === 'worktree' && command[1] === 'add') { added = true; return { stdout: '' }; }
    if (command[0] === 'branch' && command[1].startsWith('--set-upstream-to=') && locks > 0) { locks -= 1; throw refused(LOCK); }
    if (command[0] === 'rev-parse' && command.at(-1) === `refs/heads/${BRANCH}`) { if (branched) return { stdout: 'abc\n' }; throw refused(''); }
    if (command[0] === 'symbolic-ref' && command.at(-1) === 'refs/remotes/origin/HEAD') return { stdout: 'origin/main\n' };
    if (command[0] === 'rev-parse' && command.at(-1) === 'refs/remotes/origin/main') return { stdout: 'a1b2c3d\n' };
    return { stdout: '' };
  };
  return { exec, calls };
}

test('ensureWorktree keeps the worktree a concurrent git left without its upstream, and records the upstream once the config lock frees (#105)', async (t) => {
  const repo = await tempDir(t, 'lock-');
  const path = worktreePath(repo, SLUG);
  const { exec, calls } = racingGit(path, 2);
  assert.deepEqual(await ensureWorktree(repo, SLUG, BRANCH, ORIGIN, undefined, exec), { path, line: 'base: origin/main (a1b2c3d)' , start: 'origin/main' });
  const upstream = calls.filter((c) => c.startsWith('branch --set-upstream-to='));
  assert.deepEqual(upstream, Array(3).fill(`branch --set-upstream-to=origin/main ${BRANCH}`), 'two lost the lock, the third recorded it');
  assert.equal(calls.filter((c) => c.startsWith('worktree add')).length, 1, 'the worktree is adopted, never added twice');
});

test('ensureWorktree still rejects with git\'s words when the config lock never frees (#105)', async (t) => {
  const repo = await tempDir(t, 'lock-');
  const { exec } = racingGit(worktreePath(repo, SLUG), Number.POSITIVE_INFINITY);
  await assert.rejects(ensureWorktree(repo, SLUG, BRANCH, ORIGIN, undefined, exec), /could not lock config file/);
});

test('ensureWorktree adds the worktree on the branch git made when the config lock aborted the add before the worktree, then records the upstream (#105)', async (t) => {
  const repo = await tempDir(t, 'lock-');
  const path = worktreePath(repo, SLUG);
  const { exec, calls } = racingGit(path, 1, false);
  assert.deepEqual(await ensureWorktree(repo, SLUG, BRANCH, ORIGIN, undefined, exec), { path, line: 'base: origin/main (a1b2c3d)' , start: 'origin/main' });
  assert.deepEqual(calls.filter((c) => c.startsWith('worktree add')), [`worktree add -b ${BRANCH} -- ${path} origin/main`, `worktree add -- ${path} ${BRANCH}`]);
  assert.equal(calls.filter((c) => c.startsWith('branch --set-upstream-to=')).length, 2, 'one lost the lock, the next recorded it');
});
