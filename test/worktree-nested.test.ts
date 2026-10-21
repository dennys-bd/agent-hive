import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceBase } from '../src/fork.js';
import type { Exec } from '../src/types.js';
import { cleanWorktree, ensureCheckout, removeWorktree, worktreePath } from '../src/worktree.js';
import { ensureNestedWorktrees, nestedBaseName, type NestedObserver, type NestedWorkspace, prepareNested, switchNested } from '../src/worktree-nested.js';
import { type AfterHost, tempDir } from './temp-dir.js';

// #653 with the real git: an outer repo that ignores docs/, with docs cloned from a bare origin, and each task's worktree of docs.

const run = promisify(execFile);
const exec: Exec = run;
const BRANCH = 'hive/653-nested';
const SLUG = 'hive-653-nested';
const ORIGIN: WorkspaceBase = { remote: 'origin', fork: null };
const OTHER = { slug: 'hive-653-other', branch: 'hive/653-other' };
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

// The real git, with an identity of its own: the test machine's global config is never read for a commit.
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, '-c', 'user.email=hive@example.invalid', '-c', 'user.name=Hive', '-c', 'commit.gpgsign=false', ...args])).stdout.trim();

async function commit(repo: string, file: string): Promise<void> {
  await writeFile(join(repo, file), file);
  await git(repo, 'add', file);
  await git(repo, 'commit', '--quiet', '-m', file);
}

interface Fixture { outer: string; docs: string; workspace: NestedWorkspace }

// The outer repo on main, ignoring docs/ and .hive/, its real path (git lists worktrees by it); docs cloned from a bare origin holding
// `docsBranches`, each past main by a commit of its own
async function fixture(t: AfterHost, docsBranches: readonly string[] = ['main']): Promise<Fixture> {
  const outer = await realpath(await tempDir(t, 'outer-'));
  await git(outer, 'init', '--quiet', '-b', 'main');
  await writeFile(join(outer, '.gitignore'), 'docs/\n.hive/\n');
  await git(outer, 'add', '.gitignore');
  await git(outer, 'commit', '--quiet', '-m', 'ignore docs');
  const origin = await tempDir(t, 'docs-origin-');
  await git(origin, 'init', '--quiet', '--bare', '-b', 'main');
  const seed = await tempDir(t, 'docs-seed-');
  await git(seed, 'init', '--quiet', '-b', 'main');
  await commit(seed, 'readme.md');
  for (const name of docsBranches.filter((b) => b !== 'main')) {
    await git(seed, 'checkout', '--quiet', '-b', name);
    await commit(seed, `${name}.md`);
    await git(seed, 'checkout', '--quiet', 'main');
  }
  await git(seed, 'remote', 'add', 'origin', origin);
  await git(seed, 'push', '--quiet', 'origin', ...docsBranches);
  await run('git', ['clone', '--quiet', origin, join(outer, 'docs')]);
  return { outer, docs: join(outer, 'docs'), workspace: { path: outer, nestedRepos: ['docs'] } };
}

// The task's own worktree, made with git alone: the nested step runs right after it
async function outerWorktree(outer: string, slug = SLUG, branch = BRANCH): Promise<string> {
  const path = worktreePath(outer, slug);
  await git(outer, 'worktree', 'add', '--quiet', '-b', branch, '--', path);
  return path;
}

test('nestedBaseName drops the start\'s remote; a local start stays as it is; no start, no name (#653)', () => {
  const remotes = ['upstream', 'origin'];
  assert.deepEqual(
    [nestedBaseName('origin/main', remotes), nestedBaseName('upstream/devtest', remotes), nestedBaseName('hive/41-parent', remotes), nestedBaseName(undefined, remotes)],
    ['main', 'devtest', 'hive/41-parent', undefined],
  );
});

test('ensureNestedWorktrees adds <task>/docs on the task\'s branch from origin/<base>, with no upstream (#653)', async (t) => {
  const f = await fixture(t);
  const task = await outerWorktree(f.outer);
  assert.deepEqual(await ensureNestedWorktrees(f.workspace, task, BRANCH, 'main', exec), ['docs: origin/main']);
  const dir = join(task, 'docs');
  assert.equal(await git(dir, 'branch', '--show-current'), BRANCH);
  assert.equal(await git(dir, 'rev-parse', 'HEAD'), await git(f.docs, 'rev-parse', 'origin/main'));
  assert.equal(await git(f.docs, 'for-each-ref', '--format=%(upstream)', `refs/heads/${BRANCH}`), '', '--no-track: a push never lands on the base');
});

test('a base branch the nested repo lacks falls back to its origin/HEAD (#653)', async (t) => {
  const f = await fixture(t);
  const task = await outerWorktree(f.outer);
  assert.deepEqual(await ensureNestedWorktrees(f.workspace, task, BRANCH, 'devtest', exec), ['docs: origin/main']);
});

