import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Exec } from '../src/types.js';
import { baseOptions, branchAt, taskDir, checkBase, ensureCheckout, ensureWorktree, listWorktrees, workspacePathProblem, worktreePath } from '../src/worktree.js';
import { cleanWorktree } from '../src/worktree-remove.js';
import { LOCAL_DISK } from '../src/machine-local.js';
import type { WorkspaceBase } from '../src/fork.js';
import { workspaceBase } from '../src/fork.js';
import { pathsOf } from '../src/machine.js';
import { HOST_PATHS } from './fake-machine.js';
import { fakeMachine, tempHive } from './fakes.js';
import { BRANCH, CLEAN_BRANCH, fakeExec, listing, porcelain, repoWith, SLUG } from './worktree-fakes.js';
import { tempDir } from './temp-dir.js';

test('branchAt reads the branch of the listed worktree; detached is null; not listed is undefined', () => {
  const text = listing('/r', worktreePath(HOST_PATHS, '/r', 'hive-7-fix'));
  assert.equal(branchAt(text, worktreePath(HOST_PATHS, '/r', 'hive-7-fix'), HOST_PATHS), 'feat/x');
  assert.equal(branchAt(text, '/r', HOST_PATHS), 'main');
  assert.equal(branchAt(text, '/r/other', HOST_PATHS), null);
  assert.equal(branchAt(text, worktreePath(HOST_PATHS, '/r', 'hive-7-fix-2'), HOST_PATHS), undefined, 'a prefix of a listed path is not that path');
  assert.equal(branchAt('', '/r', HOST_PATHS), undefined);
});

test('branchAt finds the block git prints as C:/… when asked for the native C:\\… on win32, and not on linux (#640)', () => {
  const text = 'worktree C:/repo/.hive/worktrees/wt\nHEAD 2222\nbranch refs/heads/feat/x\n';
  assert.equal(branchAt(text, 'C:\\repo\\.hive\\worktrees\\wt', pathsOf('win32')), 'feat/x');
  assert.equal(branchAt(text, 'C:\\repo\\.hive\\worktrees\\wt', pathsOf('linux')), undefined);
});

test('workspacePathProblem accepts only the top level of a git work tree, compared by real path, and says why otherwise', async (t) => {
  const { repo } = await tempHive(t);
  assert.equal(await workspacePathProblem(LOCAL_DISK, repo), undefined, 'the temp dir answers /var/…, git /private/var/…: the realpath makes them one');
  const sub = join(repo, 'src');
  await mkdir(sub);
  assert.match((await workspacePathProblem(LOCAL_DISK, sub)) ?? '', /src is not the top level of its git repository/);
  assert.match((await workspacePathProblem(LOCAL_DISK, join(repo, 'missing'))) ?? '', /missing is not a git repository \(/);
  assert.match((await workspacePathProblem(LOCAL_DISK, await tempDir(t, 'plain-'))) ?? '', /is not a git repository/);
  assert.equal(await workspacePathProblem(LOCAL_DISK, 'relative/repo'), 'relative/repo: the workspace folder must be an absolute path');
});

// ---- ensureWorktree: the Hive creates and owns the worktree, on a base it refreshes first ----

const SLUG_7 = 'hive-7-fix'; // the slug repoWith() builds its directories for
const NO_BRANCH = [`refs/heads/${BRANCH}`]; // rev-parse --verify on a branch git does not have exits 1
const ORIGIN: WorkspaceBase = { remote: 'origin', fork: null }; // a workspace that is not a fork, with no base of its own (#854)

// ensureWorktree's git: answers `out` per command, refuses the ones in `refuse` with git's stderr, records every argv after
// `-C <repo>`. The key is the first two words, except for rev-parse (keyed by the ref it reads: the fast-forwarded HEAD,
// origin/<base>, a chosen base and the task's own branch are all in play) and for-each-ref (keyed by the prefix it lists).
function baseGit(out: Record<string, string> = {}, refuse: string[] = []): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const keyOf = (command: string[]): string =>
    (command[0] === 'rev-parse' || command[0] === 'for-each-ref' ? (command.at(-1) as string) : command.slice(0, 2).join(' '));
  const exec: Exec = async (file, args) => {
    assert.equal(file, 'git');
    const command = args.slice(2);
    calls.push(command);
    const key = keyOf(command);
    if (refuse.includes(key)) throw Object.assign(new Error(`Command failed: git ${command.join(' ')}`), { stderr: `fatal: ${key} refused\n` });
    return { stdout: out[key] ?? '' };
  };
  return { exec, calls };
}

