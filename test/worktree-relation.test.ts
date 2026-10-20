import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Exec } from '../src/types.js';
import { branchRelation, setAside } from '../src/worktree-base.js';
import { type AfterHost, tempDir } from './temp-dir.js';

// #267 with the real git: a branch's class against the start, and what each class makes of the task's worktree and branch.

const run = promisify(execFile);
const exec: Exec = run;
const BRANCH = 'hive/7-fix';

// The real git, with an identity of its own: the test machine's global config is never read for a commit.
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, '-c', 'user.email=hive@example.invalid', '-c', 'user.name=Hive', '-c', 'commit.gpgsign=false', ...args])).stdout.trim();

async function commit(repo: string, file: string): Promise<string> {
  await writeFile(join(repo, file), file);
  await git(repo, 'add', file);
  await git(repo, 'commit', '--quiet', '-m', file);
  return git(repo, 'rev-parse', 'HEAD');
}

// A repo on main with one commit. Its real path: git lists worktrees by it (/private/var on macOS), and cleanWorktree compares them
async function plainRepo(t: AfterHost): Promise<string> {
  const repo = await realpath(await tempDir(t, 'repo-'));
  await git(repo, 'init', '--quiet', '-b', 'main');
  await commit(repo, 'a.txt');
  return repo;
}

// plainRepo plus a second commit, both pushed to a bare origin: origin/main is the start, and `root` (the first commit) an ancestor of it
async function repoWithOrigin(t: AfterHost): Promise<{ repo: string; root: string; tip: string }> {
  const repo = await plainRepo(t);
  const root = await git(repo, 'rev-parse', 'HEAD');
  const remote = await tempDir(t, 'remote-');
  await git(remote, 'init', '--quiet', '--bare', '-b', 'main');
  await git(repo, 'remote', 'add', 'origin', remote);
  const tip = await commit(repo, 'b.txt');
  await git(repo, 'push', '--quiet', 'origin', 'main');
  return { repo, root, tip };
}

// #105's branch: a root commit of its own (the same tree, no parent), so it shares no merge base with origin/main
async function unrelatedBranch(repo: string, name = BRANCH): Promise<string> {
  const sha = await git(repo, 'commit-tree', 'HEAD^{tree}', '-m', 'from before the docs split');
  await git(repo, 'branch', name, sha);
  return sha;
}

// A commit of its own on top of `from`
async function ownBranch(repo: string, from: string, name = BRANCH): Promise<string> {
  const sha = await git(repo, 'commit-tree', 'HEAD^{tree}', '-p', from, '-m', 'work of its own');
  await git(repo, 'branch', name, sha);
  return sha;
}

test('branchRelation: no merge base with the start is unrelated, an ancestor of it is stale, a commit of its own is own (#267)', async (t) => {
  const { repo, root } = await repoWithOrigin(t);
  await unrelatedBranch(repo, 'from-orphan');
  await git(repo, 'branch', 'behind', root);
  await ownBranch(repo, root, 'mine');
  const classes = await Promise.all(['from-orphan', 'behind', 'mine'].map((name) => branchRelation(repo, name, 'origin/main', exec)));
  assert.deepEqual(classes, ['unrelated', 'stale', 'own']);
});

test('branchRelation rejects with git\'s words on an exit other than 0 or 1: a start that does not resolve is no class (#267)', async (t) => {
  const { repo } = await repoWithOrigin(t);
  await git(repo, 'branch', BRANCH);
  await assert.rejects(branchRelation(repo, BRANCH, 'origin/gone', exec), { message: /origin\/gone/ });
});

test('setAside renames the branch to <branch>-old-<sha7>; a name already on the same commit deletes the branch instead, one on another commit takes the full sha (#267)', async (t) => {
  const { repo } = await repoWithOrigin(t);
  const old = await unrelatedBranch(repo);
  const kept = `${BRANCH}-old-${old.slice(0, 7)}`;
  assert.equal(await setAside(repo, BRANCH, exec), kept);
  assert.deepEqual([await git(repo, 'rev-parse', kept), await git(repo, 'branch', '--list', BRANCH)], [old, '']);
  await git(repo, 'branch', BRANCH, old); // the same tip again: already kept under that name, nothing is lost
  assert.equal(await setAside(repo, BRANCH, exec), kept);
  assert.equal(await git(repo, 'branch', '--list', BRANCH), '');
  const main = await git(repo, 'rev-parse', 'main');
  await git(repo, 'branch', BRANCH, main);
  await git(repo, 'branch', `${BRANCH}-old-${main.slice(0, 7)}`, old); // a clash: the short name holds another commit
  assert.equal(await setAside(repo, BRANCH, exec), `${BRANCH}-old-${main}`);
  assert.equal(await git(repo, 'rev-parse', `${BRANCH}-old-${main}`), main);
});