test('an existing nested branch is checked out as it is: a resumed task keeps its nested commits (#653)', async (t) => {
  const f = await fixture(t);
  await git(f.docs, 'checkout', '--quiet', '-b', BRANCH);
  await commit(f.docs, 'spec.md');
  const tip = await git(f.docs, 'rev-parse', 'HEAD');
  await git(f.docs, 'checkout', '--quiet', 'main');
  const task = await outerWorktree(f.outer);
  assert.deepEqual(await ensureNestedWorktrees(f.workspace, task, BRANCH, 'main', exec), [`docs: reused ${BRANCH}`]);
  assert.equal(await git(join(task, 'docs'), 'rev-parse', 'HEAD'), tip);
});

test('a nested worktree already there on the task\'s branch is adopted; one on another branch is refused (#653)', async (t) => {
  const f = await fixture(t);
  const task = await outerWorktree(f.outer);
  await ensureNestedWorktrees(f.workspace, task, BRANCH, 'main', exec);
  assert.deepEqual(await ensureNestedWorktrees(f.workspace, task, BRANCH, 'main', exec), [`docs: reused ${BRANCH}`], 'a respawn adopts it');
  const dir = join(task, 'docs');
  await git(f.docs, 'worktree', 'remove', '--', dir);
  await git(f.docs, 'worktree', 'add', '--quiet', '-b', 'other', '--', dir, 'main');
  await assert.rejects(ensureNestedWorktrees(f.workspace, task, BRANCH, 'main', exec), { message: `${dir} is checked out on other, not on ${BRANCH}` });
});

test('a nested repo that is missing fails the preparation with its path named (#653)', async (t) => {
  const f = await fixture(t);
  const task = await outerWorktree(f.outer);
  await assert.rejects(ensureNestedWorktrees({ path: f.outer, nestedRepos: ['ee'] }, task, BRANCH, 'main', exec), { message: /^nested repo ee: / });
});

test('a checkout task switches docs to the task\'s branch from origin/<base>; already on it, nothing (#653)', async (t) => {
  const f = await fixture(t);
  await ensureCheckout(f.outer, BRANCH, ORIGIN, undefined, exec, f.workspace.nestedRepos);
  assert.deepEqual(await switchNested(f.workspace, BRANCH, 'main', exec), ['docs: origin/main']);
  assert.deepEqual([await git(f.outer, 'branch', '--show-current'), await git(f.docs, 'branch', '--show-current')], [BRANCH, BRANCH]);
  assert.deepEqual(await switchNested(f.workspace, BRANCH, 'main', exec), [], 'already on the branch: nothing');
});

test('a checkout task refuses when only the nested repo is dirty, before anything is switched (#653)', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.docs, 'draft.md'), 'wip');
  await assert.rejects(ensureCheckout(f.outer, BRANCH, ORIGIN, undefined, exec, f.workspace.nestedRepos), { message: `${f.docs} has changes that are not committed:\n?? draft.md` });
  assert.deepEqual([await git(f.outer, 'branch', '--show-current'), await git(f.docs, 'branch', '--show-current')], ['main', 'main']);
});

test('a checkout respawn already on the branch keeps a dirty nested repo\'s work: no refusal (#653)', async (t) => {
  const f = await fixture(t);
  await ensureCheckout(f.outer, BRANCH, ORIGIN, undefined, exec, f.workspace.nestedRepos);
  await switchNested(f.workspace, BRANCH, 'main', exec);
  await writeFile(join(f.docs, 'draft.md'), 'wip');
  assert.deepEqual(await ensureCheckout(f.outer, BRANCH, ORIGIN, undefined, exec, f.workspace.nestedRepos), { path: f.outer });
  assert.deepEqual(await switchNested(f.workspace, BRANCH, 'main', exec), []);
});

test('prepareNested starts a nested branch from the outer branch\'s upstream when the outer start is unknown, from the decided start otherwise; no nested repo runs no git (#653)', async (t) => {
  const f = await fixture(t, ['main', 'devtest']);
  const outerOrigin = await tempDir(t, 'outer-origin-');
  await git(outerOrigin, 'init', '--quiet', '--bare', '-b', 'main');
  await git(f.outer, 'remote', 'add', 'origin', outerOrigin);
  await git(f.outer, 'push', '--quiet', 'origin', 'main', 'main:devtest');
  await git(f.outer, 'fetch', '--quiet', 'origin');
  const reused = worktreePath(f.outer, SLUG);
  await git(f.outer, 'worktree', 'add', '--quiet', '--track', '-b', BRANCH, '--', reused, 'origin/devtest'); // a branch reused as it is: its upstream is where it started
  assert.deepEqual(await prepareNested(f.workspace, { path: reused }, BRANCH, false, 'origin', exec), ['docs: origin/devtest']);
  const other = { slug: 'hive-653-other', branch: 'hive/653-other' };
  const made = await outerWorktree(f.outer, other.slug, other.branch);
  assert.deepEqual(await prepareNested(f.workspace, { path: made, start: 'origin/main' }, other.branch, false, 'origin', exec), ['docs: origin/main']);
  const none: Exec = async () => { throw new Error('no git for a workspace without nested repos'); };
  assert.deepEqual(await prepareNested({ path: f.outer, nestedRepos: [] }, { path: made }, other.branch, false, 'origin', none), []);
});