test('ensureWorktree on a path git does not list refreshes the base, then creates the branch and the worktree under .hive/worktrees at that path', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const { exec, calls } = baseGit({ 'symbolic-ref --short': 'origin/main\n', 'refs/remotes/origin/main': 'a1b2c3d\n' }, NO_BRANCH);
  assert.deepEqual(await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined), { path: worktree, line: 'base: origin/main (a1b2c3d)' , start: 'origin/main' });
  assert.deepEqual(calls, [
    ['worktree', 'list', '--porcelain'],
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    ['fetch', 'origin', '--end-of-options', 'main'], // the base never reaches git as something it could read as an option
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    ['status', '--porcelain', '--untracked-files=no'],
    ['rev-parse', '--verify', '--quiet', '--short', 'refs/remotes/origin/main'],
    ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`],
    ['worktree', 'add', '-b', BRANCH, '--', worktree, 'origin/main'],
  ]);
});

test('a branch that already exists with work of its own is reused (no -b and no start point) and answered as reused: a respawn or a continue of the same task must find its own commits (#267)', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const answered = baseGit({ 'refs/remotes/origin/main': 'a1b2c3d\n', [`refs/heads/${BRANCH}`]: 'deadbee\n' });
  // own: a merge base with the start (exit 0), and not an ancestor of it (exit 1)
  const exec: Exec = async (file, args) => (args.includes('--is-ancestor') ? Promise.reject(Object.assign(new Error('exit 1'), { code: 1 })) : answered.exec(file, args));
  const { path, line, reused } = await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined);
  assert.deepEqual([path, line, reused], [worktree, 'base: origin/main (a1b2c3d)', BRANCH]);
  assert.deepEqual(answered.calls.at(-1), ['worktree', 'add', '--', worktree, BRANCH], 'no -b and no origin/main: the work on that branch survives');
});

test('a path git already lists on our own branch whose directory is there is adopted as is: nothing is created and the base is never touched, which is what a respawn after a kill needs', async (t) => {
  const { repo, worktree } = await repoWith(t, { worktree: true });
  const { exec, calls } = baseGit({ 'worktree list': listing(repo, worktree, `branch refs/heads/${BRANCH}`) });
  assert.deepEqual(await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined), { path: worktree }, 'no line: work in progress decides no base');
  assert.deepEqual(calls, [['worktree', 'list', '--porcelain']], 'no fetch, no add, no prune, no rev-parse');
});

test('a worktree at our path checked out on another branch is not ours: it is rejected by name, never adopted, because a close would force-delete that branch', async (t) => {
  const { repo, worktree } = await repoWith(t, { worktree: true });
  const { exec, calls } = baseGit({ 'worktree list': listing(repo, worktree) }); // someone pre-staged the path on feat/x
  await assert.rejects(ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined), (err: Error) => {
    assert.match(err.message, /feat\/x/, 'the message names the branch found');
    assert.ok(err.message.includes(worktree), 'and the path');
    return true;
  });
  assert.deepEqual(calls, [['worktree', 'list', '--porcelain']], 'nothing is fetched, added or pruned');
});

test('a worktree at our path on a detached HEAD is rejected too: no branch there is the branch the Hive rendered', async (t) => {
  const { repo, worktree } = await repoWith(t, { worktree: true });
  const { exec, calls } = baseGit({ 'worktree list': listing(repo, worktree, 'detached') });
  await assert.rejects(ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined), { message: new RegExp(`${BRANCH}$`) });
  assert.equal(calls.length, 1, 'nothing is fetched, added or pruned');
});

test('a path git lists whose directory is gone is pruned first, then added', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const { exec, calls } = baseGit({ 'worktree list': listing(repo, worktree), 'refs/remotes/origin/main': 'a1b2c3d\n' }, NO_BRANCH);
  assert.equal((await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined)).path, worktree);
  assert.deepEqual(calls.slice(0, 2), [['worktree', 'list', '--porcelain'], ['worktree', 'prune']], 'a stale entry for a path that no longer exists would refuse the add');
  assert.deepEqual(calls.at(-1), ['worktree', 'add', '-b', BRANCH, '--', worktree, 'origin/main']);
});

test('an add git refuses rejects with git\'s own stderr, not with execFile\'s message: that text is what the task shows', async (t) => {
  const { repo } = await repoWith(t);
  const stderr = `fatal: '${BRANCH}' is already checked out at '/somewhere/else'\n`;
  const { exec } = fakeExec({ failing: 'add', message: 'Command failed: git -C /r worktree add …', stderr });
  await assert.rejects(ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined), { message: stderr.trim() }, 'the spawn turns this into spawnFailed: the task keeps git\'s words');
});

test('on the base branch and clean: fetch, fast-forward the checkout, and the line names both shas', async (t) => {
  const { repo, worktree } = await repoWith(t);
  // The two shas differ only so the line's halves can be told apart; a real fast-forward leaves HEAD on origin/main's commit.
  const { exec, calls } = baseGit({ 'symbolic-ref --quiet': 'main\n', HEAD: 'e4f5a6b\n', 'refs/remotes/origin/main': 'a1b2c3d\n' }, NO_BRANCH);
  const { line } = await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined);
  assert.equal(line, 'base: origin/main (a1b2c3d) (checkout fast-forwarded to e4f5a6b)');
  assert.deepEqual(calls.slice(1, 7), [
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    ['fetch', 'origin', '--end-of-options', 'main'],
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    ['status', '--porcelain', '--untracked-files=no'],
    ['merge', '--ff-only', 'origin/main'],
    ['rev-parse', '--short', 'HEAD'],
  ], 'the user would run the same fast-forward by hand; nothing else touches their tree');
  assert.deepEqual(calls.at(-1), ['worktree', 'add', '-b', BRANCH, '--', worktree, 'origin/main'], 'the worktree still branches from origin/main: the fast-forward is a courtesy to the checkout');
});

test('a merge that worked is reported as a fast-forward even when the sha cannot be read afterwards', async (t) => {
  const { repo } = await repoWith(t);
  // HEAD already moved: a line saying nothing happened would be a lie.
  const { exec } = baseGit({ 'symbolic-ref --quiet': 'main\n', 'refs/remotes/origin/main': 'a1b2c3d\n' }, [...NO_BRANCH, 'HEAD']);
  assert.equal((await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined)).line, 'base: origin/main (a1b2c3d) (checkout fast-forwarded)');
});

test('dirty, on another branch or detached: the checkout is never merged into and the worktree is created from origin/<base> all the same', async (t) => {
  for (const [why, answers] of [
    ['dirty', { 'symbolic-ref --quiet': 'main\n', 'status --porcelain': ' M src/server.ts\n' }],
    ['another branch', { 'symbolic-ref --quiet': 'feature/x\n' }],
    ['detached HEAD', {}], // symbolic-ref --quiet answers nothing
  ] as [string, Record<string, string>][]) {
    const { repo, worktree } = await repoWith(t);
    const { exec, calls } = baseGit({ ...answers, 'refs/remotes/origin/main': 'a1b2c3d\n' }, NO_BRANCH);
    assert.equal((await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined)).line, 'base: origin/main (a1b2c3d)', why);
    assert.equal(calls.some((c) => c[0] === 'merge'), false, why);
    assert.deepEqual(calls.at(-1), ['worktree', 'add', '-b', BRANCH, '--', worktree, 'origin/main'], why);
  }
});

test('a fast-forward git refuses (the checkout diverged) changes nothing about the start: the local commits stay where they are', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const { exec, calls } = baseGit({ 'symbolic-ref --quiet': 'main\n', 'refs/remotes/origin/main': 'a1b2c3d\n' }, [...NO_BRANCH, 'merge --ff-only']);
  assert.equal((await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined)).line, 'base: origin/main (a1b2c3d)');
  assert.deepEqual(calls.at(-1), ['worktree', 'add', '-b', BRANCH, '--', worktree, 'origin/main']);
});

test('a fetch that fails never stops the start: with origin/<base> in the local refs the line names the failure; without it the worktree branches from the local HEAD', async (t) => {
  const offline = 'fetch origin';
  const stale = await repoWith(t);
  const withRef = baseGit({ 'refs/remotes/origin/main': 'a1b2c3d\n' }, [...NO_BRANCH, offline]);
  assert.equal((await ensureWorktree(fakeMachine({ exec: withRef.exec }), stale.repo, SLUG_7, BRANCH, ORIGIN, undefined)).line, 'base: origin/main (a1b2c3d) (fetch failed: fatal: fetch origin refused)');
  assert.deepEqual(withRef.calls.at(-1), ['worktree', 'add', '-b', BRANCH, '--', stale.worktree, 'origin/main']);
  const fresh = await repoWith(t);
  const noRef = baseGit({}, [...NO_BRANCH, offline]);
  assert.equal((await ensureWorktree(fakeMachine({ exec: noRef.exec }), fresh.repo, SLUG_7, BRANCH, ORIGIN, undefined)).line, 'base: origin/main unknown (fetch failed: fatal: fetch origin refused), starting from the local base');
  assert.deepEqual(noRef.calls.at(-1), ['worktree', 'add', '-b', BRANCH, '--', fresh.worktree], 'no ref to branch from: no start point, and git uses the checkout\'s HEAD');
});

test('the base step never rejects: any git failure inside it becomes the line and the worktree is still created', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const { exec, calls } = baseGit({}, [...NO_BRANCH, 'status --porcelain']);
  assert.equal((await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined)).line, 'base: fatal: status --porcelain refused, starting from the local base');
  assert.deepEqual(calls.at(-1), ['worktree', 'add', '-b', BRANCH, '--', worktree], 'only the adoption check and the add ever reject');
});

test('the base is config.baseBranch, else what origin/HEAD points at, else main', async (t) => {
  const { repo } = await repoWith(t);
  const configured = baseGit({}, NO_BRANCH);
  await ensureWorktree(fakeMachine({ exec: configured.exec }), repo, SLUG_7, BRANCH, { ...ORIGIN, branch: 'develop' }, undefined);
  assert.deepEqual(configured.calls[1], ['fetch', 'origin', '--end-of-options', 'develop'], 'no symbolic-ref at all: the config decides');
  const remote = baseGit({ 'symbolic-ref --short': 'origin/master\n' }, NO_BRANCH);
  await ensureWorktree(fakeMachine({ exec: remote.exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined);
  assert.deepEqual(remote.calls[2], ['fetch', 'origin', '--end-of-options', 'master'], 'a repo on master works with no config');
  const noSymref = baseGit({}, [...NO_BRANCH, 'symbolic-ref --short']);
  await ensureWorktree(fakeMachine({ exec: noSymref.exec }), repo, SLUG_7, BRANCH, ORIGIN, undefined);
  assert.deepEqual(noSymref.calls[2], ['remote', 'set-head', 'origin', '--auto'], 'a missing symref is set once from the remote');
  assert.deepEqual(noSymref.calls[4], ['fetch', 'origin', '--end-of-options', 'main'], 'still none: main');
});

// ---- a base chosen by hand (#131) ----

test('a chosen local branch is the start point as it is: no fetch, no fast-forward, and the line says it was chosen by hand', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const { exec, calls } = baseGit({ 'refs/heads/hive/41-parent': 'b2c3d4e\n' }, NO_BRANCH);
  assert.deepEqual(await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, 'hive/41-parent'), { path: worktree, line: 'base: hive/41-parent (b2c3d4e), chosen by hand' , start: 'hive/41-parent' });
  assert.deepEqual(calls, [
    ['worktree', 'list', '--porcelain'],
    ['rev-parse', '--verify', '--short', 'refs/heads/hive/41-parent'],
    ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`],
    ['worktree', 'add', '-b', BRANCH, '--', worktree, 'hive/41-parent'],
  ], 'the parent task\'s committed state; the user\'s checkout is never read or written');
});

