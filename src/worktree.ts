import { isAbsolute, posix, win32 } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Machine, pathsOf } from './machine.js';
import { slugFor } from './tasks.js';
import type { WorkspaceBase } from './fork.js';
import { HIVE_DIR } from './hooks-settings.js';
import { branchAt, branchRelation, chosenBase, defaultBase, existingBranch, type Git, gitOrWords, refuseDirty, remoteHead, settleSync, WORKTREE_PREFIX, withSync, wordsOf } from './worktree-base.js';
import { samePath } from './same-path.js';
import { refuseDirtyNested } from './worktree-nested.js';
export { branchAt, gitOrWords, wordsOf } from './worktree-base.js';
import { type Activity, type ActivityRecord, type BaseOptions, type ForkSyncResult, type Task, isBranchName, type WorktreeRow } from './types.js';

export const WORKTREES_DIR = 'worktrees';
// Another git writing .git/config at the same moment (two tasks starting at once, on one daemon or two): the lock is held for milliseconds
const CONFIG_LOCK = /could not lock config file/;
const LOCK_TRIES = 6;
const LOCK_WAIT_MS = 50;

/** Where a task's worker runs: the Hive's own folder, already excluded from git, and the only path the Hive ever creates or removes. */
export const worktreePath = (paths: Machine['paths'], repo: string, slug: string): string => paths.join(repo, HIVE_DIR, WORKTREES_DIR, slug);

// A task's activity is born with its slug (ensureActivity) and the store drops one without (#629): a path git acts on is never the worktrees
// folder itself
export function slugOfWork(activity: Pick<Activity, 'slug'>): string {
  if (!activity.slug) throw new Error('the activity has no slug');
  return activity.slug;
}

/** Where a task's runs happen: its workspace's own checkout for a local task (#444, #573), its worktree otherwise. */
export const taskDir = (paths: Machine['paths'], repo: string, activity: Pick<Activity, 'slug' | 'local'>): string =>
  (activity.local ? repo : worktreePath(paths, repo, slugOfWork(activity)));

/** Where a task's work happens (#629): its live activity's directory, or, for a record of a deleted activity (or with none live), the worktree
 * the record's slug named, where a kept session's transcript still sits until its first open moves it to the main repo (#208). The title's slug
 * only for a record with none. */
export const workDir = (paths: Machine['paths'], repo: string, task: Task, activity: Activity | undefined, record?: Pick<ActivityRecord, 'id' | 'slug'>): string =>
  (activity && (record === undefined || record.id === activity.id) ? taskDir(paths, repo, activity) : worktreePath(paths, repo, record?.slug ?? slugFor(task.item)));

/** What a spawn needs from the worktree step: where the worker runs, the `base: …` line to log when one was decided, and a fork's sync when
 * one ran for a worktree just made (#854). `reused` is the existing branch the worktree was added on as it was (#267); absent when the branch
 * was created, recreated or set aside. */
// start (#653): the start a new branch was made from, which a nested repo's branch starts from too; absent when the branch was reused or adopted, or no base was decided
export interface PreparedWorktree { path: string; line?: string; sync?: ForkSyncResult; reused?: string; start?: string }

export const exists = (machine: Pick<Machine, 'fs'>, path: string): Promise<boolean> => machine.fs.access(path).then(() => true, () => false);

/**
 * Why `path` cannot be the Comb's workspace, undefined when it can (#202). It must be absolute and the top level of a git work tree: every
 * worktree command runs `git -C <workspace>`. git answers the top level by its real path (/private/var on macOS), so both sides go
 * through realpath. Its callers without a machine hand LOCAL_DISK, the real git and disk: the settings save and the boot's proposal each run it once.
 */
export async function workspacePathProblem(machine: Pick<Machine, 'exec' | 'fs'>, path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return `${path}: the workspace folder must be an absolute path`;
  let top: string;
  try {
    top = (await machine.exec('git', ['-C', path, 'rev-parse', '--show-toplevel'])).stdout.trim();
  } catch (err) {
    return `${path} is not a git repository (${wordsOf(err)})`;
  }
  return (await machine.fs.realpath(path)) === (await machine.fs.realpath(top)) ? undefined : `${path} is not the top level of its git repository (${top})`;
}

const hasRef = (machine: Pick<Machine, 'exec'>, repo: string, ref: string): Promise<boolean> =>
  gitOrWords(repo, ['rev-parse', '--verify', '--quiet', ref], machine.exec).then(() => true, () => false);

export const hasBranch = (machine: Pick<Machine, 'exec'>, repo: string, branch: string): Promise<boolean> => hasRef(machine, repo, `refs/heads/${branch}`);

