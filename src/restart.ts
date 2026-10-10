import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { ownBranch } from './task-runs.js';
import type { Activity, Exec } from './types.js';
import { gitOrWords } from './worktree.js';

const execFileAsync: Exec = promisify(execFile);
const REMOTE = 'origin'; // no second remote is in play (#119)
const FIRST_VARIANT = 2; // <branch>-r2 is the first branch a Restart creates (#283)
const HEADS = 'refs/heads/';
const BRANCH_NOT_FOUND = /error: branch '.*' not found/;
/** Restart's refusal when the stage's starting commit is gone (#283): the ref should have kept it. */
export const COMMIT_GONE_MESSAGE = 'o commit de início da etapa não existe mais';

/** The ref that keeps a stage's starting commit alive through a rebase, an --amend, a push -f or a gc (#283). */
export const stageStartRef = (slug: string): string => `refs/hive/${slug}/stage-start`;

/** What Restart does to the worktree (#283): reset on the same branch, or reset and move to a new branch the remote does not have. */
export type RestartPlan = { mode: 'reset' } | { mode: 'branch'; newBranch: string };

/** HEAD of `worktree` as a stage run starts, kept as the stage-start ref of `slug` in `repo` (#283). Undefined when git prints no sha:
 * nothing is recorded, and Restart is not offered for that stage. */
export async function recordStageStart(repo: string, worktree: string, slug: string, exec: Exec = execFileAsync): Promise<string | undefined> {
  const sha = (await gitOrWords(worktree, ['rev-parse', 'HEAD'], exec)).trim();
  if (sha === '') return undefined;
  await gitOrWords(repo, ['update-ref', stageStartRef(slug), sha], exec);
  return sha;
}

// The local branches under `patterns` (for-each-ref globs under refs/heads), by name.
async function localBranches(repo: string, patterns: string[], exec: Exec): Promise<string[]> {
  const names = await gitOrWords(repo, ['for-each-ref', '--format=%(refname:lstrip=2)', ...patterns.map((p) => `${HEADS}${p}`)], exec);
  return names.split('\n').filter((name) => name !== '');
}

// What origin lists under `patterns`, name → sha; undefined when ls-remote failed (offline, no origin).
async function remoteHeads(repo: string, patterns: string[], exec: Exec): Promise<Map<string, string> | undefined> {
  const listed = await gitOrWords(repo, ['ls-remote', REMOTE, ...patterns.map((p) => `${HEADS}${p}`)], exec).catch(() => undefined);
  if (listed === undefined) return undefined;
  const pairs = listed.split('\n').flatMap((line) => {
    const [sha, ref] = line.split('\t');
    return sha && ref?.startsWith(HEADS) ? [[ref.slice(HEADS.length), sha] as const] : [];
  });
  return new Map(pairs);
}

/**
 * How Restart treats the task's current `branch` (#283). A starting commit git no longer has is refused. A branch origin does not list, or
 * lists at the commit, is reset in place. Anything else, a failed ls-remote included, gets a new `<template>-r<n>` (the first n ≥ 2 neither
 * local nor on origin): offline defaults to the branch mode because it never loses anything, and the Hive never rewrites a published branch.
 * The variants are always built off the template, so a second Restart from `<template>-r2` gives `<template>-r3`, never `-r2-r2`.
 */
export async function restartPlan(repo: string, branch: string, template: string, commit: string, exec: Exec = execFileAsync): Promise<RestartPlan> {
  await gitOrWords(repo, ['cat-file', '-e', `${commit}^{commit}`], exec).catch(() => {
    throw new Error(COMMIT_GONE_MESSAGE);
  });
  const variants = `${template}-r*`;
  const remote = await remoteHeads(repo, [branch, variants], exec);
  const published = remote?.get(branch);
  if (remote !== undefined && (published === undefined || published === commit)) return { mode: 'reset' };
  const taken = new Set([...(await localBranches(repo, [variants], exec)), ...(remote?.keys() ?? [])]);
  let n = FIRST_VARIANT;
  while (taken.has(`${template}-r${n}`)) n += 1;
  return { mode: 'branch', newBranch: `${template}-r${n}` };
}

