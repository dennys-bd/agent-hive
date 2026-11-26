// The forced and the clean removal of a task's worktree live here, out of worktree.ts (#159); everything goes through the machine that hosts it.
import type { Logger } from './log.js';
import { type GitlabAccess, mergedMrHead } from './gitlab/merge-requests.js';
import { GITHUB_HOST, hostKind, type PrLink, parsePrLink } from './repo-host.js';
import { type Machine, type MachineExec, pathsOf } from './machine.js';
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
  await removeNested(machine, { path: repo, nestedRepos: nested }, path, fallback ?? undefined, true); // #653: inside out, forced as the outer removal is
  // --force twice: Claude Code locks the worktree while it runs and a SIGHUP kill does not release the lock
  if (await exists(machine, path)) await git('worktree', 'remove', '--force', '--force', '--', path);
  await git('worktree', 'prune');
  if (fallback !== null) {
    await git('branch', '-D', '--', fallback).catch((err: Error) => {
      if (!BRANCH_NOT_FOUND.test(err.message)) throw err;
    });
  }
  // promptsDir is the Hive's own home, written with the host's join (spawn.ts writePrompt): joined the host's way, not the task machine's
  await machine.fs.unlink(pathsOf(process.platform).join(promptsDir, `${slugOfWork(activity)}.md`)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

/** What runs in a worktree once git's checks passed and before it goes (#654): the workspace's teardown. present: git lists the worktree
 * and its folder is on disk. A rejection is a refusal: nothing is removed. */
export type BeforeRemove = (path: string, present: boolean) => Promise<void>;

/** What a clear does with a branch `branch -d` would refuse (#267): refuse, as delete activity does, or set it aside, as the start dialog's discard does. */
export type Unmerged = 'refuse' | 'setAside';

/** Where mergedByPr reads a merged link (#1053): the live config's GitLab hosts, read at the request, and each host's account. */
export interface PrHosts { gitlabHosts: readonly string[]; gitlabAccess: GitlabAccess }
/** gitlab.com alone and no account on any host: a removal that hands no PR in (an orphan's, a discard's). */
export const NO_GITLAB: PrHosts = { gitlabHosts: [], gitlabAccess: async () => undefined };

/** cleanWorktree's choices: what an unmerged branch gets (#267), the workspace's nestedRepos, whose worktrees in this one go first (#653), the
 * task's PRs, which mergedByPr reads for a branch git calls unmerged, and where a PR read that failed is logged (#660); `hosts` (#1053),
 * where a GitLab link is read. */
export interface CleanOptions { unmerged?: Unmerged; nested?: readonly string[]; prs?: readonly TaskPr[]; log?: Pick<Logger, 'info'>; hosts?: PrHosts }

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
  { unmerged = 'refuse', nested = [], prs = [], log, hosts = NO_GITLAB }: CleanOptions = {},
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
    await refuseDirtyNested(machine, nestedOf, path); // #653: an ignored nested worktree is deleted by the outer remove without a word; refuse first
  }
  const check = found === undefined ? undefined : await mergeCheck(repo, found, exec);
  // #660: a squash leaves the branch off HEAD; its PRs say whether it was merged anyway. #1053: a refusal names the hosts it had no account for
  const byPr = found !== undefined && check?.merged === false ? await mergedByPr(machine, repo, found, prs, hosts, log) : undefined;
  const tip = byPr?.tip;
  if (found !== undefined && check?.merged === false && tip === undefined && unmerged === 'refuse') throw unmergedError(found, check.target, byPr?.noAccount ?? []);
  await beforeRemove?.(path, present); // #654: after every refusal check, so a teardown never runs for a removal git would refuse
  await removeNested(machine, nestedOf, path, named, false); // #653: inside out; a gone outer folder holds none, so this only prunes
  if (listed !== undefined) await gitOrWords(repo, present ? ['worktree', 'remove', '--', path] : ['worktree', 'prune'], exec);
  if (found === undefined) return;
  // #660: branch -d refuses a squashed branch whatever was checked; update-ref deletes only the tip mergedByPr verified, so a commit made since
  // (the teardown runs in between) makes git refuse instead of losing it
  if (tip !== undefined) await gitOrWords(repo, ['update-ref', '-d', `refs/heads/${found}`, tip], exec);
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

