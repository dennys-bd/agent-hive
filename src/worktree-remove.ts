// The forced and the clean removal of a task's worktree live here, out of worktree.ts (#159); everything goes through the machine that hosts it.
import type { Logger } from './log.js';
import type { Machine, MachineExec } from './machine.js';
import { ownBranch } from './task-runs.js';
import { branchAt, gitAnswers, gitOrWords, refuseDirty, RemovalRefusal, setAside, wordsOf } from './worktree-base.js';
import { refuseDirtyNested, removeNested } from './worktree-nested.js';
import { exists, hasBranch, slugOfWork, worktreePath } from './worktree.js';
import type { Activity, TaskPr } from './types.js';

const BRANCH_NOT_FOUND = /error: branch '.*' not found/; // git branch -D on a branch already deleted; execFile's message embeds the stderr

/**
 * Removes a worker's worktree, its branch and the Hive's prompt file for the slug (in `promptsDir`, the home's prompts/). The forced
 * removal of the details panel's button (#182): only on a stopped task, never with a live process inside. Path and branch are git's own (the
 * deterministic worktree path and what git lists checked out there), never the task's: `/hooks/event` is open to any local process and
 * a forged SessionStart could point them anywhere; the branch the Hive rendered for the task (or a `-r<n>` a Restart made of it, #283) is the fallback when git no longer lists
 * the worktree. `nested` (#653): the workspace's nestedRepos, whose worktrees in this one go first (removeNested); [] removes none. Already gone (no directory, no branch, no file) is not an error: `worktree prune` always runs so a directory deleted by
 * hand leaves no stale entry. Any other git error propagates and the later steps do not run.
 */