/**
 * The task's worktree, created or adopted, before the worker exists: the Hive owns it now, and the runner only gets this path as
 * its cwd. Idempotent, which is what a respawn after a kill needs — a listed path whose directory is there and whose branch is the
 * one we rendered is returned untouched, work in progress the base step never revisits, and an existing branch is checked out
 * instead of created, so a continue finds its own commits. A worktree someone else staged at that path, on another branch or
 * detached, is rejected. A path git still lists whose directory someone deleted by hand is pruned first. Every call goes through
 * gitOrWords, so a refusal carries git's own words and the task can show them. An existing branch is classified against the start first
 * (#267): one with nothing of its own is recreated at it, one with no history in common is set aside and started fresh, and the class's note
 * follows the `base:` line; the classification rejects with git's words like the add.
 *
 * At a task's first spawn the base is decided first and `line` says what was decided: the #119 refresh (`defaultBase`), or the base a
 * manual start chose in the popup (`chosen`, #131). `base` is the workspace's base remote, branch and fork (#854): a fork's sync runs
 * around the default start only, and `sync` answers it. Only the adoption check, a chosen base that does not resolve, and the
 * `worktree add` ever reject, so a default base that cannot be refreshed still starts the worker.
 */
export async function ensureWorktree(
  machine: Machine, repo: string, slug: string, branch: string, base: WorkspaceBase, chosen: string | undefined,
): Promise<PreparedWorktree> {
  const { exec } = machine;
  const path = worktreePath(machine.paths, repo, slug);
  const git: Git = (...args) => gitOrWords(repo, args, exec);
  const listed = branchAt(await git('worktree', 'list', '--porcelain'), path, machine.paths);
  if (listed !== undefined && (await exists(machine, path))) {
    // Adopt only our own branch: on anything else (another branch, a detached HEAD) the path was staged by someone else, and a
    // forced removal would delete the branch found there with the work on it.
    if (listed !== branch) throw new Error(`${path} is checked out on ${listed === null ? 'a detached HEAD' : listed}, not on ${branch}`);
    return { path };
  }
  if (listed !== undefined) await git('worktree', 'prune'); // a stale entry for a path that no longer exists would refuse the add
  const decided = chosen === undefined ? await defaultBase(git, repo, base, exec) : await chosenBase(git, base.remote, chosen);
  // A branch that already exists carries work (a removal that failed, a task respawned): checked out as it is, with no start point and no
  // fork's local merge (#854), unless its class against the start says it holds nothing to keep there (#267, existingBranch)
  const existing = await hasBranch(machine, repo, branch);
  const kept = existing ? await existingBranch(repo, branch, decided.start, exec) : undefined;
  const reused = kept?.action === 'reuse';
  const start = decided.start === undefined ? [] : [decided.start];
  const add = reused ? ['worktree', 'add', '--', path, branch] : ['worktree', 'add', kept?.action === 'reset' ? '-B' : '-b', branch, '--', path, ...start];
  await addWorktree(git, add, { path, branch, start: decided.start }, () => hasBranch(machine, repo, branch), machine.paths);
  const sync = await settleSync(decided, reused ? undefined : (...args) => gitOrWords(path, args, exec)); // #854: the local merge in the new tree only
  const line = kept?.note === undefined ? withSync(decided.line, sync) : `${withSync(decided.line, sync)} · ${kept.note}`;
  const started = reused || decided.start === undefined ? {} : { start: decided.start }; // #653: a reused branch's start is its upstream, prepareNested reads it
  return { path, line, ...started, ...(sync === undefined ? {} : { sync }), ...(reused ? { reused: branch } : {}) };
}

// A lost config lock means git made the branch, and maybe the worktree, but not its upstream: the add is never repeated as it was (the
// branch now exists); a missing worktree is added on that branch, then only the upstream is retried. Any other refusal rejects.
async function addWorktree(git: Git, add: string[], at: { path: string; branch: string; start?: string }, branchMade: () => Promise<boolean>, paths: Machine['paths']): Promise<void> {
  try {
    await git(...add);
    return;
  } catch (err) {
    if (!CONFIG_LOCK.test(wordsOf(err))) throw err;
    if (branchAt(await git('worktree', 'list', '--porcelain'), at.path, paths) !== at.branch) {
      if (!(await branchMade())) throw err;
      await git('worktree', 'add', '--', at.path, at.branch);
    }
  }
  if (at.start !== undefined) await retryLocked(() => git('branch', `--set-upstream-to=${at.start}`, at.branch));
}

async function retryLocked(run: () => Promise<string>, tries = 1): Promise<string> {
  return run().catch(async (err: unknown) => {
    if (!CONFIG_LOCK.test(wordsOf(err)) || tries >= LOCK_TRIES) throw err;
    await sleep(LOCK_WAIT_MS * tries);
    return retryLocked(run, tries + 1);
  });
}

