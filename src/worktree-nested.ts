import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Exec, Workspace } from './types.js';
import { branchAt, type Git, gitAnswers, gitOrWords, refuseDirty, remoteHead } from './worktree-base.js';

// A workspace's nested repos (#653): other git repositories inside its folder that its git ignores. Each task gets a worktree of each one at
// <task worktree>/<path>, on the task's branch, made right after the task's own and removed right before it. Every call goes through
// gitOrWords with argv arrays, so a refusal carries git's own words; the paths and refs are the Hive's, never a client's.

const execFileAsync: Exec = promisify(execFile);
const ORIGIN = 'origin'; // a nested repo's own remote, never the workspace's fork remote: a fork's upstream belongs to the outer repository

/** What the nested step reads of a workspace. */
export type NestedWorkspace = Pick<Workspace, 'path'> & { nestedRepos: readonly string[] };

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const hasGit = (dir: string): Promise<boolean> => exists(join(dir, '.git')); // a checkout's .git folder, or a worktree's .git file
const hasBranch = (repo: string, branch: string, exec: Exec): Promise<boolean> => gitAnswers(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], exec);
// A fetch that fails is the line's note, never fatal, as the outer default base's: offline work still starts
const fetchNote = (git: Git): Promise<string> => git('fetch', '-q', ORIGIN).then(() => '', (err: Error) => ` (fetch failed: ${err.message})`);

/** The nested base's branch name (#653): the outer start minus its remote (`upstream/main`, `origin/main` → `main`); a start on no remote
 * (a chosen local branch) as it is; none without a start. */
export function nestedBaseName(start: string | undefined, remotes: readonly string[]): string | undefined {
  if (start === undefined) return undefined;
  const remote = remotes.find((r) => start.startsWith(`${r}/`));
  return remote === undefined ? start : start.slice(remote.length + 1);
}

/** Where a nested branch starts (#653): origin/<name> when that ref resolves in the nested repo, else its origin/HEAD (remoteHead's main when
 * none is set). canSet false keeps it read-only, as Settings reads it. */
export async function nestedBase(repo: string, name: string | undefined, exec: Exec, canSet = true): Promise<string> {
  if (name !== undefined && (await gitAnswers(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ORIGIN}/${name}`], exec))) return `${ORIGIN}/${name}`;
  return `${ORIGIN}/${await remoteHead((...args) => gitOrWords(repo, args, exec), ORIGIN, canSet)}`;
}

// A nested repo that is missing, or a folder inside another repository, fails the task's preparation with its path named. git answers
// the top level by its real path (/private/var on macOS), so both sides go through realpath
async function requireNestedRepo(repo: string, path: string, exec: Exec): Promise<void> {
  const top = await gitOrWords(repo, ['rev-parse', '--show-toplevel'], exec).then((out) => out.trim(), () => '');
  if (top === '' || (await realpath(top)) !== (await realpath(repo))) throw new Error(`nested repo ${path}: ${repo} is not the top level of a git repository`);
}

// One nested repo's worktree for a task, as ensureWorktree makes the task's: adopted on the task's branch and refused on any other, a stale
// entry pruned, an existing branch checked out as it is, otherwise a new branch from the nested base with --no-track, so a push never lands
// on the nested base branch
async function ensureOne(workspace: NestedWorkspace, taskPath: string, path: string, branch: string, baseName: string | undefined, exec: Exec): Promise<string> {
  const repo = join(workspace.path, path);
  const dir = join(taskPath, path);
  await requireNestedRepo(repo, path, exec);
  const git: Git = (...args) => gitOrWords(repo, args, exec);
  const listed = branchAt(await git('worktree', 'list', '--porcelain'), dir);
  if (listed !== undefined && (await exists(dir))) {
    if (listed !== branch) throw new Error(`${dir} is checked out on ${listed === null ? 'a detached HEAD' : listed}, not on ${branch}`);
    return `${path}: reused ${branch}`;
  }
  if (listed !== undefined) await git('worktree', 'prune'); // a stale entry for a folder gone from disk would refuse the add
  const note = await fetchNote(git);
  if (await hasBranch(repo, branch, exec)) {
    await git('worktree', 'add', '--', dir, branch);
    return `${path}: reused ${branch}${note}`;
  }
  const base = await nestedBase(repo, baseName, exec);
  await git('worktree', 'add', '--no-track', '-b', branch, '--', dir, base);
  return `${path}: ${base}${note}`;
}

/** Every nested repo's worktree in the task's (#653), in order, right after ensureWorktree and before the setup: one line per nested repo,
 * which the spawn logs as it logs the `base:` line. The first failure rejects with git's words, and the task's preparation fails with them. */
export function ensureNestedWorktrees(workspace: NestedWorkspace, taskPath: string, branch: string, baseName: string | undefined, exec: Exec = execFileAsync): Promise<string[]> {
  return workspace.nestedRepos.reduce<Promise<string[]>>(
    async (done, path) => [...(await done), await ensureOne(workspace, taskPath, path, branch, baseName, exec)], Promise.resolve([]),
  );
}

async function switchOne(repo: string, path: string, branch: string, baseName: string | undefined, exec: Exec): Promise<string> {
  const git: Git = (...args) => gitOrWords(repo, args, exec);
  if (await hasBranch(repo, branch, exec)) {
    await git('switch', branch);
    return `${path}: reused ${branch}`;
  }
  const note = await fetchNote(git);
  const base = await nestedBase(repo, baseName, exec);
  await git('switch', '--no-track', '-c', branch, base);
  return `${path}: ${base}${note}`;
}

/** The checkout task's version (#653, #444): each nested checkout onto the task's branch, after ensureCheckout. One already on it is left alone,
 * work in progress included. Any one that would switch with uncommitted changes refuses before any of them moves. ensureCheckout already
 * refused the outer switch while one was dirty. */
export async function switchNested(workspace: NestedWorkspace, branch: string, baseName: string | undefined, exec: Exec = execFileAsync): Promise<string[]> {
  const current = await Promise.all(workspace.nestedRepos.map(async (path) => {
    const repo = join(workspace.path, path);
    await requireNestedRepo(repo, path, exec);
    return (await gitOrWords(repo, ['branch', '--show-current'], exec)).trim();
  }));
  const pending = workspace.nestedRepos.filter((_, i) => current[i] !== branch);
  for (const path of pending) await refuseDirty(join(workspace.path, path), exec);
  return pending.reduce<Promise<string[]>>(
    async (done, path) => [...(await done), await switchOne(join(workspace.path, path), path, branch, baseName, exec)], Promise.resolve([]),
  );
}

/** What `worktree remove` and a switch would lose, checked first (#653): every nested worktree under `root` (a task's worktree), or every nested
 * checkout (`root` = the workspace, for a checkout task), with refuseDirty's words. A nested folder that is not there is skipped. */
export async function refuseDirtyNested(workspace: NestedWorkspace, root: string, exec: Exec = execFileAsync): Promise<void> {
  for (const path of workspace.nestedRepos) {
    const dir = join(root, path);
    if (await hasGit(dir)) await refuseDirty(dir, exec);
  }
}
