import { execFile } from 'node:child_process';
import { access, realpath, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ownBranch } from './task-runs.js';
import { slugFor } from './tasks.js';
import type { WorkspaceBase } from './fork.js';
import { HIVE_DIR } from './hooks-settings.js';
import { chosenBase, defaultBase, type Git, remoteHead, settleSync, withSync } from './worktree-base.js';
import { type Activity, type ActivityRecord, type BaseOptions, type ForkSyncResult, type Task, type Exec, isBranchName, type WorktreeRow } from './types.js';

const execFileAsync: Exec = promisify(execFile);
const BRANCH_NOT_FOUND = /error: branch '.*' not found/; // git branch -D on a branch already deleted; execFile's message embeds the stderr
const HEAD_PREFIX = 'branch refs/heads/';
const WORKTREE_PREFIX = 'worktree '; // the first line of each block of `worktree list --porcelain`
export const WORKTREES_DIR = 'worktrees';
// Another git writing .git/config at the same moment (two tasks starting at once, on one daemon or two): the lock is held for milliseconds
const CONFIG_LOCK = /could not lock config file/;
const LOCK_TRIES = 6;
const LOCK_WAIT_MS = 50;

/** Where a task's worker runs: the Hive's own folder, already excluded from git, and the only path the Hive ever creates or removes. */
export const worktreePath = (repo: string, slug: string): string => join(repo, HIVE_DIR, WORKTREES_DIR, slug);

// A task's activity is born with its slug (ensureActivity) and the store drops one without (#629): a path git acts on is never the worktrees
// folder itself
function slugOfWork(activity: Pick<Activity, 'slug'>): string {
  if (!activity.slug) throw new Error('the activity has no slug');
  return activity.slug;
}

/** Where a task's runs happen: its workspace's own checkout for a local task (#444, #573), its worktree otherwise. */
export const taskDir = (repo: string, activity: Pick<Activity, 'slug' | 'local'>): string =>
  (activity.local ? repo : worktreePath(repo, slugOfWork(activity)));

/** Where a task's work happens (#629): its live activity's directory, or, for a record of a deleted activity (or with none live), the worktree
 * the record's slug named, where a kept session's transcript still sits until its first open moves it to the main repo (#208). The title's slug
 * only for a record with none. */
export const workDir = (repo: string, task: Task, activity: Activity | undefined, record?: Pick<ActivityRecord, 'id' | 'slug'>): string =>
  (activity && (record === undefined || record.id === activity.id) ? taskDir(repo, activity) : worktreePath(repo, record?.slug ?? slugFor(task.item)));

/** What a spawn needs from the worktree step: where the worker runs, the `base: …` line to log when one was decided, and a fork's sync when
 * one ran for a worktree just made (#854). */
export interface PreparedWorktree { path: string; line?: string; sync?: ForkSyncResult }

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/**
 * The branch checked out at `path` per `git worktree list --porcelain` (one block per worktree: `worktree <path>`, then `branch
 * refs/heads/<name>` or `detached`): `null` when the worktree is listed but detached, `undefined` when it is not listed at all.
 */
export function branchAt(porcelain: string, path: string): string | null | undefined {
  const block = porcelain.split(/\n\s*\n/).find((b) => b.split('\n').includes(`worktree ${path}`));
  if (block === undefined) return undefined;
  const ref = block.split('\n').find((line) => line.startsWith(HEAD_PREFIX));
  return ref === undefined ? null : ref.slice(HEAD_PREFIX.length);
}

/**
 * Removes a worker's worktree, its branch and the Hive's prompt file for the slug (in `promptsDir`, the home's prompts/). The forced
 * removal of the details panel's button (#182): only on a stopped task, never with a live process inside. Path and branch are git's own (the
 * deterministic worktree path and what git lists checked out there), never the task's: `/hooks/event` is open to any local process and
 * a forged SessionStart could point them anywhere; the branch the Hive rendered for the task (or a `-r<n>` a Restart made of it, #283) is the fallback when git no longer lists
 * the worktree. Already gone (no directory, no branch, no file) is not an error: `worktree prune` always runs so a directory deleted by
 * hand leaves no stale entry. Any other git error propagates and the later steps do not run.
 */
