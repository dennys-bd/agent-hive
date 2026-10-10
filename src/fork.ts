import { githubRepository } from './task-refs.js';
import { type Config, type Exec, FORK_SYNCS, type ForkSync, type ForkSyncAnswer, type ForkSyncResult, type GitRemote, PR_TARGETS, type PrTarget, type Workspace, type WorkspaceFork } from './types.js';

// A workspace that is a fork (#854): its config parser. The prefix is config.ts's CONFIG_FILE, written out: importing it would make
// config.ts, which calls this parser, and this file import each other.
const FILE = 'hive.config.json';
// A remote name reaches git's argv: letters, digits, `.`, `_` and `-`, never a leading `-`
const REMOTE_NAME = /^(?!-)(?!\.+$)[A-Za-z0-9._-]+$/;
const ORIGIN = 'origin';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPrTarget = (value: unknown): value is PrTarget => PR_TARGETS.some((p) => p === value);
const isForkSync = (value: unknown): value is ForkSync => FORK_SYNCS.some((s) => s === value);

function fail(field: string, what: string): never {
  throw new Error(`${FILE}: "${field}" ${what}`);
}

/** A workspace's `fork` (#854), required: null (never decided), false (not a fork) or the object; `sync` only with pr fork or ask, required there. */
export function parseFork(raw: unknown, field: string): WorkspaceFork | false | null {
  if (raw === null || raw === false) return raw;
  if (!isRecord(raw)) return fail(field, 'must be null, false or { "remote", "pr" }');
  const { remote, pr, sync } = raw;
  if (typeof remote !== 'string' || !REMOTE_NAME.test(remote) || remote === ORIGIN) return fail(`${field}.remote`, 'must be a git remote name other than origin');
  if (!isPrTarget(pr)) return fail(`${field}.pr`, 'must be "original", "fork" or "ask"');
  if (pr === 'original') return sync === undefined ? { remote, pr } : fail(`${field}.sync`, 'needs "pr": "fork" or "ask"');
  return isForkSync(sync) ? { remote, pr, sync } : fail(`${field}.sync`, 'must be "github", "local" or "manual"');
}

const SYNC_TIMEOUT_MS = 60_000; // each gh call, as the wait for CI's (#834)
export const NOT_GITHUB = 'origin or the original\'s remote is not a GitHub repository';
// gh's and git's words for a host they could not reach
const NETWORK = /could not resolve host|error connecting to|dial tcp|network is unreachable|connection (?:refused|reset|timed out)|operation timed out|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i;
const REMOTE_LINE = /^(\S+)\t(\S+) \(fetch\)$/;

/** A fork's two GitHub repositories (#854), owner/name: the original's remote and origin. */
export interface ForkRepos { original: string; fork: string }
/** Where a workspace's worktrees start (#854): the base remote, the effective base branch (absent: <remote>/HEAD, else main), and its fork. */
export interface WorkspaceBase { remote: string; branch?: string; fork: WorkspaceFork | false | null }

/** The base remote (#854): the original's with PRs to it or ask; origin with PRs to the fork and for a workspace that is not a fork. */
export const baseRemote = ({ fork }: Pick<Workspace, 'fork'>): string => (fork && fork.pr !== 'fork' ? fork.remote : ORIGIN);

/** Where a workspace's worktrees start (#854): its own base branch over config.baseBranch; with no workspace, origin's. */
export function workspaceBase(config: Pick<Config, 'baseBranch'>, workspace: Pick<Workspace, 'fork' | 'baseBranch'> | undefined): WorkspaceBase {
  const branch = workspace?.baseBranch ?? config.baseBranch;
  return { remote: workspace === undefined ? ORIGIN : baseRemote(workspace), fork: workspace?.fork ?? null, ...(branch === undefined ? {} : { branch }) };
}

/** The owner of an owner/name. */
export const ownerOf = (repository: string): string => repository.split('/')[0] ?? '';

// A remote's GitHub repository; none when git fails or the remote is off GitHub
const repositoryAt = (exec: Exec, path: string, remote: string): Promise<string | undefined> =>
  exec('git', ['-C', path, 'remote', 'get-url', remote]).then(({ stdout }) => githubRepository(stdout.trim()), () => undefined);