test('a normal clean refuses while a nested worktree has modified or untracked files, naming them, and removes nothing (#653)', async (t) => {
  const f = await fixture(t);
  const task = await outerWorktree(f.outer);
  await ensureNestedWorktrees(f.workspace, task, BRANCH, 'main', exec);
  const dir = join(task, 'docs');
  await writeFile(join(dir, 'readme.md'), 'changed');
  await writeFile(join(dir, 'notes.md'), 'new');
  await assert.rejects(
    cleanWorktree(f.outer, { slug: SLUG, branch: BRANCH }, BRANCH, exec, undefined, 'refuse', ['docs']),
    { message: `${dir} has changes that are not committed:\n M readme.md\n?? notes.md` },
  );
  assert.deepEqual([await exists(task), await git(dir, 'branch', '--show-current')], [true, BRANCH], 'nothing removed');
});

test('a normal clean removes the nested worktree first, then the task\'s: no entry left in the nested repo; a merged nested branch is deleted, an unmerged one kept (#653)', async (t) => {
  const f = await fixture(t);
  const merged = await outerWorktree(f.outer);
  const kept = await outerWorktree(f.outer, OTHER.slug, OTHER.branch);
  await ensureNestedWorktrees(f.workspace, merged, BRANCH, 'main', exec);
  await ensureNestedWorktrees(f.workspace, kept, OTHER.branch, 'main', exec);
  await commit(join(kept, 'docs'), 'spec.md'); // its PR may still be open
  await cleanWorktree(f.outer, { slug: SLUG, branch: BRANCH }, BRANCH, exec, undefined, 'refuse', ['docs']);
  await cleanWorktree(f.outer, { slug: OTHER.slug, branch: OTHER.branch }, OTHER.branch, exec, undefined, 'refuse', ['docs']);
  const listed = await git(f.docs, 'worktree', 'list', '--porcelain');
  assert.equal(listed.includes(merged) || listed.includes(kept), false, 'no orphan entry in the nested repo');
  assert.deepEqual([await git(f.docs, 'branch', '--list', BRANCH), await git(f.docs, 'branch', '--list', OTHER.branch)], ['', OTHER.branch]);
  assert.deepEqual([await exists(merged), await exists(kept)], [false, false]);
});

test('the forced removal deletes a dirty nested worktree and its branch, inside out (#653)', async (t) => {
  const f = await fixture(t);
  const task = await outerWorktree(f.outer);
  await ensureNestedWorktrees(f.workspace, task, BRANCH, 'main', exec);
  await commit(join(task, 'docs'), 'spec.md');
  await writeFile(join(task, 'docs', 'draft.md'), 'wip');
  await removeWorktree(f.outer, { slug: SLUG, branch: BRANCH }, BRANCH, await tempDir(t, 'prompts-'), exec, ['docs']);
  assert.equal((await git(f.docs, 'worktree', 'list', '--porcelain')).includes(task), false);
  assert.deepEqual([await git(f.docs, 'branch', '--list', BRANCH), await exists(task)], ['', false]);
});

test('a nested worktree the teardown already removed counts as done (#653)', async (t) => {
  const f = await fixture(t);
  const task = await outerWorktree(f.outer);
  await ensureNestedWorktrees(f.workspace, task, BRANCH, 'main', exec);
  const teardown = async (path: string): Promise<void> => { await git(f.docs, 'worktree', 'remove', '--', join(path, 'docs')); }; // today's agent-hive teardown line
  await cleanWorktree(f.outer, { slug: SLUG, branch: BRANCH }, BRANCH, exec, teardown, 'refuse', ['docs']);
  assert.equal(await exists(task), false);
  assert.equal((await git(f.docs, 'worktree', 'list', '--porcelain')).includes(task), false);
});