test('a chosen origin/<x> is fetched first, then the worktree branches from origin/<x>', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const { exec, calls } = baseGit({ 'refs/remotes/origin/feature-x': 'c3d4e5f\n' }, NO_BRANCH);
  assert.deepEqual(await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, { ...ORIGIN, branch: 'develop' }, 'origin/feature-x'), { path: worktree, line: 'base: origin/feature-x (c3d4e5f), chosen by hand' , start: 'origin/feature-x' });
  assert.deepEqual(calls, [
    ['worktree', 'list', '--porcelain'],
    ['fetch', 'origin', '--end-of-options', 'feature-x'],
    ['rev-parse', '--verify', '--short', 'refs/remotes/origin/feature-x'],
    ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`],
    ['worktree', 'add', '-b', BRANCH, '--', worktree, 'origin/feature-x'],
  ], 'config.baseBranch plays no part: the chosen base replaces the #119 step entirely');
});

test('a chosen base that does not resolve rejects with git\'s words and creates nothing: the user asked for that code, a fallback would start on the wrong one', async (t) => {
  const local = await repoWith(t);
  const gone = baseGit({}, [...NO_BRANCH, 'refs/heads/gone']);
  await assert.rejects(ensureWorktree(fakeMachine({ exec: gone.exec }), local.repo, SLUG_7, BRANCH, ORIGIN, 'gone'), { message: 'base: gone unknown (fatal: refs/heads/gone refused)' });
  assert.equal(gone.calls.some((c) => c[0] === 'worktree' && c[1] === 'add'), false);
  const remote = await repoWith(t);
  const offline = baseGit({}, [...NO_BRANCH, 'fetch origin', 'refs/remotes/origin/gone']);
  await assert.rejects(ensureWorktree(fakeMachine({ exec: offline.exec }), remote.repo, SLUG_7, BRANCH, ORIGIN, 'origin/gone'),
    { message: 'base: origin/gone unknown (fatal: refs/remotes/origin/gone refused) (fetch failed: fatal: fetch origin refused)' });
  assert.equal(offline.calls.some((c) => c[0] === 'worktree' && c[1] === 'add'), false);
});

test('a task whose worktree already exists is adopted as is: a chosen base changes nothing and reaches no git command', async (t) => {
  const { repo, worktree } = await repoWith(t, { worktree: true });
  const { exec, calls } = baseGit({ 'worktree list': listing(repo, worktree, `branch refs/heads/${BRANCH}`) });
  assert.deepEqual(await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, ORIGIN, 'hive/41-parent'), { path: worktree });
  assert.deepEqual(calls, [['worktree', 'list', '--porcelain']]);
});

test('baseOptions: the default, the other tasks that have a worktree (git\'s branch there), the other local branches, and origin/* apart; nothing is fetched', async (t) => {
  const { repo } = await repoWith(t);
  const parent = worktreePath(HOST_PATHS, repo, 'hive-41-parent');
  const listed = [`worktree ${repo}\nHEAD 1111\nbranch refs/heads/main\n`, `worktree ${parent}\nHEAD 2222\nbranch refs/heads/hive/41-parent\n`].join('\n');
  const { exec, calls } = baseGit({
    'worktree list': listed,
    'symbolic-ref --short': 'origin/main\n',
    'refs/remotes/origin': `${['refs/heads/main', 'refs/heads/hive/41-parent', 'refs/heads/feature-x', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/feature-y'].join('\n')}\n`,
  });
  const others = [{ slug: 'hive-41-parent', id: '41', title: 'Parent' }, { slug: 'hive-42-queued', id: '42', title: 'Never ran' }];
  assert.deepEqual(await baseOptions(fakeMachine({ exec }), repo, SLUG_7, others, ORIGIN), {
    hasWorktree: false,
    defaultRef: 'origin/main',
    tasks: [{ ref: 'hive/41-parent', id: '41', title: 'Parent' }], // #42 has no worktree: nothing committed to branch from
    local: ['feature-x'], // main is the default's own branch, hive/41-parent is already under tasks
    remote: ['origin/feature-y'], // origin/HEAD is an alias, origin/main is the default
  });
  assert.deepEqual(new Set(calls.map((c) => c.join(' '))), new Set([
    ['worktree', 'list', '--porcelain'].join(' '),
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'].join(' '),
    ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'].join(' '),
  ]), 'read-only: no fetch, so the popup opens at once; the three reads run in parallel, order unconstrained');
  assert.equal(calls.length, 3);
  assert.equal((await baseOptions(fakeMachine({ exec }), repo, SLUG_7, [], { ...ORIGIN, branch: 'develop' })).defaultRef, 'origin/develop', 'config.baseBranch names the default');
});

