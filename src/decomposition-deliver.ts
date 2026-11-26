// Where a decomposition's file lives, and its delivery (#936): the git checkout that holds the file (the goal's worktree, or a docsRepo's,
// wherever it sits), the repository of its origin on GitHub or a GitLab host (#1053), its current branch and the file's path in it. What the
// Design: links point at and where the delivery commits, pushes and opens its PR, or its merge request on GitLab. A file git ignores is
// delivered by no PR: it stays local (#741). Git through execFile with argv arrays; GitLab through the host's account, never glab.
import { PR_KEY } from './decomposition.js';
import { readRepository, type WriteDeps } from './decomposition-write.js';
import type { GitlabApi } from './gitlab/api.js';
import { type GitlabAccess, openMergeRequest, readProject } from './gitlab/merge-requests.js';
import { ownerName } from './repos/github-repos.js';
import type { Machine } from './machine.js';
import { GITHUB_HOST, type HostKind } from './repo-host.js';
import { issueUrl } from './repos/issue-task.js';
import { originRef } from './repos/repositories.js';
import type { GqlJson } from './sources/github-gql.js';
import { CREATE_PULL_REQUEST, type CreatePullRequestData, OPEN_PULL_REQUEST, type OpenPullRequestData } from './sources/github-queries.js';
import type { Exec } from './types.js';
import { toWire } from './wire-path.js';

/** The file's checkout (#936): its toplevel, its origin's host (#1053) and repository there (owner/name on GitHub, the project's full path on
 * GitLab), its current branch, and the file's path relative to the toplevel, '/'-separated (#641). */
export interface FileCheckout { toplevel: string; host: string; repository: string; branch: string; path: string; ignored: boolean }

/** #783: the file is in no checkout, or its checkout's origin is off GitHub. The GitHub target refuses it with these words; the hive target
 * keeps the file local (decision 5), at `path`, the file's path in a checkout off GitHub; absent with no checkout. */
export class OffGithubError extends Error {
  readonly path?: string;
  constructor(message: string, path?: string) {
    super(message);
    if (path !== undefined) this.path = path;
  }
}

/** #1053: the checkout is on a GitLab host the Hive has no account for. A refusal the user fixes in Settings, before any write, on every
 * target: never an OffGithubError, so the hive target does not keep the file local. */
export class NoGitlabAccountError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`no GitLab account for ${host}: connect one in Settings › Accounts`);
    this.name = 'NoGitlabAccountError';
    this.host = host;
  }
}

/** The kind of the checkout's host: fileCheckout answers only GitHub's or a GitLab host. */
export const checkoutKind = (checkout: Pick<FileCheckout, 'host'>): HostKind => (checkout.host === GITHUB_HOST ? 'github' : 'gitlab');

/** The machine a decomposition's file is on (#929): git runs there, and the file's path is read in its flavour. */
export type DeliveryMachine = Pick<Machine, 'exec' | 'paths' | 'info'>;

/** The checkout of `file`, a real absolute path (#936), learned from the file itself: the Hive keeps no copy of the conventions. No checkout,
 * an origin on neither host (#1053: GitHub or a GitLab host of the live list) or a detached HEAD is refused with fixed words before anything
 * is written; #783: the first two as OffGithubError. */
export async function fileCheckout(machine: DeliveryMachine, file: string, gitlabHosts: readonly string[]): Promise<FileCheckout> {
  const { exec, paths } = machine;
  const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
  // git answers the toplevel with its symlinks resolved, as the file's real path is, so the relative path holds
  const toplevel = await git(paths.dirname(file), 'rev-parse', '--show-toplevel').catch(() => '');
  if (toplevel === '') throw new OffGithubError('the decomposition file is in no git checkout');
  const path = toWire(paths.relative(toplevel, file), machine.info().platform); // #641: the Design: links and git's pathspecs take /
  const origin = await originRef(machine, toplevel, gitlabHosts);
  if (origin === undefined) throw new OffGithubError('the decomposition file\'s checkout has no GitHub or GitLab origin', path); // #783: the hive keeps it local, here
  const branch = await git(toplevel, 'branch', '--show-current');
  if (branch === '') throw new Error('the decomposition file\'s checkout is on no branch: nothing to push');
  return { toplevel, host: origin.host, repository: origin.repository, branch, path, ignored: await isIgnored(exec, toplevel, path) };
}