/** The original and the fork (#854), from `git remote get-url` of the two remotes; undefined for a workspace that is not a fork or with a remote off GitHub. */
export async function forkRepos(exec: Exec, workspace: Pick<Workspace, 'path' | 'fork'>): Promise<ForkRepos | undefined> {
  if (!workspace.fork) return undefined;
  const [original, fork] = await Promise.all([repositoryAt(exec, workspace.path, workspace.fork.remote), repositoryAt(exec, workspace.path, ORIGIN)]);
  return original !== undefined && fork !== undefined ? { original, fork } : undefined;
}

/** The repository the base remote points at (#854): what GH_REPO names; none for a workspace that is not a fork. */
export const baseRepository = (exec: Exec, workspace: Pick<Workspace, 'path' | 'fork'>): Promise<string | undefined> =>
  (workspace.fork ? repositoryAt(exec, workspace.path, baseRemote(workspace)) : Promise.resolve(undefined));

/** A run's env (#854): a fork's GH_REPO under the workspace's own env, which wins; a workspace that is not a fork gets its env as it is. */
export async function runEnv(exec: Exec, workspace: Pick<Workspace, 'path' | 'fork' | 'env'>): Promise<Record<string, string>> {
  const repository = await baseRepository(exec, workspace);
  return repository === undefined ? workspace.env : { GH_REPO: repository, ...workspace.env };
}

// The words of a failed call: its stderr, else its message
function wordsOf(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  return (typeof e.stderr === 'string' && e.stderr.trim() !== '' ? e.stderr : String(e.message ?? err)).trim();
}

/** A sync that failed (#854): offline when gh or git could not reach the host (a killed call is the timeout), else error with the first line of their words. */
export function failureOf(err: unknown): Pick<ForkSyncResult, 'result' | 'reason'> {
  const words = wordsOf(err);
  if ((err as { killed?: unknown }).killed === true || NETWORK.test(words)) return { result: 'offline' };
  return { result: 'error', reason: words.split('\n')[0] ?? '' };
}

const countOf = (value: unknown): number => {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error('compare answered no commit counts');
  return value as number;
};

/** The GitHub sync, fast-forward only (#854): compare the fork's base with the original's. Nothing to receive is current; commits only on the
 * fork are diverged and nothing is written; otherwise merge-upstream, which then fast-forwards. Never throws. */
export async function syncFork(exec: Exec, repos: ForkRepos | undefined, base: string): Promise<ForkSyncAnswer> {
  if (repos === undefined) return { mode: 'github', base: `${ORIGIN}:${base}`, result: 'error', reason: NOT_GITHUB };
  const answer = { mode: 'github' as const, base: `${ownerOf(repos.fork)}:${base}` };
  const gh = async (args: string[]): Promise<string> => (await exec('gh', args, { timeout: SYNC_TIMEOUT_MS })).stdout;
  try {
    const compare = JSON.parse(await gh(['api', `repos/${repos.fork}/compare/${encodeURIComponent(base)}...${encodeURIComponent(ownerOf(repos.original))}:${encodeURIComponent(base)}`])) as { ahead_by?: unknown; behind_by?: unknown };
    const [ahead, behind] = [countOf(compare.ahead_by), countOf(compare.behind_by)];
    if (behind > 0) return { ...answer, result: 'diverged', commits: behind };
    if (ahead === 0) return { ...answer, result: 'current', commits: 0 };
    const merged = JSON.parse(await gh(['api', '-X', 'POST', `repos/${repos.fork}/merge-upstream`, '-f', `branch=${base}`])) as { merge_type?: unknown };
    // A merge commit written to the fork is what the compare was there to prevent; report it as the divergence it is
    if (merged.merge_type !== 'fast-forward') return { ...answer, result: 'diverged', commits: ahead };
    return { ...answer, result: 'synced', commits: ahead };
  } catch (err) {
    return { ...answer, ...failureOf(err) };
  }
}

/** A repository's remotes (#854) from `git remote -v`, once each (its fetch line), with the GitHub repository each points at. */
export async function remotesOf(exec: Exec, path: string): Promise<GitRemote[]> {
  const { stdout } = await exec('git', ['-C', path, 'remote', '-v']);
  return stdout.split('\n').flatMap((line) => {
    const match = REMOTE_LINE.exec(line.trim());
    if (match === null) return [];
    const repository = githubRepository(match[2]);
    return [{ name: match[1], ...(repository === undefined ? {} : { repository }) }];
  });
}