test('baseOptions with the task\'s branch (it has no activity, #861): what git holds for the slug is an orphan, and the lists are read so a discard can pick a base', async (t) => {
  const present = await repoWith(t, { worktree: true });
  const both = baseGit({ 'worktree list': listing(present.repo, present.worktree, `branch refs/heads/${BRANCH}`), 'refs/remotes/origin': 'refs/heads/main\nrefs/heads/feature-x\n' });
  assert.deepEqual(await baseOptions(fakeMachine({ exec: both.exec }), present.repo, SLUG_7, [], ORIGIN, BRANCH), { hasWorktree: false, defaultRef: 'origin/main', tasks: [], local: ['feature-x'], remote: [], orphan: { worktree: true, branch: true, relation: 'stale', branchName: BRANCH } });
  const gone = await repoWith(t);
  const branchOnly = baseGit({ 'refs/remotes/origin': 'refs/heads/main\n' });
  assert.deepEqual((await baseOptions(fakeMachine({ exec: branchOnly.exec }), gone.repo, SLUG_7, [], ORIGIN, BRANCH)).orphan, { worktree: false, branch: true, relation: 'stale', branchName: BRANCH });
  const none = baseGit({ 'refs/remotes/origin': 'refs/heads/main\n' }, NO_BRANCH);
  assert.equal('orphan' in (await baseOptions(fakeMachine({ exec: none.exec }), gone.repo, SLUG_7, [], ORIGIN, BRANCH)), false, 'nothing on disk: no orphan');
});

test('baseOptions answers hasWorktree, and no lists, when git lists the task\'s worktree with its directory there: the adoption test; the ref read still runs in parallel, but its result is dropped', async (t) => {
  const present = await repoWith(t, { worktree: true });
  const adopted = baseGit({ 'worktree list': listing(present.repo, present.worktree, `branch refs/heads/${BRANCH}`) });
  assert.deepEqual(await baseOptions(fakeMachine({ exec: adopted.exec }), present.repo, SLUG_7, [], ORIGIN), { hasWorktree: true, defaultRef: 'origin/main', tasks: [], local: [], remote: [] });
  assert.equal(adopted.calls.some((c) => c[0] === 'for-each-ref'), true, 'the read runs anyway, in parallel with the others; the answer still has empty lists');
  const refused = baseGit({ 'worktree list': listing(present.repo, present.worktree, `branch refs/heads/${BRANCH}`) }, ['refs/remotes/origin']);
  assert.deepEqual(await baseOptions(fakeMachine({ exec: refused.exec }), present.repo, SLUG_7, [], ORIGIN), { hasWorktree: true, defaultRef: 'origin/main', tasks: [], local: [], remote: [] }, 'a failed ref read never blocks a task that already has its worktree');
  const gone = await repoWith(t);
  const pruned = baseGit({ 'worktree list': listing(gone.repo, gone.worktree, `branch refs/heads/${BRANCH}`), 'refs/remotes/origin': 'refs/heads/main\nrefs/heads/feature-x\n' });
  assert.deepEqual(await baseOptions(fakeMachine({ exec: pruned.exec }), gone.repo, SLUG_7, [], ORIGIN), { hasWorktree: false, defaultRef: 'origin/main', tasks: [], local: ['feature-x'], remote: [] });
});