// check-ignore -q: exit 0 ignored, exit 1 not ignored, anything else is a failed read like the others. check-ignore refuses
// --literal-pathspecs (exit 128, #544) and never globs its argument after `--`, so it goes without
async function isIgnored(exec: Exec, toplevel: string, path: string): Promise<boolean> {
  try {
    await exec('git', ['-C', toplevel, 'check-ignore', '-q', '--', path]);
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return false;
    throw new Error(messageOf(err));
  }
}

/** What the delivery needs (#936): git in the file's checkout, the Hive's login, the route's record, and a GitLab host's account (#1053). */
export interface DeliverDeps extends WriteDeps { exec: Exec; gitlabAccess: GitlabAccess }

/** What a delivery's PR and commit say (#783, decision 15): the GitHub write's name the root issue, the hive write's the goal's ref and title. */
export interface DeliveryWords { title: string; body: string; commit: string }

/** Where the PR goes (#936): the file's checkout, its repository's node id and default branch, and its words. */
export interface DeliverTarget extends DeliveryWords { checkout: FileCheckout; repositoryId: string; base: string }

/** Why the file cannot be delivered (#936), or undefined: its checkout sits on the repository's default branch (the Hive never pushes it) or the
 * file is not a .md. Nothing is pushed once `pr` is recorded, nor for a file git ignores, which stays local (#741): neither is ever refused.
 * Checked before any issue is written. */
export function deliveryRefusal(checkout: FileCheckout, defaultBranch: string, recorded: Readonly<Record<string, number>>): string | undefined {
  if (recorded[PR_KEY] !== undefined) return undefined;
  if (checkout.ignored) return undefined;
  if (checkout.branch === defaultBranch) return `the decomposition file's checkout is on ${checkout.repository}'s default branch (${defaultBranch}): the Hive never pushes it`;
  if (!checkout.path.endsWith('.md')) return 'the decomposition file is not a .md file';
  return undefined;
}

/** Where the file is delivered (#936): its checkout and the default branch of that checkout's repository. */
export interface Delivery { checkout: FileCheckout; docs: { id: string; defaultBranch: string } }

/** The delivery, or the error that stopped reading it (#783): read once per request and handed to both targets, each reading the error its own way. */
export type DeliveryRead = { delivery: Delivery } | { error: unknown };

/** What reading a delivery needs (#1053): the Hive's GitHub login, the live config's GitLab hosts and each host's account. */
export interface DeliveryReadDeps { gql: GqlJson; gitlabHosts: readonly string[]; gitlabAccess: GitlabAccess }

// The host's account, or the refusal that names the host
async function gitlabOf(access: GitlabAccess, host: string): Promise<GitlabApi> {
  const api = await access(host);
  if (api === undefined) throw new NoGitlabAccountError(host);
  return api;
}

export async function readDelivery(machine: DeliveryMachine, deps: DeliveryReadDeps, file: string): Promise<DeliveryRead> {
  try {
    const checkout = await fileCheckout(machine, file, deps.gitlabHosts);
    const docs = checkout.host === GITHUB_HOST
      ? await readRepository(deps.gql, checkout.repository)
      : await readProject(await gitlabOf(deps.gitlabAccess, checkout.host), checkout.repository);
    return { delivery: { checkout, docs } };
  } catch (error) {
    return { error };
  }
}

/** What the dialog shows of a delivery (#936): the checkout's repository, branch and path, local when git ignores the file (#741), and why it cannot go. */
export function checkoutPreview({ checkout, docs }: Delivery, recorded: Readonly<Record<string, number>>): { delivery: { repository: string; branch: string; path: string; local?: true }; deliveryRefusal?: string } {
  const refusal = deliveryRefusal(checkout, docs.defaultBranch, recorded);
  const local = checkout.ignored ? { local: true as const } : {};
  return { delivery: { repository: checkout.repository, branch: checkout.branch, path: checkout.path, ...local }, ...(refusal === undefined ? {} : { deliveryRefusal: refusal }) };
}

// git's own words: Node's message carries the command, an absolute path included. A remote's URL may carry its credentials: userinfo is
// removed before the words leave
const redacted = (text: string): string => text.replace(/:\/\/[^/\s]*@/g, '://');
/** git's or GitHub's words for an error, userinfo removed (#936); the hive route answers them too (#783). */
export const messageOf = (err: unknown): string => {
  const e = err as { stderr?: unknown };
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  return redacted(stderr !== '' ? stderr : err instanceof Error ? err.message : String(err));
};

// #1053: a body read on GitLab names GitLab's concept
const REQUEST_NAME: Record<HostKind, string> = { github: 'this PR', gitlab: 'this merge request' };
const deliveryBody = (subject: string, where: string, kind: HostKind): string =>
  `The decomposition of ${subject}. ${where}; each one's \`Design:\` link opens this file on the default branch once ${REQUEST_NAME[kind]} merges.`;