export async function removeWorktree(
  machine: Machine, repo: string, activity: Pick<Activity, 'slug' | 'branch'>, branch: string, promptsDir: string, nested: readonly string[] = [],
): Promise<void> {
  const { exec } = machine;
  const git = (...args: string[]): Promise<{ stdout: string }> => exec('git', ['-C', repo, ...args]);
  const path = worktreePath(machine.paths, repo, slugOfWork(activity));
  const listed = branchAt((await git('worktree', 'list', '--porcelain')).stdout, path, machine.paths);
  const fallback = listed === undefined ? (ownBranch(activity, branch) ?? branch) : listed; // not listed: the branch a Restart moved the task to (#283), else the template's. null: detached
  await removeNested({ path: repo, nestedRepos: nested }, path, fallback ?? undefined, true, exec); // #653: inside out, forced as the outer removal is
  // --force twice: Claude Code locks the worktree while it runs and a SIGHUP kill does not release the lock
  if (await exists(machine, path)) await git('worktree', 'remove', '--force', '--force', '--', path);
  await git('worktree', 'prune');
  if (fallback !== null) {
    await git('branch', '-D', '--', fallback).catch((err: Error) => {
      if (!BRANCH_NOT_FOUND.test(err.message)) throw err;
    });
  }
  await machine.fs.unlink(machine.paths.join(promptsDir, `${slugOfWork(activity)}.md`)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

/** What runs in a worktree once git's checks passed and before it goes (#654): the workspace's teardown. present: git lists the worktree
 * and its folder is on disk. A rejection is a refusal: nothing is removed. */
export type BeforeRemove = (path: string, present: boolean) => Promise<void>;

/** What a clear does with a branch `branch -d` would refuse (#267): refuse, as delete activity does, or set it aside, as the start dialog's discard does. */
export type Unmerged = 'refuse' | 'setAside';

/** cleanWorktree's choices: what an unmerged branch gets (#267), the workspace's nestedRepos, whose worktrees in this one go first (#653), the
 * task's PRs, which mergedByPr reads for a branch git calls unmerged, and where a PR read that failed is logged (#660). */
export interface CleanOptions { unmerged?: Unmerged; nested?: readonly string[]; prs?: readonly TaskPr[]; log?: Pick<Logger, 'info'> }

/**
 * The delete activity stage's action, and the first try of the ⋯ menu's delete activity (#182): removes the task's worktree and its local
 * branch, both WITHOUT force (unlike removeWorktree, the forced removal). All or nothing: what git would refuse is checked first (changes
 * in the worktree; a branch `branch -d` would not delete) and a refusal rejects with the reason, leaving both in place, never a worktree
 * gone with its branch left behind. git refusing anyway (a locked worktree) still rejects with its stderr. Idempotent: a path git does
 * not list and a branch it does not know count as done; a listed path whose directory is gone is pruned. The path comes from the slug
 * alone (the activity's worktree is a SessionStart cwd any local process can post); the branch is the one git lists on that path, else
 * the activity's branch only when it is the name the Hive's template renders for this task, else nothing. The remote branch is never touched.
 * `beforeRemove` (#654) runs between the checks and the removal; its rejection removes nothing. `options.unmerged: 'setAside'` (#267) keeps an
 * unmerged branch under setAside's name instead of refusing. `options.nested` (#653): the workspace's nestedRepos, whose worktrees in this one go first
 * (removeNested); [] removes none. `options.prs` (#660): a branch git calls unmerged that mergedByPr says its PRs merged is not refused and goes
 * with `update-ref -d` at the tip it verified.
 */
export async function cleanWorktree(
  machine: Machine, repo: string, activity: Pick<Activity, 'slug' | 'branch'>, branch: string, beforeRemove?: BeforeRemove,
  { unmerged = 'refuse', nested = [], prs = [], log }: CleanOptions = {},
): Promise<void> {
  const { exec } = machine;
  const path = worktreePath(machine.paths, repo, slugOfWork(activity));
  const nestedOf = { path: repo, nestedRepos: nested };
  const listed = branchAt((await gitOrWords(repo, ['worktree', 'list', '--porcelain'], exec)), path, machine.paths);
  const present = listed !== undefined && (await exists(machine, path));
  // a hook can forge the branch: trusted only when it is the template's name or a Restart's `-r<n>` of it (#283)
  const named = listed ?? ownBranch(activity, branch);
  const found = named !== undefined && (await hasBranch(machine, repo, named)) ? named : undefined;
  if (present) {
    await refuseDirty(path, exec);
    await refuseDirtyNested(nestedOf, path, exec); // #653: an ignored nested worktree is deleted by the outer remove without a word; refuse first
  }
  const check = found === undefined ? undefined : await mergeCheck(repo, found, exec);
  // #660: a squash leaves the branch off HEAD; its PRs say whether it was merged anyway
  const byPr = found !== undefined && check?.merged === false ? await mergedByPr(machine, repo, found, prs, log) : undefined;
  if (found !== undefined && check?.merged === false && byPr === undefined && unmerged === 'refuse') throw unmergedError(found, check.target);
  await beforeRemove?.(path, present); // #654: after every refusal check, so a teardown never runs for a removal git would refuse
  await removeNested(nestedOf, path, named, false, exec); // #653: inside out; a gone outer folder holds none, so this only prunes
  if (listed !== undefined) await gitOrWords(repo, present ? ['worktree', 'remove', '--', path] : ['worktree', 'prune'], exec);
  if (found === undefined) return;
  // #660: branch -d refuses a squashed branch whatever was checked; update-ref deletes only the tip mergedByPr verified, so a commit made since
  // (the teardown runs in between) makes git refuse instead of losing it
  if (byPr !== undefined) await gitOrWords(repo, ['update-ref', '-d', `refs/heads/${found}`, byPr], exec);
  // #267: an unmerged branch the discard clears is kept as <branch>-old-<sha7>, after its worktree went, so the rename touches no checkout
  else if (check?.merged === false) await setAside(repo, found, exec);
  else await gitOrWords(repo, ['branch', '-d', '--', found], exec);
}

// %(upstream:track) when the remote branch is gone (GitHub deletes the head branch after a merge): branch -d then checks HEAD, and so do we (#660)
const GONE = '[gone]';

// What `branch -d` checks (#182), by git's own rule: merged into the branch's upstream when it has one that still exists, else into HEAD of the
// main checkout. merge-base --is-ancestor exits 1 for "not merged"; any other failure is git's words. Both refs are built here, never read off
// the task, so neither can start with `-`.
async function mergeCheck(repo: string, branch: string, exec: MachineExec): Promise<{ merged: boolean; target: string }> {
  const ref = `refs/heads/${branch}`;
  const [upstream = '', track = ''] = (await gitOrWords(repo, ['for-each-ref', '--format=%(upstream)%00%(upstream:track)', ref], exec)).trimEnd().split('\0');
  const target = upstream === '' || track.includes(GONE) ? 'HEAD' : upstream;
  return { merged: await gitAnswers(repo, ['merge-base', '--is-ancestor', ref, target], exec), target };
}

const unmergedError = (branch: string, target: string): RemovalRefusal =>
  new RemovalRefusal(`the branch '${branch}' is not fully merged into ${target}`, { reason: 'unmerged', branch, target });

/** What `branch -d` refuses, checked first (#182): rejects with the reason when the branch is not merged (mergeCheck). */
export async function refuseUnmerged(machine: Pick<Machine, 'exec'>, repo: string, branch: string): Promise<void> {
  const { merged, target } = await mergeCheck(repo, branch, machine.exec);
  if (!merged) throw unmergedError(branch, target);
}

const PR_READ_TIMEOUT_MS = 30_000; // one gh pr view: a hung read must not hold the delete

/** A branch git calls unmerged that its PRs merged (#660): no PR still open, at least one merged, and the local tip is the head GitHub merged
 * for one of them, so a commit made after the merge still refuses. Only the PRs the record holds as merged are read, at delete time, since the
 * record may be a poll behind; a read that fails, or an answer that is not MERGED, counts as not merged: a failing read never deletes.
 * Answers the verified tip, which the deletion passes to update-ref; undefined = not merged by its PRs. */
export async function mergedByPr(machine: Pick<Machine, 'exec'>, repo: string, branch: string, prs: readonly TaskPr[], log?: Pick<Logger, 'info'>): Promise<string | undefined> {
  const { exec } = machine;
  // the record's links passed isPrUrl when stored; https:// only keeps a `-` off gh's argv anyway
  const merged = prs.filter((pr) => pr.state === 'merged' && pr.url.startsWith('https://'));
  if (merged.length === 0 || prs.some((pr) => pr.state === 'open')) return undefined;
  const tip = (await gitOrWords(repo, ['rev-parse', '--verify', `refs/heads/${branch}`], exec)).trim();
  const heads = await Promise.all(merged.map((pr) => mergedHead(pr.url, exec, log)));
  return heads.includes(tip) ? tip : undefined;
}

// The head GitHub merged for the PR, undefined when gh fails or GitHub does not call it MERGED; either is logged with the url
async function mergedHead(url: string, exec: MachineExec, log?: Pick<Logger, 'info'>): Promise<string | undefined> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', url, '--json', 'state,headRefOid'], { timeout: PR_READ_TIMEOUT_MS });
    const answer = JSON.parse(stdout) as { state?: unknown; headRefOid?: unknown };
    if (answer.state === 'MERGED' && typeof answer.headRefOid === 'string') return answer.headRefOid;
    log?.info(`mergedByPr ${url}: not merged on GitHub`);
  } catch (err) {
    log?.info(`mergedByPr ${url}: ${wordsOf(err)}`);
  }
  return undefined;
}

