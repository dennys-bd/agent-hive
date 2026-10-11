// Where a decomposition's file lives, and its delivery (#936): the git checkout that holds the file (the goal's worktree, or a docsRepo's,
// wherever it sits), the GitHub repository of its origin, its current branch and the file's path in it. What the Design: links point at and
// where the delivery commits, pushes and opens its PR. Git through execFile with argv arrays.
import { dirname, relative } from 'node:path';
import { PR_KEY } from './decomposition.js';
import type { WriteDeps } from './decomposition-write.js';
import { ownerName } from './repos/github-repos.js';
import { originRepository } from './repos/repositories.js';
import { CREATE_PULL_REQUEST, type CreatePullRequestData, OPEN_PULL_REQUEST, type OpenPullRequestData } from './sources/github-queries.js';
import type { Exec } from './types.js';

/** The file's checkout (#936): its toplevel, its origin's owner/name, its current branch, and the file's path relative to the toplevel. */
export interface FileCheckout { toplevel: string; repository: string; branch: string; path: string }

/** The checkout of `file`, a real absolute path (#936), learned from the file itself: the Hive keeps no copy of the conventions. No checkout,
 * an origin off GitHub or a detached HEAD is refused with fixed words before anything is written. */
export async function fileCheckout(exec: Exec, file: string): Promise<FileCheckout> {
  const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
  // git answers the toplevel with its symlinks resolved, as the file's real path is, so the relative path holds
  const toplevel = await git(dirname(file), 'rev-parse', '--show-toplevel').catch(() => '');
  if (toplevel === '') throw new Error('the decomposition file is in no git checkout');
  const repository = await originRepository(exec, toplevel);
  if (repository === undefined) throw new Error('the decomposition file\'s checkout has no GitHub origin');
  const branch = await git(toplevel, 'branch', '--show-current');
  if (branch === '') throw new Error('the decomposition file\'s checkout is on no branch: nothing to push');
  return { toplevel, repository, branch, path: relative(toplevel, file) };
}

/** What the delivery needs (#936): git in the file's checkout, the Hive's login, and the route's record. */
export interface DeliverDeps extends WriteDeps { exec: Exec }

/** Where the PR goes (#936): the file's checkout, its repository's node id and default branch, the root epic's number and the goal's
 * repository (owner/name), which the PR names it in. */
export interface DeliverTarget { checkout: FileCheckout; repositoryId: string; base: string; root: number; goal: string }

/** Why the file cannot be delivered (#936), or undefined: its checkout sits on the repository's default branch (the Hive never pushes it) or the
 * file is not a .md. Nothing is pushed once `pr` is recorded, so a recorded one is never refused. Checked before any issue is written. */
export function deliveryRefusal(checkout: FileCheckout, defaultBranch: string, recorded: Readonly<Record<string, number>>): string | undefined {
  if (recorded[PR_KEY] !== undefined) return undefined;
  if (checkout.branch === defaultBranch) return `the decomposition file's checkout is on ${checkout.repository}'s default branch (${defaultBranch}): the Hive never pushes it`;
  if (!checkout.path.endsWith('.md')) return 'the decomposition file is not a .md file';
  return undefined;
}

// git's own words: Node's message carries the command, an absolute path included. A remote's URL may carry its credentials: userinfo is
// removed before the words leave
const redacted = (text: string): string => text.replace(/:\/\/[^@/\s]+@/g, '://');
const messageOf = (err: unknown): string => {
  const e = err as { stderr?: unknown };
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  return redacted(stderr !== '' ? stderr : err instanceof Error ? err.message : String(err));
};

// The PR may sit in a docs repository: it names the root issue with its own repository, and closes nothing
const prTitle = (t: DeliverTarget): string => `docs: decomposition for ${t.goal}#${t.root}`;
const prBody = (t: DeliverTarget): string =>
  `The decomposition of ${t.goal}#${t.root}. Its issues are on GitHub already; each one's \`Design:\` link opens this file on the default branch once this PR merges.`;

// The file's own changes only: a hand edit in the editor pane is committed, nothing else of the checkout slips in
async function commitFile(exec: Exec, { toplevel, path }: FileCheckout, root: number): Promise<void> {
  // literal: a name with glob or magic characters matches only itself, never other files of the checkout
  const git = (...args: string[]): Promise<{ stdout: string }> => exec('git', ['--literal-pathspecs', '-C', toplevel, ...args]);
  if ((await git('status', '--porcelain', '--', path)).stdout.trim() === '') return;
  await git('add', '--', path);
  await git('commit', '-m', `docs: decomposition for #${root}`, '--', path);
}

// GitHub refuses a second PR for the same head: the open one is the delivery's PR. Absent when there is none
async function openPullRequest(deps: DeliverDeps, t: DeliverTarget): Promise<number | undefined> {
  const variables = { ...ownerName(t.checkout.repository), head: t.checkout.branch, base: t.base };
  const data = (await deps.gql(OPEN_PULL_REQUEST, variables)) as OpenPullRequestData;
  return data.repository?.pullRequests?.nodes?.[0]?.number;
}

// The PR's number: the one created, else, when GitHub refuses (a crash between its opening and the record leaves one), the open one
async function pullRequestNumber(deps: DeliverDeps, t: DeliverTarget): Promise<number> {
  const variables = { repositoryId: t.repositoryId, baseRefName: t.base, headRefName: t.checkout.branch, title: prTitle(t), body: prBody(t) };
  try {
    const pr = ((await deps.gql(CREATE_PULL_REQUEST, variables)) as CreatePullRequestData).createPullRequest?.pullRequest;
    if (!pr) throw new Error('createPullRequest answered no pull request');
    return pr.number;
  } catch (err) {
    const open = await openPullRequest(deps, t).catch(() => undefined);
    if (open === undefined) throw err;
    return open;
  }
}

/** The delivery (#936), after the issues and links: undefined once the PR is recorded, or when `pr` already was; else the first error, and
 * nothing is recorded. */
export async function deliverDecomposition(deps: DeliverDeps, t: DeliverTarget, recorded: Readonly<Record<string, number>>): Promise<string | undefined> {
  if (recorded[PR_KEY] !== undefined) return undefined;
  try {
    await commitFile(deps.exec, t.checkout, t.root);
    await deps.exec('git', ['-C', t.checkout.toplevel, 'push', '-u', 'origin', t.checkout.branch]);
    await deps.record(PR_KEY, await pullRequestNumber(deps, t));
    return undefined;
  } catch (err) {
    return messageOf(err);
  }
}
