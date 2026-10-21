import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceBase } from '../src/fork.js';
import type { Exec } from '../src/types.js';
import { ensureCheckout, worktreePath } from '../src/worktree.js';
import { ensureNestedWorktrees, nestedBaseName, type NestedWorkspace, switchNested } from '../src/worktree-nested.js';
import { type AfterHost, tempDir } from './temp-dir.js';

// #653 with the real git: an outer repo that ignores docs/, with docs cloned from a bare origin, and each task's worktree of docs.

const run = promisify(execFile);
const exec: Exec = run;
const BRANCH = 'hive/653-nested';
const SLUG = 'hive-653-nested';
const ORIGIN: WorkspaceBase = { remote: 'origin', fork: null };

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
