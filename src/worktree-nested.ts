import type { Machine } from './machine.js';
import type { Workspace, WorktreeRow } from './types.js';
import type { PreparedWorktree } from './worktree.js';
import { branchAt, type Git, gitAnswers, gitOrWords, refuseDirty, remoteHead, upstreamOf } from './worktree-base.js';

// A workspace's nested repos (#653): other git repositories inside its folder that its git ignores. Each task gets a worktree of each one at
// <task worktree>/<path>, on the task's branch, made right after the task's own and removed right before it. Every call goes through
// gitOrWords with argv arrays, so a refusal carries git's own words; the paths and refs are the Hive's, never a client's. #882: every read and
// every git call is the machine's its caller holds.

type NestedMachine = Pick<Machine, 'exec' | 'fs' | 'paths'>;
const ORIGIN = 'origin'; // a nested repo's own remote, never the workspace's fork remote: a fork's upstream belongs to the outer repository

/** What the nested step reads of a workspace. */
export type NestedWorkspace = Pick<Workspace, 'path'> & { nestedRepos: readonly string[] };

/** How a nested repo's worktree or switch ended (#450): a new branch from `base`, or the task's branch checked out as it was. */
export type NestedEnd = { base: string } | { reused: true };

/** What the preparation tells the Start dialog's rows about each nested repo (#450). Optional everywhere: outside a run nothing listens. */
export interface NestedObserver {
  started(path: string): void;
  ended(path: string, end: NestedEnd): void;
  failed(path: string): void; // refused before it started: switchNested's checks
}

interface NestedOutcome { line: string; end: NestedEnd } // the hive.log line, unchanged, and how the repo ended
const REUSED: NestedEnd = { reused: true };
const reusedAs = (path: string, branch: string): NestedOutcome => ({ line: `${path}: reused ${branch}`, end: REUSED });

// One repo's work between its start and its end (#450): a rejection leaves it started, and the run's failure fails its row
async function observed(path: string, observer: NestedObserver | undefined, work: () => Promise<NestedOutcome>): Promise<string> {
  observer?.started(path);
  const { line, end } = await work();
  observer?.ended(path, end);
  return line;
}

// A refusal before any repo moved (#450): the observer hears which repo refused, then the refusal goes on as it was
async function refusedAs<T>(path: string, observer: NestedObserver | undefined, check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (err) {
    observer?.failed(path);
    throw err;
  }
}

