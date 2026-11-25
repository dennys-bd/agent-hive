import type { Logger } from './log.js';
import type { Machine } from './machine.js';
import { githubRepository } from './task-refs.js';
import { GITLAB_HOST, type RemoteRepository, remoteRepository } from './repo-host.js';
import type { RenderWorkspace } from './template.js';
import { type CombConfig, type Config, FORK_SYNCS, type ForkSync, LOCAL_MACHINE, type ForkSyncAnswer, type ForkSyncResult, type GitRemote, PR_TARGETS, type PrTarget, type Workspace, type WorkspaceFork } from './types.js';

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
/** The words a fork with a remote on GitLab is refused in (#1045, decision 15): its sync's, the save's and the boot's. Forks on GitLab are
 * out of #787. */
export const FORK_ON_GITLAB = 'forks on GitLab are not supported';
// gh's and git's words for a host they could not reach, and the codes Node's fetch puts on its cause when DNS, the route or the connect
// fails (#291: apiGql's `fetch failed`)
const NETWORK = /could not resolve host|error connecting to|dial tcp|network is unreachable|connection (?:refused|reset|timed out)|operation timed out|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT/i;
const REMOTE_LINE = /^(\S+)\t(\S+) \(fetch\)$/;

/** A fork's two GitHub repositories (#854), owner/name: the original's remote and origin. */
export interface ForkRepos { original: string; fork: string }
/** Why a fork has no GitHub pair (#1045, decision 15): FORK_ON_GITLAB or NOT_GITHUB, the words its sync reports. */
export interface ForkRefusal { reason: string }
/** A workspace's fork as its remotes read (#854, #1045): the GitHub pair, the refusal, or undefined for a workspace that is not a fork. */
export type ForkAnswer = ForkRepos | ForkRefusal | undefined;
export const isForkRepos = (answer: ForkAnswer): answer is ForkRepos => answer !== undefined && 'original' in answer;
/** Where a workspace's worktrees start (#854): the base remote, the effective base branch (absent: <remote>/HEAD, else main), and its fork.
 * gitlabHosts (#1045): the config's, which the fork sync at a worktree's creation reads its remotes against; absent where no worktree is made,
 * so gitlab.com alone is GitLab there. */
export interface WorkspaceBase { remote: string; branch?: string; fork: WorkspaceFork | false | null; gitlabHosts?: readonly string[] }

/** The base remote (#854): the original's with PRs to it or ask; origin with PRs to the fork and for a workspace that is not a fork. */
export const baseRemote = ({ fork }: Pick<Workspace, 'fork'>): string => (fork && fork.pr !== 'fork' ? fork.remote : ORIGIN);

/** Where a workspace's worktrees start (#854): its own base branch over config.baseBranch; with no workspace, origin's. */
export function workspaceBase(config: Pick<Config, 'baseBranch'>, workspace: Pick<Workspace, 'fork' | 'baseBranch'> | undefined): WorkspaceBase {
  const branch = workspace?.baseBranch ?? config.baseBranch;
  return { remote: workspace === undefined ? ORIGIN : baseRemote(workspace), fork: workspace?.fork ?? null, ...(branch === undefined ? {} : { branch }) };
}