/**
 * Puts the workspace's checkout on the task's branch (#444) and resolves to the repo path: ensureWorktree's counterpart for a checkout task,
 * run on every spawn. Already on the branch: nothing, uncommitted work included, since nothing moves. Otherwise uncommitted changes refuse
 * before any switch, since `git switch` carries the ones that do not conflict onto the new branch and the user's work must never move silently. An existing branch is switched to as it is; a new one starts
 * where a worktree's would (defaultBase / chosenBase) and `line` says so. `nested` (#653): the workspace's nested repos, checked for uncommitted changes with the checkout itself; switchNested moves them after it. Every call goes through gitOrWords, so a refusal carries git's words.
 */
export async function ensureCheckout(
  machine: Pick<Machine, 'exec'>, repo: string, branch: string, base: WorkspaceBase, chosen: string | undefined, nested: readonly string[] = [],
): Promise<PreparedWorktree> {
  const { exec } = machine;
  const git: Git = (...args) => gitOrWords(repo, args, exec);
  if ((await git('branch', '--show-current')).trim() === branch) return { path: repo }; // no switch: the task's own work in progress stays
  await refuseDirty(repo, exec);
  await refuseDirtyNested({ path: repo, nestedRepos: nested }, repo, exec, branch); // #653: no half-switched state; one already on the branch stays as it is
  if (branch.startsWith('-')) throw new Error(`${branch}: a branch cannot start with "-"`); // switch would read it as an option
  if (await hasBranch(machine, repo, branch)) {
    await git('switch', branch);
    return { path: repo };
  }
  const decided = chosen === undefined ? await defaultBase(git, repo, base, exec) : await chosenBase(git, base.remote, chosen);
  const { start } = decided;
  if (start?.startsWith('-')) throw new Error(`${start}: a base cannot start with "-"`); // no `--` for switch's start point; a saved base skips checkBase
  await git('switch', '-c', branch, ...(start === undefined ? [] : [start]));
  const sync = await settleSync(decided, git); // #854: the local mode merges into the new branch, here in the checkout
  return { path: repo, line: withSync(decided.line, sync), ...(start === undefined ? {} : { start }), ...(sync === undefined ? {} : { sync }) };
}

/**
 * Every worktree the Hive created (#181): the blocks of `git worktree list --porcelain` whose path is worktreePath(repo, <its own
 * basename>), meaning a direct child of .hive/worktrees, the only place the Hive creates one (#125). The main checkout, a worktree
 * elsewhere and anything nested are skipped; a directory there that git does not list is not a worktree. The branch is branchAt's
 * (null = detached). A row's path is the Hive's own, never git's string (#640): git prints `C:/…` on Windows. Read-only; a failure
 * carries git's words.
 */
export async function listWorktrees(machine: Pick<Machine, 'exec'>, repo: string, platform: NodeJS.Platform): Promise<Pick<WorktreeRow, 'slug' | 'path' | 'branch'>[]> {
  const porcelain = await gitOrWords(repo, ['worktree', 'list', '--porcelain'], machine.exec);
  const names = platform === 'win32' ? win32 : posix; // a `C:/…` line's last name is its slug only for win32's basename
  return porcelain.split('\n').flatMap((line) => {
    if (!line.startsWith(WORKTREE_PREFIX)) return [];
    const listed = line.slice(WORKTREE_PREFIX.length);
    const slug = names.basename(listed);
    const path = worktreePath(pathsOf(platform), repo, slug);
    return samePath(path, listed, pathsOf(platform)) ? [{ slug, path, branch: branchAt(porcelain, path, pathsOf(platform)) ?? null }] : [];
  });
}

const HEADS_PREFIX = 'refs/heads/';

// Every local branch and every <remote>/* ref, one call instead of two (#408, #854): the full refname (not refname:short, which prints
// refs/remotes/<remote>/HEAD as a bare `<remote>`) sorts each line to local or remote by its own prefix.
async function refsOf(git: Git, remote: string): Promise<{ local: string[]; remote: string[] }> {
  const prefix = `refs/remotes/${remote}/`;
  const lines = (await git('for-each-ref', '--format=%(refname)', 'refs/heads', `refs/remotes/${remote}`)).split('\n');
  const local = lines.flatMap((line) => (line.startsWith(HEADS_PREFIX) ? [line.slice(HEADS_PREFIX.length)] : []));
  const remotes = lines.flatMap((line) => (line.startsWith(prefix) ? [line.slice('refs/remotes/'.length)] : []));
  return { local, remote: remotes };
}