test('baseOptions runs its three git reads concurrently, not one after another', async (t) => {
  const { repo } = await repoWith(t);
  const expected = new Set([
    ['worktree', 'list', '--porcelain'].join(' '),
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'].join(' '),
    ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'].join(' '),
  ]);
  const seen = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const out: Record<string, string> = { 'worktree list': '', 'symbolic-ref --short': 'origin/main\n', 'refs/remotes/origin': '' };
  const keyOf = (command: string[]): string => (command[0] === 'for-each-ref' ? command.at(-1) as string : command.slice(0, 2).join(' '));
  const exec: Exec = async (_file, args) => {
    const command = args.slice(2); // drop `-C <repo>`, as baseGit's own calls do
    seen.add(command.join(' '));
    if (seen.size < expected.size) await gate; // in series this never releases: the test times out instead of hanging forever
    else release();
    return { stdout: out[keyOf(command)] ?? '' };
  };
  const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('baseOptions did not run its reads concurrently')), 1000));
  await Promise.race([baseOptions(fakeMachine({ exec }), repo, SLUG_7, [], ORIGIN), timeout]);
  assert.deepEqual(seen, expected);
});

test('checkBase refuses a name starting with -, the task\'s own branch and a name git has neither as a local nor as an origin/ branch; a real one passes', async () => {
  const { exec, calls } = baseGit({}, ['refs/heads/nope', 'refs/heads/origin/gone', 'refs/remotes/origin/gone', 'refs/heads/origin/feature-y']);
  await assert.rejects(checkBase(fakeMachine({ exec }), '/r', '--upload-pack=x', BRANCH), { message: '--upload-pack=x: a base cannot start with "-"' });
  for (const rev of ['main~1', 'main@{0}', 'main^{/hello world}', 'a..b']) {
    await assert.rejects(checkBase(fakeMachine({ exec }), '/r', rev, BRANCH), { message: `${rev}: not a branch name` }, 'revision syntax is not a branch');
  }
  await assert.rejects(checkBase(fakeMachine({ exec }), '/r', BRANCH, BRANCH), { message: `${BRANCH} is the task's own branch` });
  assert.deepEqual(calls, [], 'neither refusal reaches git');
  await assert.rejects(checkBase(fakeMachine({ exec }), '/r', 'nope', BRANCH), { message: 'nope: no such branch' });
  await assert.rejects(checkBase(fakeMachine({ exec }), '/r', 'origin/gone', BRANCH), { message: 'origin/gone: no such branch' });
  await checkBase(fakeMachine({ exec }), '/r', 'hive/41-parent', BRANCH);
  await checkBase(fakeMachine({ exec }), '/r', 'origin/feature-y', BRANCH);
  assert.deepEqual(calls.slice(-2), [
    ['rev-parse', '--verify', '--quiet', 'refs/heads/origin/feature-y'],
    ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature-y'],
  ], 'an origin/ name is looked up as a remote-tracking ref too');
});

// ---- the workspace's own checkout (#444) ----

test('ensureCheckout refuses a checkout with uncommitted changes before any switch, with git\'s own lines (#444)', async () => {
  const { exec, calls } = baseGit({ 'branch --show-current': 'main\n', 'status --porcelain': ' M src/server.ts\n' });
  await assert.rejects(ensureCheckout(fakeMachine({ exec }), '/repo', BRANCH, ORIGIN, undefined), { message: '/repo has changes that are not committed:\n M src/server.ts' });
  assert.deepEqual(calls, [['branch', '--show-current'], ['status', '--porcelain']], 'git switch would carry the changes onto the task\'s branch: nothing else runs');
});

test('ensureCheckout does nothing more when the checkout is already on the task\'s branch, uncommitted work included (#444)', async () => {
  const { exec, calls } = baseGit({ 'branch --show-current': `${BRANCH}\n`, 'status --porcelain': ' M src/server.ts\n' });
  assert.deepEqual(await ensureCheckout(fakeMachine({ exec }), '/repo', BRANCH, ORIGIN, undefined), { path: '/repo' });
  assert.deepEqual(calls, [['branch', '--show-current']], 'no switch happens, so the task\'s own work in progress is no reason to refuse');
});