// The skill's own nested-path rule (#742): a path is rendered into instruction text, so one that could not be a PR's anyway (a backtick, a
// line break, a quote) never reaches it
const RENDERABLE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** A workspace as a template renders it (#742, decision 2): its name and values, and the built-ins read from its Settings and the general
 * ones (#1044: gitlab.com, then the config's GitLab hosts). One helper, so the plugin render, the protocol passages and the lint input fill
 * them the same way; nothing here reads git, so a render never goes stale. */
export function renderWorkspaceOf(config: Pick<Config, 'baseBranch' | 'gitlabHosts'>, workspace: Pick<Workspace, 'name' | 'variables' | 'fork' | 'baseBranch' | 'nestedRepos'>): RenderWorkspace {
  const { fork } = workspace;
  const { branch } = workspaceBase(config, workspace);
  return {
    name: workspace.name,
    variables: workspace.variables,
    builtIns: {
      fork: fork ? { remote: fork.remote, pr: fork.pr, baseRemote: baseRemote(workspace) } : null,
      baseBranch: branch ?? null,
      nestedRepos: workspace.nestedRepos.filter((path) => RENDERABLE_PATH.test(path) && !path.split('/').includes('..')),
      gitlabHosts: [GITLAB_HOST, ...config.gitlabHosts],
    },
  };
}

/** The owner of an owner/name. */
export const ownerOf = (repository: string): string => repository.split('/')[0] ?? '';

// A remote's GitHub repository; none when git fails or the remote is off GitHub
const repositoryAt = (machine: Pick<Machine, 'exec'>, path: string, remote: string): Promise<string | undefined> =>
  machine.exec('git', ['-C', path, 'remote', 'get-url', remote]).then(({ stdout }) => githubRepository(stdout.trim()), () => undefined);

// A remote's host and repository against the GitLab hosts; none when git fails or the remote is of no host kind
const remoteAt = (machine: Pick<Machine, 'exec'>, path: string, remote: string, gitlabHosts: readonly string[]): Promise<RemoteRepository | undefined> =>
  machine.exec('git', ['-C', path, 'remote', 'get-url', remote]).then(({ stdout }) => remoteRepository(stdout.trim(), gitlabHosts), () => undefined);

/** The original and the fork (#854), from `git remote get-url` of the two remotes read against the config's GitLab hosts (#1045): the pair
 * when both are on GitHub, FORK_ON_GITLAB when either is on GitLab, NOT_GITHUB otherwise; undefined for a workspace that is not a fork. */
export async function forkRepos(machine: Pick<Machine, 'exec'>, workspace: Pick<Workspace, 'path' | 'fork'>, gitlabHosts: readonly string[]): Promise<ForkAnswer> {
  if (!workspace.fork) return undefined;
  const [original, fork] = await Promise.all([remoteAt(machine, workspace.path, workspace.fork.remote, gitlabHosts), remoteAt(machine, workspace.path, ORIGIN, gitlabHosts)]);
  if (original?.kind === 'gitlab' || fork?.kind === 'gitlab') return { reason: FORK_ON_GITLAB };
  // a remote of either kind that is not GitLab is GitHub: the pair
  return original !== undefined && fork !== undefined ? { original: original.repository, fork: fork.repository } : { reason: NOT_GITHUB };
}

/** Whether a fork workspace has a remote on GitLab (#1045, decisions 14, 16): what Settings refuses and a boot warns of. Never rejects:
 * forkRepos reads a failing git as no remote. */
export async function isGitlabFork(machine: Pick<Machine, 'exec'>, workspace: Pick<Workspace, 'path' | 'fork'>, gitlabHosts: readonly string[]): Promise<boolean> {
  const answer = await forkRepos(machine, workspace, gitlabHosts);
  return answer !== undefined && !isForkRepos(answer) && answer.reason === FORK_ON_GITLAB;
}

/** The save's refusal and the boot's line (#1045): the workspace, then the sync's own words. */
export const gitlabForkLine = (workspace: string): string => `${workspace}: ${FORK_ON_GITLAB}`;

/** One warn line per fork workspace with a remote on GitLab (#1045, decision 16). A boot goes on: refusing there would leave the whole Hive
 * in setup mode for one workspace, and its sync already answers the refusal. Only local workspaces are read: no call reaches another
 * machine at boot (#932). ponytail: a GitLab fork on a WSL distro gets no boot line; its save and its sync still say the words. */
export async function warnGitlabForks(config: { comb: Pick<CombConfig, 'workspaces'> } & Pick<Config, 'gitlabHosts'>, machineFor: (workspace: Pick<Workspace, 'machine'>) => Pick<Machine, 'exec'>, log: Pick<Logger, 'warn'>): Promise<void> {
  for (const workspace of config.comb.workspaces) {
    if (workspace.machine !== LOCAL_MACHINE) continue;
    if (await isGitlabFork(machineFor(workspace), workspace, config.gitlabHosts)) log.warn(gitlabForkLine(workspace.name));
  }
}

/** The repository the base remote points at (#854): what GH_REPO names; none for a workspace that is not a fork. */
export const baseRepository = (machine: Pick<Machine, 'exec'>, workspace: Pick<Workspace, 'path' | 'fork'>): Promise<string | undefined> =>
  (workspace.fork ? repositoryAt(machine, workspace.path, baseRemote(workspace)) : Promise.resolve(undefined));

/** A run's env (#854): a fork's GH_REPO under the workspace's own env, which wins; a workspace that is not a fork gets its env as it is. */
export async function runEnv(machine: Pick<Machine, 'exec'>, workspace: Pick<Workspace, 'path' | 'fork' | 'env'>): Promise<Record<string, string>> {
  const repository = await baseRepository(machine, workspace);
  return repository === undefined ? workspace.env : { GH_REPO: repository, ...workspace.env };
}

// The words of a failed call: its stderr, else its message
function wordsOf(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  return (typeof e.stderr === 'string' && e.stderr.trim() !== '' ? e.stderr : String(e.message ?? err)).trim();
}

const propsOf = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/** A call that never reached the host (#854, #291): gh's or git's words for it, a killed call (the timeout), fetch's failure with a network
 * code on its cause, or AbortSignal.timeout's TimeoutError. The one test of offline: the fork sync's and the boot's. */
export function isNetworkError(err: unknown): boolean {
  const e = propsOf(err);
  if (e.killed === true || e.name === 'TimeoutError') return true;
  const cause = propsOf(e.cause);
  const words = typeof err === 'object' && err !== null ? wordsOf(err) : String(err);
  return NETWORK.test(words) || NETWORK.test(`${String(cause.code ?? '')} ${String(cause.message ?? '')}`);
}

/** A sync that failed (#854): offline when gh or git could not reach the host (a killed call is the timeout), else error with the first line of their words. */
export function failureOf(err: unknown): Pick<ForkSyncResult, 'result' | 'reason'> {
  const words = wordsOf(err);
  if (isNetworkError(err)) return { result: 'offline' };
  return { result: 'error', reason: words.split('\n')[0] ?? '' };
}

const countOf = (value: unknown): number => {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error('compare answered no commit counts');
  return value as number;
};

/** The GitHub sync, fast-forward only (#854): compare the fork's base with the original's. Nothing to receive is current; commits only on the
 * fork are diverged and nothing is written; otherwise merge-upstream, which then fast-forwards. A fork with no GitHub pair is the error with
 * forkRepos' words (#1045). Never throws. */
export async function syncFork(machine: Pick<Machine, 'exec'>, repos: ForkAnswer, base: string): Promise<ForkSyncAnswer> {
  if (!isForkRepos(repos)) return { mode: 'github', base: `${ORIGIN}:${base}`, result: 'error', reason: repos?.reason ?? NOT_GITHUB };
  const answer = { mode: 'github' as const, base: `${ownerOf(repos.fork)}:${base}` };
  const gh = async (args: string[]): Promise<string> => (await machine.exec('gh', args, { timeout: SYNC_TIMEOUT_MS })).stdout;
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
export async function remotesOf(machine: Pick<Machine, 'exec'>, path: string): Promise<GitRemote[]> {
  const { stdout } = await machine.exec('git', ['-C', path, 'remote', '-v']);
  return stdout.split('\n').flatMap((line) => {
    const match = REMOTE_LINE.exec(line.trim());
    if (match === null) return [];
    const repository = githubRepository(match[2]);
    return [{ name: match[1], ...(repository === undefined ? {} : { repository }) }];
  });
}