export async function removeWorktree(
  repo: string, activity: Pick<Activity, 'slug' | 'branch'>, branch: string, promptsDir: string, exec: Exec = execFileAsync,
): Promise<void> {
  const git = (...args: string[]): Promise<{ stdout: string }> => exec('git', ['-C', repo, ...args]);
  const path = worktreePath(repo, slugOfWork(activity));
  const listed = branchAt((await git('worktree', 'list', '--porcelain')).stdout, path);
  const fallback = listed === undefined ? (ownBranch(activity, branch) ?? branch) : listed; // not listed: the branch a Restart moved the task to (#283), else the template's. null: detached
  // --force twice: Claude Code locks the worktree while it runs and a SIGHUP kill does not release the lock
  if (await exists(path)) await git('worktree', 'remove', '--force', '--force', '--', path);
  await git('worktree', 'prune');
  if (fallback !== null) {
    await git('branch', '-D', '--', fallback).catch((err: Error) => {
      if (!BRANCH_NOT_FOUND.test(err.message)) throw err;
    });
  }
  await unlink(join(promptsDir, `${slugOfWork(activity)}.md`)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

// git's own words for a failure: its stderr, else the error's message (execFile's would bury them under the command line). Exported for the
// task diff (#270), which must tell execFile's overflow apart before it rewords anything.
export const wordsOf = (err: unknown): string => {
  const e = err as { stderr?: string; message: string };
  return (e.stderr ?? '').trim() || e.message;
};

// A failure carries git's own words (stderr) so the task says why; restart.ts runs its git the same way (#283).
export async function gitOrWords(repo: string, args: string[], exec: Exec): Promise<string> {
  try {
    return (await exec('git', ['-C', repo, ...args])).stdout;
  } catch (err) {
    throw new Error(wordsOf(err));
  }
}

/**
 * Why `path` cannot be the Comb's workspace, undefined when it can (#202). It must be absolute and the top level of a git work tree: every
 * worktree command runs `git -C <workspace>`. git answers the top level by its real path (/private/var on macOS), so both sides go
 * through realpath. Always the real git, never an injected one: the settings save and the boot's proposal each run it once.
 */
export async function workspacePathProblem(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return `${path}: the workspace folder must be an absolute path`;
  let top: string;
  try {
    top = (await execFileAsync('git', ['-C', path, 'rev-parse', '--show-toplevel'])).stdout.trim();
  } catch (err) {
    return `${path} is not a git repository (${wordsOf(err)})`;
  }
  return (await realpath(path)) === (await realpath(top)) ? undefined : `${path} is not the top level of its git repository (${top})`;
}

const hasRef = (repo: string, ref: string, exec: Exec): Promise<boolean> =>
  gitOrWords(repo, ['rev-parse', '--verify', '--quiet', ref], exec).then(() => true, () => false);

const hasBranch = (repo: string, branch: string, exec: Exec): Promise<boolean> => hasRef(repo, `refs/heads/${branch}`, exec);

/**
 * The task's worktree, created or adopted, before the worker exists: the Hive owns it now, and the runner only gets this path as
 * its cwd. Idempotent, which is what a respawn after a kill needs — a listed path whose directory is there and whose branch is the
 * one we rendered is returned untouched, work in progress the base step never revisits, and an existing branch is checked out
 * instead of created, so a continue finds its own commits. A worktree someone else staged at that path, on another branch or
 * detached, is rejected. A path git still lists whose directory someone deleted by hand is pruned first. Every call goes through
 * gitOrWords, so a refusal carries git's own words and the task can show them.
 *
 * At a task's first spawn the base is decided first and `line` says what was decided: the #119 refresh (`defaultBase`), or the base a
 * manual start chose in the popup (`chosen`, #131). `base` is the workspace's base remote, branch and fork (#854): a fork's sync runs
 * around the default start only, and `sync` answers it. Only the adoption check, a chosen base that does not resolve, and the
 * `worktree add` ever reject, so a default base that cannot be refreshed still starts the worker.
 */
export async function ensureWorktree(
  repo: string, slug: string, branch: string, base: WorkspaceBase, chosen: string | undefined, exec: Exec = execFileAsync,
): Promise<PreparedWorktree> {
  const path = worktreePath(repo, slug);
  const git: Git = (...args) => gitOrWords(repo, args, exec);
  const listed = branchAt(await git('worktree', 'list', '--porcelain'), path);
  if (listed !== undefined && (await exists(path))) {
    // Adopt only our own branch: on anything else (another branch, a detached HEAD) the path was staged by someone else, and a
    // forced removal would delete the branch found there with the work on it.
    if (listed !== branch) throw new Error(`${path} is checked out on ${listed === null ? 'a detached HEAD' : listed}, not on ${branch}`);
    return { path };
  }
  if (listed !== undefined) await git('worktree', 'prune'); // a stale entry for a path that no longer exists would refuse the add
  const decided = chosen === undefined ? await defaultBase(git, repo, base, exec) : await chosenBase(git, base.remote, chosen);
  // A branch that already exists carries work (a removal that failed, a task respawned): checked out, never recreated from the
  // base, which is why it takes no start point either, nor a fork's local merge (#854). Same stance as cleanWorktree.
  const reused = await hasBranch(repo, branch, exec);
  const add = reused
    ? ['worktree', 'add', '--', path, branch]
    : ['worktree', 'add', '-b', branch, '--', path, ...(decided.start === undefined ? [] : [decided.start])];
  await addWorktree(git, add, { path, branch, start: decided.start }, () => hasBranch(repo, branch, exec));
  const sync = await settleSync(decided, reused ? undefined : (...args) => gitOrWords(path, args, exec)); // #854: the local merge in the new tree only
  return { path, line: withSync(decided.line, sync), ...(sync === undefined ? {} : { sync }) };
}

// A lost config lock means git made the branch, and maybe the worktree, but not its upstream: the add is never repeated as it was (the
// branch now exists); a missing worktree is added on that branch, then only the upstream is retried. Any other refusal rejects.
async function addWorktree(git: Git, add: string[], at: { path: string; branch: string; start?: string }, branchMade: () => Promise<boolean>): Promise<void> {
  try {
    await git(...add);
    return;
  } catch (err) {
    if (!CONFIG_LOCK.test(wordsOf(err))) throw err;
    if (branchAt(await git('worktree', 'list', '--porcelain'), at.path) !== at.branch) {
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
 * where a worktree's would (defaultBase / chosenBase) and `line` says so. Every call goes through gitOrWords, so a refusal carries git's words.
 */
export async function ensureCheckout(
  repo: string, branch: string, base: WorkspaceBase, chosen: string | undefined, exec: Exec = execFileAsync,
): Promise<PreparedWorktree> {
  const git: Git = (...args) => gitOrWords(repo, args, exec);
  if ((await git('branch', '--show-current')).trim() === branch) return { path: repo }; // no switch: the task's own work in progress stays
  await refuseDirty(repo, exec);
  if (branch.startsWith('-')) throw new Error(`${branch}: a branch cannot start with "-"`); // switch would read it as an option
  if (await hasBranch(repo, branch, exec)) {
    await git('switch', branch);
    return { path: repo };
  }
  const decided = chosen === undefined ? await defaultBase(git, repo, base, exec) : await chosenBase(git, base.remote, chosen);
  const { start } = decided;
  if (start?.startsWith('-')) throw new Error(`${start}: a base cannot start with "-"`); // no `--` for switch's start point; a saved base skips checkBase
  await git('switch', '-c', branch, ...(start === undefined ? [] : [start]));
  const sync = await settleSync(decided, git); // #854: the local mode merges into the new branch, here in the checkout
  return { path: repo, line: withSync(decided.line, sync), ...(sync === undefined ? {} : { sync }) };
}

/** What runs in a worktree once git's checks passed and before it goes (#654): the workspace's teardown. present: git lists the worktree
 * and its folder is on disk. A rejection is a refusal: nothing is removed. */
export type BeforeRemove = (path: string, present: boolean) => Promise<void>;

/**
 * The delete activity stage's action, and the first try of the ⋯ menu's delete activity (#182): removes the task's worktree and its local
 * branch, both WITHOUT force (unlike removeWorktree, the forced removal). All or nothing: what git would refuse is checked first (changes
 * in the worktree; a branch `branch -d` would not delete) and a refusal rejects with the reason, leaving both in place, never a worktree
 * gone with its branch left behind. git refusing anyway (a locked worktree) still rejects with its stderr. Idempotent: a path git does
 * not list and a branch it does not know count as done; a listed path whose directory is gone is pruned. The path comes from the slug
 * alone (the activity's worktree is a SessionStart cwd any local process can post); the branch is the one git lists on that path, else
 * the activity's branch only when it is the name the Hive's template renders for this task, else nothing. The remote branch is never touched.
 * `beforeRemove` (#654) runs between the checks and the removal; its rejection removes nothing.
 */
export async function cleanWorktree(
  repo: string, activity: Pick<Activity, 'slug' | 'branch'>, branch: string, exec: Exec = execFileAsync, beforeRemove?: BeforeRemove,
): Promise<void> {
  const path = worktreePath(repo, slugOfWork(activity));
  const listed = branchAt((await gitOrWords(repo, ['worktree', 'list', '--porcelain'], exec)), path);
  const present = listed !== undefined && (await exists(path));
  // a hook can forge the branch: trusted only when it is the template's name or a Restart's `-r<n>` of it (#283)
  const named = listed ?? ownBranch(activity, branch);
  const found = named !== undefined && (await hasBranch(repo, named, exec)) ? named : undefined;
  if (present) await refuseDirty(path, exec);
  if (found !== undefined) await refuseUnmerged(repo, found, exec);
  await beforeRemove?.(path, present); // #654: after every refusal check, so a teardown never runs for a removal git would refuse
  if (listed !== undefined) await gitOrWords(repo, present ? ['worktree', 'remove', '--', path] : ['worktree', 'prune'], exec);
  if (found !== undefined) await gitOrWords(repo, ['branch', '-d', '--', found], exec);
}

// What `worktree remove` without --force refuses, checked first (#182): tracked changes and untracked files. Read inside the worktree;
// the lines are git's own, so the refusal names the files.
async function refuseDirty(path: string, exec: Exec): Promise<void> {
  const status = (await gitOrWords(path, ['status', '--porcelain'], exec)).trimEnd();
  if (status !== '') throw new Error(`${path} has changes that are not committed:\n${status}`);
}

// What `branch -d` refuses, checked first (#182) by git's own rule: merged into the branch's upstream when it has one, else into HEAD of
// the main checkout. merge-base --is-ancestor exits 1 for "not merged"; any other failure is git's words. Both refs are built here, never
// read off the task, so neither can start with `-`.
export async function refuseUnmerged(repo: string, branch: string, exec: Exec): Promise<void> {
  const ref = `refs/heads/${branch}`;
  const target = (await gitOrWords(repo, ['for-each-ref', '--format=%(upstream)', ref], exec)).trim() || 'HEAD';
  const merged = await exec('git', ['-C', repo, 'merge-base', '--is-ancestor', ref, target]).then(() => true, (err: { code?: unknown }) => {
    if (err.code === 1) return false;
    throw new Error(wordsOf(err));
  });
  if (!merged) throw new Error(`the branch '${branch}' is not fully merged into ${target}`);
}

/**
 * Every worktree the Hive created (#181): the blocks of `git worktree list --porcelain` whose path is worktreePath(repo, <its own
 * basename>), meaning a direct child of .hive/worktrees, the only place the Hive creates one (#125). The main checkout, a worktree
 * elsewhere and anything nested are skipped; a directory there that git does not list is not a worktree. The branch is branchAt's
 * (null = detached). Read-only; a failure carries git's words.
 */
export async function listWorktrees(repo: string, exec: Exec = execFileAsync): Promise<Pick<WorktreeRow, 'slug' | 'path' | 'branch'>[]> {
  const porcelain = await gitOrWords(repo, ['worktree', 'list', '--porcelain'], exec);
  return porcelain.split('\n').flatMap((line) => {
    if (!line.startsWith(WORKTREE_PREFIX)) return [];
    const path = line.slice(WORKTREE_PREFIX.length);
    const slug = basename(path);
    return worktreePath(repo, slug) === path ? [{ slug, path, branch: branchAt(porcelain, path) ?? null }] : [];
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

/**
 * The popup's lists (#131). Read-only: never fetches, never writes, so the popup opens at once (a branch pushed after the last fetch
 * is missing; the spawn fetches the chosen one anyway). `hasWorktree` is the adoption check of ensureWorktree; with one there is nothing
 * to choose and the lists stay empty. A task appears under `tasks` only when git lists a worktree at its path on a branch, and the ref
 * is git's branch there, never the task's hook-reported one.
 *
 * The three reads depend on nothing but `repo` (#408), so they run together with `Promise.all`: `worktree list`, the remote's default
 * branch's symref (skipped, via a resolved base, when a base branch is configured), and every local and <base remote>/* ref in the one
 * for-each-ref of refsOf. The ref read still runs when the task already has a worktree; its result, or its failure, is then thrown
 * away, which costs nothing since it ran alongside the others anyway.
 */
export async function baseOptions(
  repo: string, slug: string, others: { slug: string; id: string; title: string }[], base: Pick<WorkspaceBase, 'remote' | 'branch'>, exec: Exec = execFileAsync,
): Promise<BaseOptions> {
  const git: Git = (...args) => gitOrWords(repo, args, exec);
  // Started with the others but awaited only past the adoption check: a failed ref read must not block a task that has its worktree.
  const refsRead = refsOf(git, base.remote);
  refsRead.catch(() => undefined); // its rejection is observed below, or not at all when the task already has its worktree
  const [porcelain, branch] = await Promise.all([
    git('worktree', 'list', '--porcelain'),
    base.branch === undefined ? remoteHead(git, base.remote, false) : Promise.resolve(base.branch), // read-only: never set-head here (#854)
  ]);
  const defaultRef = `${base.remote}/${branch}`;
  const own = worktreePath(repo, slug);
  if (branchAt(porcelain, own) !== undefined && (await exists(own))) return { hasWorktree: true, defaultRef, tasks: [], local: [], remote: [] };
  const refs = await refsRead;
  const tasks = others.flatMap(({ slug: other, id, title }) => {
    const ref = branchAt(porcelain, worktreePath(repo, other));
    return typeof ref === 'string' ? [{ ref, id, title }] : [];
  });
  const taken = new Set([branch, ...tasks.map((c) => c.ref)]);
  const local = refs.local.filter((name) => !taken.has(name));
  const remote = refs.remote.filter((name) => name !== `${base.remote}/HEAD` && name !== defaultRef);
  return { hasWorktree: false, defaultRef, tasks, local, remote };
}

/**
 * Rejects, with the reason, a name the start route received that git should not branch from (#131): the name reaches git's argv, and
 * the UI is not trusted to have offered only real refs. A leading `-`, the task's own branch, and a name that is neither
 * refs/heads/<ref> nor (for <remote>/<x>) refs/remotes/<remote>/<x>.
 */
export async function checkBase(repo: string, ref: string, ownBranch: string, exec: Exec = execFileAsync, remote = 'origin'): Promise<void> {
  if (ref.startsWith('-')) throw new Error(`${ref}: a base cannot start with "-"`);
  if (!isBranchName(ref)) throw new Error(`${ref}: not a branch name`);
  if (ref === ownBranch) throw new Error(`${ref} is the task's own branch`);
  const refs = [`refs/heads/${ref}`, ...(ref.startsWith(`${remote}/`) ? [`refs/remotes/${ref}`] : [])]; // #854: the workspace's base remote
  const found = await Promise.all(refs.map((full) => hasRef(repo, full, exec)));
  if (!found.some(Boolean)) throw new Error(`${ref}: no such branch`);
}