test('ensureCheckout switches to the task\'s branch when it exists: no base is read, its work is kept (#444)', async () => {
  const { exec, calls } = baseGit({ 'branch --show-current': 'main\n' }); // rev-parse answers: the branch exists
  assert.deepEqual(await ensureCheckout(fakeMachine({ exec }), '/repo', BRANCH, ORIGIN, undefined), { path: '/repo' });
  assert.deepEqual(calls, [
    ['branch', '--show-current'],
    ['status', '--porcelain'],
    ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`],
    ['switch', BRANCH],
  ]);
});

test('ensureCheckout creates the task\'s branch from the #119 default base with switch -c, and says which base (#444)', async () => {
  const { exec, calls } = baseGit({ 'branch --show-current': 'main\n', 'symbolic-ref --short': 'origin/main\n', 'refs/remotes/origin/main': 'a1b2c3d\n' }, NO_BRANCH);
  assert.deepEqual(await ensureCheckout(fakeMachine({ exec }), '/repo', BRANCH, ORIGIN, undefined), { path: '/repo', line: 'base: origin/main (a1b2c3d)' , start: 'origin/main' });
  assert.deepEqual(calls.at(-1), ['switch', '-c', BRANCH, 'origin/main']);
  assert.ok(calls.some((c) => c[0] === 'fetch'), 'the same refresh a worktree start runs');
});

test('ensureCheckout creates the task\'s branch from a base chosen in the popup (#444)', async () => {
  const { exec, calls } = baseGit({ 'branch --show-current': 'main\n', 'refs/heads/hive/41-parent': 'b2c3d4e\n' }, NO_BRANCH);
  assert.deepEqual(await ensureCheckout(fakeMachine({ exec }), '/repo', BRANCH, ORIGIN, 'hive/41-parent'), { path: '/repo', line: 'base: hive/41-parent (b2c3d4e), chosen by hand' , start: 'hive/41-parent' });
  assert.deepEqual(calls.at(-1), ['switch', '-c', BRANCH, 'hive/41-parent']);
});

test('ensureCheckout rejects a branch starting with "-": git switch would read it as an option (#444)', async () => {
  const { exec, calls } = baseGit({ 'branch --show-current': 'main\n' });
  await assert.rejects(ensureCheckout(fakeMachine({ exec }), '/repo', '-f', ORIGIN, undefined), { message: '-f: a branch cannot start with "-"' });
  assert.equal(calls.some((c) => c[0] === 'switch'), false);
});

test('ensureCheckout rejects a start point starting with "-": switch -c would read it as an option (#444)', async () => {
  const { exec, calls } = baseGit({ 'branch --show-current': 'main\n', 'refs/heads/--orphan': 'b2c3d4e\n' }, NO_BRANCH);
  await assert.rejects(ensureCheckout(fakeMachine({ exec }), '/repo', BRANCH, ORIGIN, '--orphan'), { message: '--orphan: a base cannot start with "-"' });
  assert.equal(calls.some((c) => c[0] === 'switch'), false);
});

test('taskDir: the workspace\'s path for a checkout task, its worktree otherwise (#444)', () => {
  assert.equal(taskDir(HOST_PATHS, '/repo', { slug: 'hive-7-fix' }), worktreePath(HOST_PATHS, '/repo', 'hive-7-fix'));
  assert.equal(taskDir(HOST_PATHS, '/repo', { slug: 'hive-7-fix', local: true }), '/repo');
});

test('listWorktrees keeps only the direct children of .hive/worktrees, with the branch git lists there (detached is null); the main checkout, a worktree elsewhere, a nested path and .hive/worktrees itself are skipped (#181)', async () => {
  const repo = '/r';
  const text = porcelain(repo, [
    [worktreePath(HOST_PATHS, repo, SLUG), CLEAN_BRANCH],
    [worktreePath(HOST_PATHS, repo, 'hive-9-detached')],
    ['/elsewhere/wt', 'feat/x'],
    [join(worktreePath(HOST_PATHS, repo, SLUG), 'nested'), 'feat/y'],
    [join(repo, '.hive', 'worktrees'), 'feat/z'],
  ]);
  const { exec, calls } = fakeExec({ listing: text });
  assert.deepEqual(await listWorktrees(fakeMachine({ exec }), repo, process.platform), [
    { slug: SLUG, path: worktreePath(HOST_PATHS, repo, SLUG), branch: CLEAN_BRANCH },
    { slug: 'hive-9-detached', path: worktreePath(HOST_PATHS, repo, 'hive-9-detached'), branch: null },
  ]);
  assert.deepEqual(calls, [['git', '-C', repo, 'worktree', 'list', '--porcelain']], 'one read-only listing');
});

test('listWorktrees rejects with git\'s own words (#181)', async () => {
  const { exec } = fakeExec({ failing: 'list', message: 'Command failed: git -C /r worktree list --porcelain', stderr: 'fatal: not a git repository\n' });
  await assert.rejects(listWorktrees(fakeMachine({ exec }), '/r', process.platform), { message: 'fatal: not a git repository' });
});

test('listWorktrees on win32 takes the c:/… git prints for the Hive\'s worktree and answers the native path; a worktree elsewhere with the same name is skipped (#640)', async () => {
  const repo = 'C:\\repo';
  const text = porcelain('C:/repo', [[`c:/repo/.hive/worktrees/${SLUG}`, CLEAN_BRANCH], [`C:/elsewhere/${SLUG}`, 'feat/x']]);
  const { exec } = fakeExec({ listing: text });
  assert.deepEqual(await listWorktrees(fakeMachine({ exec }), repo, 'win32'), [{ slug: SLUG, path: worktreePath(pathsOf('win32'), repo, SLUG), branch: CLEAN_BRANCH }]);
});

// ---- a fork's start (#854) ----

const UPSTREAM = 'https://github.com/acme/app.git\n';
const MINE = 'git@github.com:me/app.git\n';
// git and gh as a fork's start runs them: git keyed as baseGit keys it, `remote get-url` by its remote; gh by its endpoint. Every call is
// recorded whole, so a merge's `-C <worktree>` shows
function forkExec(out: Record<string, string>, refuse: string[] = []): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const keyOf = (file: string, args: string[]): string => {
    if (file === 'gh') return args.find((a) => a.startsWith('repos/')) ?? '';
    const command = args.slice(2);
    if (command[0] === 'remote' && command[1] === 'get-url') return `get-url ${command[2]}`;
    return command[0] === 'rev-parse' || command[0] === 'for-each-ref' ? (command.at(-1) as string) : command.slice(0, 2).join(' ');
  };
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const key = keyOf(file, args);
    if (refuse.includes(key)) throw Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), { stderr: `fatal: ${key} refused\n` });
    return { stdout: out[key] ?? '' };
  };
  return { exec, calls };
}
const REMOTES = { 'get-url upstream': UPSTREAM, 'get-url origin': MINE };
const isIso = (at: string | undefined): boolean => at !== undefined && Number.isFinite(Date.parse(at));

test('PRs to the original start from <remote>/<base> on the original\'s remote, fetched there, with no sync (#854)', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const { exec, calls } = forkExec({ 'symbolic-ref --short': 'upstream/main\n', 'refs/remotes/upstream/main': 'b2c3d4e\n' }, NO_BRANCH);
  const base: WorkspaceBase = { remote: 'upstream', fork: { remote: 'upstream', pr: 'original' } };
  assert.deepEqual(await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, base, undefined), { path: worktree, line: 'base: upstream/main (b2c3d4e)' , start: 'upstream/main' });
  assert.ok(calls.some((c) => c.join(' ') === `git -C ${repo} fetch upstream --end-of-options main`));
  assert.deepEqual(calls.at(-1), ['git', '-C', repo, 'worktree', 'add', '-b', BRANCH, '--', worktree, 'upstream/main']);
  assert.equal(calls.some((c) => c[0] === 'gh'), false);
});

test('a missing <remote>/HEAD is set once with remote set-head --auto and read again (#854)', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const calls: string[][] = [];
  let isSet = false;
  const exec: Exec = async (_file, args) => {
    const command = args.slice(2);
    calls.push(command);
    if (command[0] === 'symbolic-ref' && command[1] === '--short') {
      if (!isSet) throw Object.assign(new Error('Command failed'), { stderr: 'fatal: ref refs/remotes/upstream/HEAD is not a symbolic ref\n' });
      return { stdout: 'upstream/devtest\n' };
    }
    if (command[0] === 'remote') isSet = true;
    if (command.at(-1) === `refs/heads/${BRANCH}`) throw Object.assign(new Error('exit 1'), { code: 1 });
    return { stdout: command.at(-1) === 'refs/remotes/upstream/devtest' ? 'c3d4e5f\n' : '' };
  };
  const base: WorkspaceBase = { remote: 'upstream', fork: { remote: 'upstream', pr: 'original' } };
  assert.deepEqual(await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, base, undefined), { path: worktree, line: 'base: upstream/devtest (c3d4e5f)' , start: 'upstream/devtest' });
  assert.deepEqual(calls.slice(1, 4), [['symbolic-ref', '--short', 'refs/remotes/upstream/HEAD'], ['remote', 'set-head', 'upstream', '--auto'], ['symbolic-ref', '--short', 'refs/remotes/upstream/HEAD']]);
});

test('PRs to the fork with the GitHub sync: the fork is synced first, then origin/<base> is fetched and the worktree starts there; the answer carries the sync (#854)', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const { exec, calls } = forkExec({ ...REMOTES, 'symbolic-ref --short': 'origin/main\n', 'refs/remotes/origin/main': 'a1b2c3d\n', 'repos/me/app/compare/main...acme:main': '{"ahead_by":3,"behind_by":0}', 'repos/me/app/merge-upstream': '{"merge_type":"fast-forward"}' }, NO_BRANCH);
  const prepared = await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, { remote: 'origin', fork: { remote: 'upstream', pr: 'fork', sync: 'github' } }, undefined);
  const { at, ...sync } = prepared.sync ?? { at: undefined };
  assert.deepEqual(sync, { result: 'synced', mode: 'github', commits: 3, base: 'me:main', sha: 'a1b2c3d' });
  assert.equal(isIso(at), true);
  assert.equal(prepared.line, 'base: origin/main (a1b2c3d) · sync github synced 3');
  const order = calls.map((c) => (c[0] === 'gh' ? c.slice(1).join(' ') : c.slice(3).join(' ')));
  assert.ok(order.indexOf('api -X POST repos/me/app/merge-upstream -f branch=main') < order.indexOf('fetch origin --end-of-options main'), 'synced before the fetch');
  assert.deepEqual(calls.at(-1), ['git', '-C', repo, 'worktree', 'add', '-b', BRANCH, '--', worktree, 'origin/main']);
});

test('PRs to the fork with the local merge: the worktree starts from origin/<base>, then merges <remote>/<base> in the new tree only (#854)', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const { exec, calls } = forkExec({ ...REMOTES, 'symbolic-ref --short': 'origin/main\n', 'refs/remotes/origin/main': 'a1b2c3d\n', 'rev-list --count': '2\n' }, NO_BRANCH);
  const prepared = await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, { remote: 'origin', fork: { remote: 'upstream', pr: 'fork', sync: 'local' } }, undefined);
  const added = calls.findIndex((c) => c.includes('add'));
  assert.deepEqual(calls.slice(added + 1), [
    ['git', '-C', worktree, 'fetch', 'upstream', '--end-of-options', 'main'],
    ['git', '-C', worktree, 'rev-list', '--count', 'HEAD..upstream/main'],
    ['git', '-C', worktree, 'merge', '--no-edit', 'upstream/main'],
  ]);
  assert.deepEqual([prepared.sync?.result, prepared.sync?.mode, prepared.sync?.commits, prepared.sync?.base], ['synced', 'local', 2, 'me:main']);
  assert.equal(calls.some((c) => c[0] === 'gh'), false, 'the fork on GitHub does not change');
});

test('a local merge in conflict is undone, its files named, and the worktree stays at origin/<base> (#854)', async (t) => {
  const { repo, worktree } = await repoWith(t);
  const { exec, calls } = forkExec({ ...REMOTES, 'refs/remotes/origin/main': 'a1b2c3d\n', 'rev-list --count': '1\n', 'diff --name-only': 'src/a.ts\nsrc/b.ts\n' }, [...NO_BRANCH, 'merge --no-edit']);
  const prepared = await ensureWorktree(fakeMachine({ exec }), repo, SLUG_7, BRANCH, { remote: 'origin', fork: { remote: 'upstream', pr: 'fork', sync: 'local' } }, undefined);
  assert.deepEqual([prepared.sync?.result, prepared.sync?.files], ['conflict', ['src/a.ts', 'src/b.ts']]);
  assert.deepEqual(calls.at(-1), ['git', '-C', worktree, 'merge', '--abort']);
});

test('the manual mode adds nothing; an adopted worktree runs no sync; a base chosen in the popup runs none either; the workspace\'s own base wins over config.baseBranch (#854)', async (t) => {
  const manual = await repoWith(t);
  const quiet = forkExec({ ...REMOTES, 'refs/remotes/origin/main': 'a1b2c3d\n' }, NO_BRANCH);
  const fork = { remote: 'upstream', pr: 'fork' as const, sync: 'manual' as const };
  assert.deepEqual(await ensureWorktree(fakeMachine({ exec: quiet.exec }), manual.repo, SLUG_7, BRANCH, { remote: 'origin', fork }, undefined), { path: manual.worktree, line: 'base: origin/main (a1b2c3d)' , start: 'origin/main' });
  assert.equal(quiet.calls.some((c) => c[0] === 'gh' || c.includes('get-url')), false);
  const adopted = await repoWith(t, { worktree: true });
  const github = { remote: 'upstream', pr: 'fork' as const, sync: 'github' as const };
  const kept = forkExec({ 'worktree list': listing(adopted.repo, adopted.worktree, `branch refs/heads/${BRANCH}`) });
  assert.deepEqual(await ensureWorktree(fakeMachine({ exec: kept.exec }), adopted.repo, SLUG_7, BRANCH, { remote: 'origin', fork: github }, undefined), { path: adopted.worktree });
  const chosen = await repoWith(t);
  const picked = forkExec({ ...REMOTES, 'refs/heads/hive/41-parent': 'b2c3d4e\n' }, NO_BRANCH);
  assert.equal((await ensureWorktree(fakeMachine({ exec: picked.exec }), chosen.repo, SLUG_7, BRANCH, { remote: 'origin', fork: github }, 'hive/41-parent')).sync, undefined);
  assert.equal(picked.calls.some((c) => c[0] === 'gh'), false);
  const own = await repoWith(t);
  const devtest = forkExec({}, NO_BRANCH);
  await ensureWorktree(fakeMachine({ exec: devtest.exec }), own.repo, SLUG_7, BRANCH, workspaceBase({ baseBranch: 'main' }, { fork: null, baseBranch: 'devtest' }), undefined);
  assert.deepEqual(devtest.calls[1], ['git', '-C', own.repo, 'fetch', 'origin', '--end-of-options', 'devtest']);
});

test('checkBase and baseOptions read the base remote: an upstream/ name resolves as a remote-tracking ref, and the popup lists upstream/* without setting a head (#854)', async (t) => {
  const { exec, calls } = baseGit({}, ['refs/heads/upstream/feature']);
  await checkBase(fakeMachine({ exec }), '/r', 'upstream/feature', BRANCH, 'upstream');
  assert.deepEqual(calls.at(-1), ['rev-parse', '--verify', '--quiet', 'refs/remotes/upstream/feature']);
  const { repo } = await repoWith(t);
  const lists = baseGit({ 'refs/remotes/upstream': 'refs/heads/main\nrefs/remotes/upstream/HEAD\nrefs/remotes/upstream/main\nrefs/remotes/upstream/next\n' }, ['symbolic-ref --short']);
  assert.deepEqual(await baseOptions(fakeMachine({ exec: lists.exec }), repo, SLUG_7, [], { remote: 'upstream' }), { hasWorktree: false, defaultRef: 'upstream/main', tasks: [], local: [], remote: ['upstream/next'] });
  assert.equal(lists.calls.some((c) => c[0] === 'remote'), false, 'read-only: no set-head');
});

const realExec: Exec = promisify(execFile);
// The real git, with an identity of its own: the runner's global config is never read for a commit.
const realGit = async (cwd: string, ...args: string[]): Promise<string> =>
  (await realExec('git', ['-C', cwd, '-c', 'user.email=hive@example.invalid', '-c', 'user.name=Hive', '-c', 'commit.gpgsign=false', ...args])).stdout.trim();

test('on win32, with the real git, a worktree under .hive/worktrees is listed with its slug and branch, adopted without a second add, and removed (#640)', { skip: process.platform !== 'win32' && 'git prints C:/… paths on win32 only' }, async (t) => {
  // realpath.native: the runner's TEMP is an 8.3 short name (RUNNER~1) that git prints long, and samePath stays pure (decision 3)
  const repo = realpathSync.native(await tempDir(t, 'win-'));
  await realGit(repo, 'init', '--quiet', '-b', 'main');
  await realGit(repo, 'commit', '--quiet', '--allow-empty', '-m', 'root');
  const path = worktreePath(HOST_PATHS, repo, SLUG);
  await realGit(repo, 'worktree', 'add', '--quiet', '-b', CLEAN_BRANCH, '--', path);
  assert.deepEqual(await listWorktrees(fakeMachine({ exec: realExec }), repo, process.platform), [{ slug: SLUG, path, branch: CLEAN_BRANCH }]);
  const calls: string[][] = [];
  const recording: Exec = (file, args, opts) => { calls.push(args); return realExec(file, args, opts); };
  assert.deepEqual(await ensureWorktree(fakeMachine({ exec: recording }), repo, SLUG, CLEAN_BRANCH, { remote: 'origin', fork: null }, undefined), { path });
  assert.equal(calls.some((args) => args.includes('add')), false, 'adopted: no second worktree add');
  await cleanWorktree(fakeMachine({ exec: realExec }), repo, { slug: SLUG, branch: CLEAN_BRANCH }, CLEAN_BRANCH); // the delete activity's removal, never forced
  assert.deepEqual(await listWorktrees(fakeMachine({ exec: realExec }), repo, process.platform), []);
  assert.deepEqual([existsSync(path), await realGit(repo, 'branch', '--list', CLEAN_BRANCH)], [false, '']);
});