// The PR may sit in a docs repository: it names the root issue with its own repository, and closes nothing. GitLab does not link a GitHub
// owner/repo#n, so there the root issue is its full link (#1053)
export const githubDeliveryWords = (goal: string, root: number, kind: HostKind): DeliveryWords => ({
  title: `docs: decomposition for ${goal}#${root}`,
  body: deliveryBody(kind === 'gitlab' ? issueUrl(goal, root) : `${goal}#${root}`, 'Its issues are on GitHub already', kind),
  commit: `docs: decomposition for #${root}`,
});

// #783: there is no root issue to name, so the goal is named by its ref (owner/repo#n, or a hive goal's display id) and its title; #1053: a
// GitHub goal's `link` replaces its ref in a body read on GitLab
export function hiveDeliveryWords(ref: string, title: string, kind: HostKind, link?: string): DeliveryWords {
  const line = `docs: decomposition for ${ref}: ${title}`;
  return { title: line, commit: line, body: deliveryBody(kind === 'gitlab' && link !== undefined ? link : ref, 'Its tasks are in the Hive', kind) };
}

// #832: a Jira goal has no owner/repo#n: the PR names its key and title, and its issues are in Jira
export function sourceDeliveryWords(key: string, title: string, kind: HostKind): DeliveryWords {
  const line = `docs: decomposition for ${key}: ${title}`;
  return { title: line, commit: line, body: deliveryBody(key, 'Its issues are in Jira already', kind) };
}

// The file's own changes only: a hand edit in the editor pane is committed, nothing else of the checkout slips in
async function commitFile(exec: Exec, { toplevel, path }: FileCheckout, message: string): Promise<void> {
  // literal: a name with glob or magic characters matches only itself, never other files of the checkout
  const git = (...args: string[]): Promise<{ stdout: string }> => exec('git', ['--literal-pathspecs', '-C', toplevel, ...args]);
  if ((await git('status', '--porcelain', '--', path)).stdout.trim() === '') return;
  await git('add', '--', path);
  await git('commit', '-m', message, '--', path);
}

// GitHub refuses a second PR for the same head: the open one is the delivery's PR. Absent when there is none
async function openPullRequest(deps: DeliverDeps, t: DeliverTarget): Promise<number | undefined> {
  const variables = { ...ownerName(t.checkout.repository), head: t.checkout.branch, base: t.base };
  const data = (await deps.gql(OPEN_PULL_REQUEST, variables)) as OpenPullRequestData;
  // a fork's PR of the same branch name is not this checkout's: only a head in the checkout's own repository is adopted
  const own = t.checkout.repository.toLowerCase();
  return data.repository?.pullRequests?.nodes?.find((n) => n.headRepository?.nameWithOwner?.toLowerCase() === own)?.number;
}

// The PR's number: the one created, else, when GitHub refuses (a crash between its opening and the record leaves one), the open one
async function pullRequestNumber(deps: DeliverDeps, t: DeliverTarget): Promise<number> {
  const variables = { repositoryId: t.repositoryId, baseRefName: t.base, headRefName: t.checkout.branch, title: t.title, body: t.body };
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

// #1053: the MR's iid, the create or the project's own open one (openMergeRequest), opened with the host's account
async function mergeRequestNumber(deps: DeliverDeps, t: DeliverTarget): Promise<number> {
  const api = await gitlabOf(deps.gitlabAccess, t.checkout.host);
  const mr = { source: t.checkout.branch, target: t.base, title: t.title, body: t.body };
  return (await openMergeRequest(api, t.checkout.repository, mr)).iid;
}

/** The delivery (#936), after the issues and links: undefined once the PR is recorded, or when `pr` already was; else the first error, and
 * nothing is recorded. */
export async function deliverDecomposition(deps: DeliverDeps, t: DeliverTarget, recorded: Readonly<Record<string, number>>): Promise<string | undefined> {
  if (recorded[PR_KEY] !== undefined) return undefined;
  try {
    await commitFile(deps.exec, t.checkout, t.commit);
    await deps.exec('git', ['-C', t.checkout.toplevel, 'push', '-u', 'origin', t.checkout.branch]);
    await deps.record(PR_KEY, t.checkout.host === GITHUB_HOST ? await pullRequestNumber(deps, t) : await mergeRequestNumber(deps, t)); // #1053: an MR's iid, as a PR's number
    return undefined;
  } catch (err) {
    return messageOf(err);
  }
}