// The worktree must be git's own checkout of `branch` (#283): a directory whose .git is gone would let `git -C` walk up to the main repo, and
// Restart must never reset or clean that one, nor a worktree someone switched to another branch. Real paths, so a symlinked tmp compares equal.
async function ownCheckout(worktree: string, branch: string, exec: Exec): Promise<void> {
  const real = (path: string): Promise<string> => realpath(path).catch(() => path);
  const top = (await gitOrWords(worktree, ['rev-parse', '--show-toplevel'], exec)).trim();
  if ((await real(top)) !== (await real(worktree))) throw new Error(`${worktree} não é um checkout git próprio: o git chega em ${top}`);
  const head = (await gitOrWords(worktree, ['symbolic-ref', '--short', 'HEAD'], exec).catch(() => '')).trim();
  if (head !== branch) throw new Error(`o worktree está em ${head || 'um HEAD destacado'}, não no branch ${branch}`);
}

/** Restart's git, run by the server before the new session (#283): uncommitted changes dropped, untracked files removed but ignored ones kept
 * (no -x: node_modules and .env survive), then the worktree at `commit`. The reset mode moves its own branch back there; the branch mode resets
 * only to HEAD, so the published branch keeps its commits, and checks the new branch out at the commit. Only in the task's own checkout of
 * `branch`. git's own words on a failure. */
export async function restartWorktree(worktree: string, branch: string, commit: string, plan: RestartPlan, exec: Exec = execFileAsync): Promise<void> {
  await ownCheckout(worktree, branch, exec);
  await gitOrWords(worktree, ['reset', '--hard', plan.mode === 'reset' ? commit : 'HEAD'], exec);
  await gitOrWords(worktree, ['clean', '-fd'], exec);
  if (plan.mode === 'branch') await gitOrWords(worktree, ['switch', '-c', plan.newBranch, commit], exec);
}

/** What Restart's confirmation says it discards (#283, #580), read in the task's own checkout only, so `diff`'s root-relative paths and
 * `ls-files`' cwd-relative ones are the same paths. Reset: the commits past `commit`, and every file `reset --hard <commit>` and `clean -fd`
 * touch: the tracked paths that differ from `commit` (staged or not) and the untracked ones git does not ignore, each once. Branch: the commits
 * stay on the published branch, so the files are counted against HEAD; `commits` is still counted, and the dialog leaves it out. */
export async function discarded(worktree: string, branch: string, commit: string, plan: RestartPlan, exec: Exec = execFileAsync): Promise<{ commits: number; files: number }> {
  await ownCheckout(worktree, branch, exec);
  const commits = Number((await gitOrWords(worktree, ['rev-list', '--count', `${commit}..HEAD`], exec)).trim()) || 0;
  const base = plan.mode === 'reset' ? commit : 'HEAD';
  const tracked = await gitOrWords(worktree, ['diff', '--name-only', '-z', '--no-renames', base, '--'], exec);
  const untracked = await gitOrWords(worktree, ['ls-files', '-z', '--others', '--exclude-standard'], exec);
  const paths = new Set(`${tracked}\0${untracked}`.split('\0').filter((path) => path !== ''));
  return { commits, files: paths.size };
}

/** The own branches a Restart moved the task away from (#283): the template's and its other `-r<n>` that git has locally. None while the task
 * is on the template's branch, so a delete activity of a task that never restarted runs no extra git. */
export async function leftBehind(repo: string, activity: Pick<Activity, 'branch'>, template: string, exec: Exec = execFileAsync): Promise<string[]> {
  const own = ownBranch(activity, template);
  if (own === undefined || own === template) return [];
  const names = await localBranches(repo, [template, `${template}-r*`], exec);
  return names.filter((name) => name !== own && ownBranch({ branch: name }, template) !== undefined);
}

/** Deletes local branches for a delete activity (#283): -d as the delete activity stage does (the caller already checked them, all or nothing), -D when
 * forced. A branch already gone counts as done. The remote is never touched. */
export async function dropBranches(repo: string, names: string[], force: boolean, exec: Exec = execFileAsync): Promise<void> {
  for (const name of names) {
    await gitOrWords(repo, ['branch', force ? '-D' : '-d', '--', name], exec).catch((err: Error) => {
      if (!BRANCH_NOT_FOUND.test(err.message)) throw err;
    });
  }
}

/** Drops the stage-start ref of `slug` with the worktree (#283); a ref already gone is nothing to drop. */
export async function dropStageStart(repo: string, slug: string, exec: Exec = execFileAsync): Promise<void> {
  const ref = stageStartRef(slug);
  const present = await gitOrWords(repo, ['rev-parse', '--verify', '--quiet', ref], exec).then(() => true, () => false);
  if (present) await gitOrWords(repo, ['update-ref', '-d', ref], exec);
}