// #861: the worktree and the branch git holds for a task with no activity; undefined with neither. #267: the branch's class against the
// default start and its name, for the dialog's notice and its preselected choice, when both resolve; a class git cannot tell is left out
async function orphanOf(machine: Machine, repo: string, branch: string, worktree: boolean, start: string): Promise<BaseOptions['orphan']> {
  const branched = await hasBranch(machine, repo, branch);
  if (!worktree && !branched) return undefined;
  const relation = branched ? await branchRelation(repo, branch, start, machine.exec).catch(() => undefined) : undefined;
  return { worktree, branch: branched, ...(relation === undefined ? {} : { relation, branchName: branch }) };
}

/**
 * The popup's lists (#131). Read-only: never fetches, never writes, so the popup opens at once (a branch pushed after the last fetch
 * is missing; the spawn fetches the chosen one anyway). `hasWorktree` is the adoption check of ensureWorktree; with one there is nothing
 * to choose and the lists stay empty. A task appears under `tasks` only when git lists a worktree at its path on a branch, and the ref
 * is git's branch there, never the task's hook-reported one.
 *
 * The three reads depend on nothing but `repo` (#408), so they run together with `Promise.all`: `worktree list`, the remote's default
 * branch's symref (skipped, via a resolved base, when a base branch is configured), and every local and <base remote>/* ref in the one
 * for-each-ref of refsOf. The ref read still runs when the task already has a worktree; its result, or its failure, is then thrown
 * away, which costs nothing since it ran alongside the others anyway. With orphanBranch (the task has no activity, #861) what git holds for
 * the slug is an orphan: reported, never adopted, and the lists are read.
 */
export async function baseOptions(
  machine: Machine, repo: string, slug: string, others: { slug: string; id: string; title: string }[], base: Pick<WorkspaceBase, 'remote' | 'branch'>, orphanBranch?: string,
): Promise<BaseOptions> {
  const git: Git = (...args) => gitOrWords(repo, args, machine.exec);
  // Started with the others but awaited only past the adoption check: a failed ref read must not block a task that has its worktree.
  const refsRead = refsOf(git, base.remote);
  refsRead.catch(() => undefined); // its rejection is observed below, or not at all when the task already has its worktree
  const [porcelain, branch] = await Promise.all([
    git('worktree', 'list', '--porcelain'),
    base.branch === undefined ? remoteHead(git, base.remote, false) : Promise.resolve(base.branch), // read-only: never set-head here (#854)
  ]);
  const defaultRef = `${base.remote}/${branch}`;
  const own = worktreePath(machine.paths, repo, slug);
  const adoptable = branchAt(porcelain, own, machine.paths) !== undefined && (await exists(machine, own));
  const orphan = orphanBranch === undefined ? undefined : await orphanOf(machine, repo, orphanBranch, adoptable, defaultRef);
  if (adoptable && orphan === undefined) return { hasWorktree: true, defaultRef, tasks: [], local: [], remote: [] };
  const refs = await refsRead;
  const tasks = others.flatMap(({ slug: other, id, title }) => {
    const ref = branchAt(porcelain, worktreePath(machine.paths, repo, other), machine.paths);
    return typeof ref === 'string' ? [{ ref, id, title }] : [];
  });
  const taken = new Set([branch, ...tasks.map((c) => c.ref)]);
  const local = refs.local.filter((name) => !taken.has(name));
  const remote = refs.remote.filter((name) => name !== `${base.remote}/HEAD` && name !== defaultRef);
  return { hasWorktree: false, defaultRef, tasks, local, remote, ...(orphan === undefined ? {} : { orphan }) };
}

/**
 * Rejects, with the reason, a name the start route received that git should not branch from (#131): the name reaches git's argv, and
 * the UI is not trusted to have offered only real refs. A leading `-`, the task's own branch, and a name that is neither
 * refs/heads/<ref> nor (for <remote>/<x>) refs/remotes/<remote>/<x>.
 */
export async function checkBase(machine: Pick<Machine, 'exec'>, repo: string, ref: string, ownBranch: string, remote = 'origin'): Promise<void> {
  if (ref.startsWith('-')) throw new Error(`${ref}: a base cannot start with "-"`);
  if (!isBranchName(ref)) throw new Error(`${ref}: not a branch name`);
  if (ref === ownBranch) throw new Error(`${ref} is the task's own branch`);
  const refs = [`refs/heads/${ref}`, ...(ref.startsWith(`${remote}/`) ? [`refs/remotes/${ref}`] : [])]; // #854: the workspace's base remote
  const found = await Promise.all(refs.map((full) => hasRef(machine, repo, full)));
  if (!found.some(Boolean)) throw new Error(`${ref}: no such branch`);
}
