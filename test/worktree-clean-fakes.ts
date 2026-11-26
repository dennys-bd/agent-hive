import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import type { Exec, TaskPr } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { HOST_PATHS } from './fake-machine.js';
import { tempDir, type AfterHost } from './temp-dir.js';
import { CLEAN_BRANCH, porcelain, SLUG } from './worktree-fakes.js';

// cleanWorktree's fakes, shared by worktree-remove.test.ts and worktree-remove-gitlab.test.ts (#1053)

export const UPSTREAM_FORMAT = '--format=%(upstream)%00%(upstream:track)'; // mergeCheck's one read: the upstream and whether git calls it gone (#660)
export const GONE_UPSTREAM = 'refs/remotes/origin/hive/58-clear-worktree';

// cleanWorktree's git: lists `listed`, knows `branches`, answers the status read inside the worktree with `answers.status` and the
// branch's upstream and its track with `answers.upstream` / `answers.track`, refuses the commands in `refuse` (key: the first two words) with their stderr and exit
// code 1, and records every argv after `-C <dir>`.
export function cleanGit(repo: string, listed: string, branches: string[], refuse: Record<string, string> = {}, answers: { status?: string; upstream?: string; track?: string } = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const fail = (command: string[], stderr: string): never => {
    throw Object.assign(new Error(`Command failed: git ${command.join(' ')}`), { stderr, code: 1 });
  };
  const exec: Exec = async (file, args) => {
    assert.equal(file, 'git');
    const command = args.slice(2);
    const dir = command[0] === 'status' ? worktreePath(HOST_PATHS, repo, SLUG) : repo;
    assert.deepEqual(args.slice(0, 2), ['-C', dir], 'the status is read inside the worktree; every other command runs against the main checkout');
    calls.push(command);
    const key = command.slice(0, 2).join(' ');
    if (key in refuse) return fail(command, refuse[key]);
    if (key === 'worktree list') return { stdout: listed };
    if (key === 'rev-parse --verify') return branches.includes(command.at(-1)!.replace('refs/heads/', '')) ? { stdout: '0123456\n' } : fail(command, '');
    if (key === 'status --porcelain') return { stdout: answers.status ?? '' };
    if (key === `for-each-ref ${UPSTREAM_FORMAT}`) return { stdout: `${answers.upstream ?? ''}\0${answers.track ?? ''}\n` };
    return { stdout: '' };
  };
  return { exec, calls };
}

// What the pre-check runs for CLEAN_BRANCH with no upstream: the upstream lookup, then the ancestry test against HEAD.
export const MERGE_CHECK = [['for-each-ref', UPSTREAM_FORMAT, `refs/heads/${CLEAN_BRANCH}`], ['merge-base', '--is-ancestor', `refs/heads/${CLEAN_BRANCH}`, 'HEAD']];

export async function cleanRepo(t: AfterHost, worktree: boolean): Promise<{ repo: string; path: string }> {
  const repo = await tempDir(t, 'wt-');
  const path = worktreePath(HOST_PATHS, repo, SLUG);
  if (worktree) await mkdir(path, { recursive: true });
  return { repo, path };
}

export const PR = 'https://github.com/acme/app/pull/58';
export const OPEN_PR = 'https://github.com/acme/app/pull/59';
export const CLOSED_PR = 'https://github.com/acme/app/pull/57';
export const TIP = '0123456'; // what cleanGit's rev-parse --verify answers for a branch it knows
export const mergedPr = (url = PR): TaskPr => ({ url, state: 'merged' });

// cleanGit's exec with gh in front (#660): `gh pr view <url>` answers heads[url] as a MERGED PR at that head; any other url fails as gh does.
// Every gh argv is recorded.
export function withGh(git: Exec, heads: Record<string, string>): { exec: Exec; gh: string[][] } {
  const gh: string[][] = [];
  const exec: Exec = async (file, args, opts) => {
    if (file !== 'gh') return git(file, args, opts);
    gh.push(args);
    const head = heads[args[2] ?? ''];
    if (head === undefined) throw Object.assign(new Error('Command failed: gh pr view'), { stderr: 'GraphQL: Could not resolve to a PullRequest\n', code: 1 });
    return { stdout: JSON.stringify({ state: 'MERGED', headRefOid: head }) };
  };
  return { exec, gh };
}

// A squash-merged branch as git sees it: never an ancestor of HEAD; gh answers `heads`
export function squashed(repo: string, path: string, heads: Record<string, string>): { exec: Exec; calls: string[][]; gh: string[][] } {
  const git = cleanGit(repo, porcelain(repo, [[path, CLEAN_BRANCH]]), [CLEAN_BRANCH], { 'merge-base --is-ancestor': '' });
  const { exec, gh } = withGh(git.exec, heads);
  return { exec, calls: git.calls, gh };
}