const exists = (machine: Pick<Machine, 'fs'>, path: string): Promise<boolean> => machine.fs.access(path).then(() => true, () => false);
// a checkout's .git folder, or a worktree's .git file
const hasGit = (machine: Pick<Machine, 'fs' | 'paths'>, dir: string): Promise<boolean> => exists(machine, machine.paths.join(dir, '.git'));
const hasBranch = (machine: Pick<Machine, 'exec'>, repo: string, branch: string): Promise<boolean> =>
  gitAnswers(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], machine.exec);
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
export async function nestedBase(machine: Pick<Machine, 'exec'>, repo: string, name: string | undefined, canSet = true): Promise<string> {
  if (name !== undefined && (await gitAnswers(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ORIGIN}/${name}`], machine.exec))) return `${ORIGIN}/${name}`;
  return `${ORIGIN}/${await remoteHead((...args) => gitOrWords(repo, args, machine.exec), ORIGIN, canSet)}`;
}

// A nested repo that is missing, or a folder inside another repository, fails the task's preparation with its path named. git answers
// the top level by its real path (/private/var on macOS), so both sides go through the machine's realpath
async function requireNestedRepo(machine: Pick<Machine, 'exec' | 'fs'>, repo: string, path: string): Promise<void> {
  const top = await gitOrWords(repo, ['rev-parse', '--show-toplevel'], machine.exec).then((out) => out.trim(), () => '');
  if (top === '' || (await machine.fs.realpath(top)) !== (await machine.fs.realpath(repo))) throw new Error(`nested repo ${path}: ${repo} is not the top level of a git repository`);
}

// One nested repo's worktree for a task, as ensureWorktree makes the task's: adopted on the task's branch and refused on any other, a stale
// entry pruned, an existing branch checked out as it is, otherwise a new branch from the nested base with --no-track, so a push never lands
// on the nested base branch
async function ensureOne(machine: NestedMachine, workspace: NestedWorkspace, taskPath: string, path: string, branch: string, baseName: string | undefined): Promise<NestedOutcome> {
  const { paths } = machine;
  const repo = paths.join(workspace.path, path);
  const dir = paths.join(taskPath, path);
  await requireNestedRepo(machine, repo, path);
  const git: Git = (...args) => gitOrWords(repo, args, machine.exec);
  const listed = branchAt(await git('worktree', 'list', '--porcelain'), dir, paths);
  if (listed !== undefined && (await exists(machine, dir))) {
    if (listed !== branch) throw new Error(`${dir} is checked out on ${listed === null ? 'a detached HEAD' : listed}, not on ${branch}`);
    return reusedAs(path, branch);
  }
  if (listed !== undefined) await git('worktree', 'prune'); // a stale entry for a folder gone from disk would refuse the add
  if (await hasBranch(machine, repo, branch)) {
    await git('worktree', 'add', '--', dir, branch); // a resume: checked out as it is, so no fetch and no network
    return reusedAs(path, branch);
  }
  const note = await fetchNote(git);
  const base = await nestedBase(machine, repo, baseName);
  await git('worktree', 'add', '--no-track', '-b', branch, '--', dir, base);
  return { line: `${path}: ${base}${note}`, end: { base } };
}

/** Every nested repo's worktree in the task's (#653), in order, right after ensureWorktree and before the setup: one line per nested repo,
 * which the spawn logs as it logs the `base:` line. The first failure rejects with git's words, and the task's preparation fails with them.
 * #450: the observer hears each repo start and end. */
export function ensureNestedWorktrees(
  machine: NestedMachine, workspace: NestedWorkspace, taskPath: string, branch: string, baseName: string | undefined, observer?: NestedObserver,
): Promise<string[]> {
  return workspace.nestedRepos.reduce<Promise<string[]>>(
    async (done, path) => [...(await done), await observed(path, observer, () => ensureOne(machine, workspace, taskPath, path, branch, baseName))], Promise.resolve([]),
  );
}

async function switchOne(machine: Pick<Machine, 'exec'>, repo: string, path: string, branch: string, baseName: string | undefined): Promise<NestedOutcome> {
  const git: Git = (...args) => gitOrWords(repo, args, machine.exec);
  if (await hasBranch(machine, repo, branch)) {
    await git('switch', branch);
    return reusedAs(path, branch);
  }
  const note = await fetchNote(git);
  const base = await nestedBase(machine, repo, baseName);
  await git('switch', '--no-track', '-c', branch, base);
  return { line: `${path}: ${base}${note}`, end: { base } };
}

/** The checkout task's version (#653, #444): each nested checkout onto the task's branch, after ensureCheckout. One already on it is left alone,
 * work in progress included. Any one that would switch with uncommitted changes refuses before any of them moves. ensureCheckout already
 * refused the outer switch while one that would switch was dirty. #450: a repo already on the branch is reported started and ended as reused at
 * its place, so header lines keep the rows' order. */
export async function switchNested(
  machine: NestedMachine, workspace: NestedWorkspace, branch: string, baseName: string | undefined, observer?: NestedObserver,
): Promise<string[]> {
  const { paths } = machine;
  // In order, one at a time: a parallel check would let a second refusal report after the first has already ended the run
  const current = await workspace.nestedRepos.reduce<Promise<string[]>>(async (done, path) => [...(await done), await refusedAs(path, observer, async () => {
    const repo = paths.join(workspace.path, path);
    await requireNestedRepo(machine, repo, path);
    return (await gitOrWords(repo, ['branch', '--show-current'], machine.exec)).trim();
  })], Promise.resolve([]));
  for (const [i, path] of workspace.nestedRepos.entries()) {
    if (current[i] !== branch) await refusedAs(path, observer, () => refuseDirty(paths.join(workspace.path, path), machine.exec));
  }
  return workspace.nestedRepos.reduce<Promise<string[]>>(async (done, path, i) => {
    const lines = await done;
    if (current[i] !== branch) return [...lines, await observed(path, observer, () => switchOne(machine, paths.join(workspace.path, path), path, branch, baseName))];
    observer?.started(path);
    observer?.ended(path, REUSED);
    return lines;
  }, Promise.resolve([]));
}

/** What `worktree remove` and a switch would lose, checked first (#653): every nested worktree under `root` (a task's worktree), or every nested
 * checkout (`root` = the workspace, for a checkout task), with refuseDirty's words. A nested folder that is not there is skipped. `onBranch`, for a
 * switch: a nested checkout already on it does not move, so its work in progress is kept, not refused. */
export async function refuseDirtyNested(machine: NestedMachine, workspace: NestedWorkspace, root: string, onBranch?: string): Promise<void> {
  for (const path of workspace.nestedRepos) {
    const dir = machine.paths.join(root, path);
    if (!(await hasGit(machine, dir))) continue;
    if (onBranch !== undefined && (await gitOrWords(dir, ['branch', '--show-current'], machine.exec)).trim() === onBranch) continue;
    await refuseDirty(dir, machine.exec);
  }
}

const NOT_MERGED = /not fully merged/; // branch -d on a nested branch whose PR may still be open: kept, never a refusal
const BRANCH_NOT_FOUND = /error: branch '.*' not found/;

// One nested repo's worktree for a task, inside out. Only the task's own branch is ever deleted: a nested worktree someone switched to main
// must never lose main
async function removeOne(machine: NestedMachine, repo: string, dir: string, branch: string | undefined, force: boolean): Promise<void> {
  const git: Git = (...args) => gitOrWords(repo, args, machine.exec);
  const listed = branchAt(await git('worktree', 'list', '--porcelain'), dir, machine.paths);
  // --force twice, as removeWorktree's: forced is forced, dirty or locked
  if (listed !== undefined && (await exists(machine, dir))) await git('worktree', 'remove', ...(force ? ['--force', '--force'] : []), '--', dir);
  await git('worktree', 'prune');
  if (listed === undefined || listed === null || listed !== branch) return; // not listed (the teardown removed it, or it was never made), detached, or not the task's
  await git('branch', force ? '-D' : '-d', '--', listed).catch((err: Error) => {
    if (!(force ? BRANCH_NOT_FOUND : NOT_MERGED).test(err.message)) throw err;
  });
}

/** Every nested worktree of a task, removed before the task's own (#653), so the nested repo keeps no orphan entry. Normal: `worktree remove`,
 * then `branch -d` on the task's branch, kept when unmerged; forced: `--force --force` and `-D`. Either way `worktree prune` runs. A path git
 * does not list counts as done; a nested repo gone from the workspace is skipped. `branch`: the task's, as the outer removal resolved it. */
export async function removeNested(machine: NestedMachine, workspace: NestedWorkspace, taskPath: string, branch: string | undefined, force: boolean): Promise<void> {
  for (const path of workspace.nestedRepos) {
    const repo = machine.paths.join(workspace.path, path);
    if (!(await hasGit(machine, repo))) continue;
    // forced is forced: a nested repo git cannot answer never keeps the task's worktree; the outer --force --force deletes the folder, and that
    // repo's next `worktree prune` drops the entry. A normal removal still rejects with git's words
    await removeOne(machine, repo, machine.paths.join(taskPath, path), branch, force).catch((err: unknown) => {
      if (!force) throw err;
    });
  }
}

/** The nested step of a task's preparation (#653): right after ensureWorktree (the worktrees) or ensureCheckout (a checkout task's switch),
 * in the same console run, before the setup. The base branch is the outer start's, else, for a branch reused or adopted, its upstream's;
 * neither: each nested repo's origin/HEAD. A workspace with no nested repo runs no git at all. */
export async function prepareNested(
  machine: NestedMachine, workspace: NestedWorkspace, prepared: Pick<PreparedWorktree, 'path' | 'start'>, branch: string, local: boolean, remote: string, observer?: NestedObserver,
): Promise<string[]> {
  if (workspace.nestedRepos.length === 0) return [];
  const start = prepared.start ?? (await upstreamOf(workspace.path, branch, machine.exec));
  const baseName = nestedBaseName(start, [remote, ORIGIN]);
  return local ? switchNested(machine, workspace, branch, baseName, observer) : ensureNestedWorktrees(machine, workspace, prepared.path, branch, baseName, observer);
}

/** Each nested worktree present in a task's worktree with its count of uncommitted files (#653), for Maintenance › worktrees.
 * core.fsmonitor=false, as worktreeState: a worktree's config could name a monitor command a status would run. A read git refuses leaves
 * that one out rather than failing the list. */
export async function nestedStatus(machine: NestedMachine, workspace: NestedWorkspace, taskPath: string): Promise<WorktreeRow['nested']> {
  const rows = await Promise.all(workspace.nestedRepos.map(async (path) => {
    const dir = machine.paths.join(taskPath, path);
    if (!(await hasGit(machine, dir))) return [];
    const status = await gitOrWords(dir, ['-c', 'core.fsmonitor=false', 'status', '--porcelain'], machine.exec).catch(() => undefined);
    return status === undefined ? [] : [{ path, uncommitted: status.split('\n').filter((line) => line !== '').length }];
  }));
  return rows.flat();
}