test('a resumed nested branch needs no fetch: an unreachable origin adds no note (#653)', async (t) => {
  const f = await fixture(t);
  await git(f.docs, 'branch', BRANCH);
  await git(f.docs, 'remote', 'set-url', 'origin', join(f.outer, 'no-such-origin'));
  const task = await outerWorktree(f.outer);
  assert.deepEqual(await ensureNestedWorktrees(f.workspace, task, BRANCH, 'main', exec), [`docs: reused ${BRANCH}`]);
});

test('a checkout switch refuses only the nested repos that would move: one already on the branch keeps its work (#653)', async (t) => {
  const f = await fixture(t);
  await git(f.docs, 'checkout', '--quiet', '-b', BRANCH);
  await writeFile(join(f.docs, 'draft.md'), 'wip');
  await ensureCheckout(f.outer, BRANCH, ORIGIN, undefined, exec, f.workspace.nestedRepos);
  assert.deepEqual(await switchNested(f.workspace, BRANCH, 'main', exec), []);
  assert.equal(await git(f.outer, 'branch', '--show-current'), BRANCH);
});

test('the forced removal still removes the task\'s worktree when a nested repo\'s git fails (#653)', async (t) => {
  const f = await fixture(t);
  const task = await outerWorktree(f.outer);
  await ensureNestedWorktrees(f.workspace, task, BRANCH, 'main', exec);
  // every git call into the nested repo fails, as a corrupted one would
  const broken: Exec = (file, args, options) => (args[0] === '-C' && args[1] === f.docs ? Promise.reject(new Error('fatal: bad object HEAD')) : exec(file, args, options));
  await removeWorktree(f.outer, { slug: SLUG, branch: BRANCH }, BRANCH, await tempDir(t, 'prompts-'), broken, ['docs']);
  assert.equal(await exists(task), false);
});

// What the observer heard, in order (#450)
function recorder(): { calls: unknown[][]; observer: NestedObserver } {
  const calls: unknown[][] = [];
  return {
    calls,
    observer: {
      started: (path) => { calls.push(['started', path]); },
      ended: (path, end) => { calls.push(['ended', path, end]); },
      failed: (path) => { calls.push(['failed', path]); },
    },
  };
}

test('prepareNested tells the observer each repo\'s start and end in order, from a base or reused; the log lines stay as they were (#450)', async (t) => {
  const f = await fixture(t);
  const wiki = join(f.outer, 'wiki');
  await run('git', ['clone', '--quiet', f.docs, wiki]); // its origin is docs: origin/main resolves
  await git(wiki, 'branch', BRANCH); // a resume: checked out as it is
  const task = await outerWorktree(f.outer);
  const { calls, observer } = recorder();
  const lines = await prepareNested({ path: f.outer, nestedRepos: ['docs', 'wiki'] }, { path: task, start: 'origin/main' }, BRANCH, false, 'origin', exec, observer);
  assert.deepEqual(lines, ['docs: origin/main', `wiki: reused ${BRANCH}`]);
  assert.deepEqual(calls, [['started', 'docs'], ['ended', 'docs', { base: 'origin/main' }], ['started', 'wiki'], ['ended', 'wiki', { reused: true }]]);
});

test('a nested repo whose git fails is started and never ended: the run\'s failure fails its row (#450)', async (t) => {
  const f = await fixture(t);
  const task = await outerWorktree(f.outer);
  const dir = join(task, 'docs');
  await git(f.docs, 'worktree', 'add', '--quiet', '-b', 'other', '--', dir, 'main');
  const { calls, observer } = recorder();
  await assert.rejects(ensureNestedWorktrees(f.workspace, task, BRANCH, 'main', exec, observer), { message: `${dir} is checked out on other, not on ${BRANCH}` });
  assert.deepEqual(calls, [['started', 'docs']]);
});

test('switchNested\'s dirty refusal names the repo that refused, before any starts (#450)', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.docs, 'draft.md'), 'wip');
  const { calls, observer } = recorder();
  await assert.rejects(switchNested(f.workspace, BRANCH, 'main', exec, observer), { message: `${f.docs} has changes that are not committed:\n?? draft.md` });
  assert.deepEqual(calls, [['failed', 'docs']]);
});

test('a checkout task\'s nested repo switches from a base; already on the branch it ends at once as reused, with no line (#450)', async (t) => {
  const f = await fixture(t);
  const first = recorder();
  assert.deepEqual(await prepareNested(f.workspace, { path: f.outer, start: 'origin/main' }, BRANCH, true, 'origin', exec, first.observer), ['docs: origin/main']);
  assert.deepEqual(first.calls, [['started', 'docs'], ['ended', 'docs', { base: 'origin/main' }]]);
  const again = recorder();
  assert.deepEqual(await switchNested(f.workspace, BRANCH, 'main', exec, again.observer), []);
  assert.deepEqual(again.calls, [['started', 'docs'], ['ended', 'docs', { reused: true }]]);
});
