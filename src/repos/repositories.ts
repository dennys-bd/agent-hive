import { taskWorkspace } from '../config.js';
import { githubRepository } from '../task-refs.js';
import { forkRepos, isForkRepos } from '../fork.js';
import { GITHUB_HOST, hostKind, parsePrLink, remoteRepository, repoKey } from '../repo-host.js';
import type { Machine } from '../machine.js';
import type { ActivityRecord, Config, PrTarget, State, Workspace } from '../types.js';

/** A repository the flow sidebar lists (#757), before its host is asked about it: its host and its path there (#1045: owner/name on GitHub,
 * the full path on GitLab) and the workspace whose colour it takes; for a fork workspace (#854) its role, the workspace's PR target and the
 * other repository of the pair, for a nested repo (#653) its workspace's repository, each `pair` a repoKey. */
export interface RepoRef { host: string; repository: string; workspace: string; role?: 'original' | 'fork' | 'nested'; pr?: PrTarget; pair?: string }

/** What the list reads a workspace's repositories with (#929): git, and the paths a nested repo's checkout is joined with. */
type RepoMachine = Pick<Machine, 'exec' | 'paths'>;

/** Where a repository is (#1045): its host and its path there. */
type Located = Pick<RepoRef, 'host' | 'repository'>;
// A ref whose place may be missing: a checkout with no origin, a remote or a link of no host kind
type MaybeRef = Omit<RepoRef, 'host' | 'repository'> & Partial<Located>;

// The origin remote's URL; '' with no checkout or a failing git
const originRemote = (machine: Pick<Machine, 'exec'>, path: string): Promise<string> =>
  machine.exec('git', ['-C', path, 'remote', 'get-url', 'origin']).then(({ stdout }) => stdout.trim(), () => '');

/** A checkout's origin as a repository (#1045, decision 4): its host and path on GitHub or on a GitLab host of the list; none off both. */
export async function originRef(machine: Pick<Machine, 'exec'>, path: string, gitlabHosts: readonly string[]): Promise<Located | undefined> {
  const read = remoteRepository(await originRemote(machine, path), gitlabHosts);
  return read === undefined ? undefined : { host: read.host, repository: read.repository };
}

// A workspace's own repositories (#854): a fork's original then its fork when both are on GitHub, else its origin, a fork with a remote on
// GitLab included (#1045, decision 5)
async function ownRefs(machine: Pick<Machine, 'exec'>, workspace: Workspace, gitlabHosts: readonly string[]): Promise<MaybeRef[]> {
  const repos = workspace.fork ? await forkRepos(machine, workspace, gitlabHosts) : undefined;
  if (!isForkRepos(repos) || !workspace.fork) return [{ ...(await originRef(machine, workspace.path, gitlabHosts)), workspace: workspace.name }];
  const { pr } = workspace.fork;
  const original: Located = { host: GITHUB_HOST, repository: repos.original };
  const fork: Located = { host: GITHUB_HOST, repository: repos.fork };
  return [
    { ...original, workspace: workspace.name, role: 'original', pr, pair: repoKey(fork) },
    { ...fork, workspace: workspace.name, role: 'fork', pr, pair: repoKey(original) },
  ];
}

// The repoKey of a ref whose host and path are both known
const keyOf = ({ host, repository }: MaybeRef): string | undefined => (host === undefined || repository === undefined ? undefined : repoKey({ host, repository }));

// A workspace's own repositories and then its nested repos (#653), each paired with the repoKey of the workspace's repository (the original's
// for a fork, else the origin's); with none listed, a nested one is a plain row. One of no host kind, or with no checkout, adds none
async function workspaceRefs(machine: RepoMachine, workspace: Workspace, gitlabHosts: readonly string[]): Promise<MaybeRef[]> {
  const own = await ownRefs(machine, workspace, gitlabHosts);
  const pair = own[0] === undefined ? undefined : keyOf(own[0]);
  const nested = await Promise.all(workspace.nestedRepos.map((path) => originRef(machine, machine.paths.join(workspace.path, path), gitlabHosts)));
  return [...own, ...nested.map((at): MaybeRef => ({ ...at, workspace: workspace.name, ...(pair === undefined ? {} : { role: 'nested' as const, pair }) }))];
}

// The GitHub repository of a workspace's origin (#588), for a terminal whose task has none of its own (one created in the Hive) and for a
// workspace shell. No checkout, a failing git or a remote off GitHub leave none: the click then resolves only the Hive's tasks. GitHub's
// only (#1045, decision 4): its callers read GitHub with it
export async function originRepository(machine: Pick<Machine, 'exec'>, path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  return githubRepository(await originRemote(machine, path));
}

// An open PR's repository (#1045, decision 4): a GitHub PR's, or an MR's on a GitLab host of the list, its host lowercased as a remote's
// is; none for any other link
function prRef(url: string, gitlabHosts: readonly string[]): Located | undefined {
  const link = parsePrLink(url);
  return link === undefined || hostKind(link.host, gitlabHosts) === undefined ? undefined : { host: link.host.toLowerCase(), repository: link.repository };
}

// The workspace a record's PRs belong to (#757): its live activity's; a deleted activity's record has none, so its task's
function recordWorkspace(config: Pick<Config, 'comb'>, state: Pick<State, 'tasks' | 'activities'>, record: ActivityRecord): string | undefined {
  const live = state.activities.find((a) => a.id === record.id);
  if (live) return live.workspace;
  const task = state.tasks.find((t) => record.taskIds.includes(t.item.itemId));
  return task === undefined ? undefined : taskWorkspace(config, task)?.name;
}

/** The repositories the Hive knows (#757): each workspace's origin and nested repos in the Comb's order, read on its own machine (#932), then
 * the repository of every open PR in the activity records with its activity's workspace; each repoKey once (#1045), with the first workspace
 * that named it. A workspace whose origin is of no host kind, or whose machine is unavailable, adds none. A fork workspace adds its original
 * and then its fork (#854). ponytail: a path compares as written, so an origin and a PR link that differ only in case list twice. */
export async function listRepositories(config: Pick<Config, 'comb' | 'gitlabHosts'>, state: Pick<State, 'tasks' | 'activities' | 'activityRecords'>, machineFor: (workspace: Pick<Workspace, 'machine'>) => RepoMachine): Promise<RepoRef[]> {
  const origins = (await Promise.all(config.comb.workspaces.map((w) => workspaceRefs(machineFor(w), w, config.gitlabHosts)))).flat();
  const prs = state.activityRecords.flatMap((record): MaybeRef[] => {
    const workspace = recordWorkspace(config, state, record);
    if (workspace === undefined) return [];
    return (record.prs ?? []).filter((pr) => pr.state === 'open').map((pr) => ({ ...prRef(pr.url, config.gitlabHosts), workspace }));
  });
  const seen = new Set<string>();
  return [...origins, ...prs].flatMap(({ host, repository, ...rest }) => {
    if (host === undefined || repository === undefined || seen.has(repoKey({ host, repository }))) return [];
    seen.add(repoKey({ host, repository }));
    return [{ host, repository, ...rest }];
  });
}

/** The refs on GitHub (#1045, decision 10): what the read loop syncs and hive_pr's preload matches, until GitLab is read (#1055). The GitHub
 * round would otherwise call GitHub with a GitLab path. */
export const githubRefs = (refs: readonly RepoRef[]): RepoRef[] => refs.filter((ref) => ref.host === GITHUB_HOST);