// #1053: the English sentence names the hosts too, for hive.log and the delete-activity stage's error
function unmergedError(branch: string, target: string, noAccount: readonly string[] = []): RemovalRefusal {
  const why = noAccount.length === 0 ? '' : ` (no GitLab account for ${noAccount.join(', ')} to read its PR)`;
  const refusal = { reason: 'unmerged' as const, branch, target, ...(noAccount.length === 0 ? {} : { noAccount: [...noAccount] }) };
  return new RemovalRefusal(`the branch '${branch}' is not fully merged into ${target}${why}`, refusal);
}

/** What `branch -d` refuses, checked first (#182): rejects with the reason when the branch is not merged (mergeCheck). */
export async function refuseUnmerged(machine: Pick<Machine, 'exec'>, repo: string, branch: string): Promise<void> {
  const { merged, target } = await mergeCheck(repo, branch, machine.exec);
  if (!merged) throw unmergedError(branch, target);
}

const PR_READ_TIMEOUT_MS = 30_000; // one gh pr view: a hung read must not hold the delete

/** What mergedByPr answers (#1053): the verified tip, absent when the PRs did not merge the branch, and the GitLab hosts it had no account for. */
export interface ByPr { tip?: string; noAccount: string[] }

/** A branch git calls unmerged that its PRs merged (#660): no PR still open, at least one merged, and the local tip is the head its host merged
 * for one of them, so a commit made after the merge still refuses. Only the PRs the record holds as merged are read, at delete time, since the
 * record may be a poll behind; a read that fails, or an answer that is not merged, counts as not merged: a failing read never deletes.
 * #1053: a github.com link reads through gh, a GitLab host's through its account, any other link not at all. */
export async function mergedByPr(machine: Pick<Machine, 'exec'>, repo: string, branch: string, prs: readonly TaskPr[], hosts: PrHosts, log?: Pick<Logger, 'info'>): Promise<ByPr> {
  const merged = prs.filter((pr) => pr.state === 'merged');
  if (merged.length === 0 || prs.some((pr) => pr.state === 'open')) return { noAccount: [] };
  const tip = (await gitOrWords(repo, ['rev-parse', '--verify', `refs/heads/${branch}`], machine.exec)).trim();
  const reads = await Promise.all(merged.map((pr) => headOf(pr.url, machine.exec, hosts, log)));
  const noAccount = [...new Set(reads.flatMap((read) => (read.noAccount === undefined ? [] : [read.noAccount])))];
  return reads.some((read) => read.head === tip) ? { tip, noAccount } : { noAccount };
}

type HeadRead = { head?: string; noAccount?: string };

// The link by its host: parsePrLink's github.com through gh (its https:// keeps a `-` off gh's argv), a GitLab host of the list through its
// account; a link of no host kind is never read
async function headOf(url: string, exec: MachineExec, hosts: PrHosts, log?: Pick<Logger, 'info'>): Promise<HeadRead> {
  const link = parsePrLink(url);
  if (link?.host === GITHUB_HOST) return { head: await mergedHead(url, exec, log) };
  if (link === undefined || hostKind(link.host, hosts.gitlabHosts) !== 'gitlab') {
    log?.info(`mergedByPr ${url}: not a GitHub PR or a GitLab host's merge request`);
    return {};
  }
  return mergedMr(url, { ...link, host: link.host.toLowerCase() }, hosts.gitlabAccess, log);
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

// #1053: the head GitLab merged, through the host's account; no account answers the host, a failing read or another state none. The
// client's words name the host and never carry the token
async function mergedMr(url: string, link: PrLink, access: GitlabAccess, log?: Pick<Logger, 'info'>): Promise<HeadRead> {
  try {
    const api = await access(link.host);
    if (api === undefined) {
      log?.info(`mergedByPr ${url}: no GitLab account for ${link.host}`);
      return { noAccount: link.host };
    }
    const head = await mergedMrHead(api, link.repository, link.number);
    if (head === undefined) log?.info(`mergedByPr ${url}: not merged on GitLab`);
    return head === undefined ? {} : { head };
  } catch (err) {
    log?.info(`mergedByPr ${url}: ${wordsOf(err)}`);
    return {};
  }
}
