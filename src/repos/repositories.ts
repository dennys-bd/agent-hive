import { join } from 'node:path';
import { taskWorkspace } from '../config.js';
import { prRepo } from '../pull-requests.js';
import { githubRepository } from '../task-refs.js';
import { forkRepos } from '../fork.js';
import type { ActivityRecord, Config, Exec, PrTarget, State, Workspace } from '../types.js';

/** A repository the flow sidebar lists (#757), before GitHub is asked about it: owner/name and the workspace whose colour it takes; for a fork
 * workspace (#854) its role, the workspace's PR target and the other repository of the pair. */
export interface RepoRef { repository: string; workspace: string; role?: 'original' | 'fork' | 'nested'; pr?: PrTarget; pair?: string }

type MaybeRef = Omit<RepoRef, 'repository'> & { repository?: string };

// A workspace's own repositories (#854): a fork's original then its fork when both are on GitHub, else its origin
async function ownRefs(exec: Exec, workspace: Workspace): Promise<MaybeRef[]> {
  const repos = workspace.fork ? await forkRepos(exec, workspace) : undefined;
  if (repos === undefined || !workspace.fork) return [{ repository: await originRepository(exec, workspace.path), workspace: workspace.name }];
  const { pr } = workspace.fork;
  return [
    { repository: repos.original, workspace: workspace.name, role: 'original', pr, pair: repos.fork },
    { repository: repos.fork, workspace: workspace.name, role: 'fork', pr, pair: repos.original },
  ];
}

// A workspace's own repositories and then its nested repos on GitHub (#653), each paired with the workspace's repository (the original's for
// a fork, else the origin's); with none on GitHub, a nested one is a plain row. One off GitHub, or with no checkout, adds none
async function workspaceRefs(exec: Exec, workspace: Workspace): Promise<MaybeRef[]> {
  const own = await ownRefs(exec, workspace);
  const pair = own[0]?.repository;
  const nested = await Promise.all(workspace.nestedRepos.map((path) => originRepository(exec, join(workspace.path, path))));
  return [...own, ...nested.map((repository): MaybeRef => ({ repository, workspace: workspace.name, ...(pair === undefined ? {} : { role: 'nested' as const, pair }) }))];
}

// The GitHub repository of a workspace's origin (#588), for a terminal whose task has none of its own (one created in the Hive) and for a
// workspace shell. No checkout, a failing git or a remote off GitHub leave none: the click then resolves only the Hive's tasks
export async function originRepository(exec: Exec, path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  const remote = await exec('git', ['-C', path, 'remote', 'get-url', 'origin']).then(({ stdout }) => stdout.trim(), () => '');
  return githubRepository(remote);
}

// owner/name of a PR link as prRepo reads it; undefined for a link that is no GitHub PR's (prRepo answers those as they came)
const prRepository = (url: string): string | undefined => {
  const repository = prRepo(url);
  return repository === url ? undefined : repository;
};

// The workspace a record's PRs belong to (#757): its live activity's; a deleted activity's record has none, so its task's
function recordWorkspace(config: Pick<Config, 'comb'>, state: Pick<State, 'tasks' | 'activities'>, record: ActivityRecord): string | undefined {
  const live = state.activities.find((a) => a.id === record.id);
  if (live) return live.workspace;
  const task = state.tasks.find((t) => record.taskIds.includes(t.item.itemId));
  return task === undefined ? undefined : taskWorkspace(config, task)?.name;
}

/** The repositories the Hive knows (#757): each workspace's origin in the Comb's order, then the repository of every open PR in the
 * activity records with its activity's workspace; each owner/name once, with the first workspace that named it. A workspace whose origin is
 * not on GitHub adds none. A fork workspace adds its original and then its fork (#854). ponytail: owner/name compares as written, so an origin and a PR link that differ only in case list twice. */
export async function listRepositories(config: Pick<Config, 'comb'>, state: Pick<State, 'tasks' | 'activities' | 'activityRecords'>, exec: Exec): Promise<RepoRef[]> {
  const origins = (await Promise.all(config.comb.workspaces.map((w) => workspaceRefs(exec, w)))).flat();
  const prs = state.activityRecords.flatMap((record): MaybeRef[] => {
    const workspace = recordWorkspace(config, state, record);
    if (workspace === undefined) return [];
    return (record.prs ?? []).filter((pr) => pr.state === 'open').map((pr) => ({ repository: prRepository(pr.url), workspace }));
  });
  const seen = new Set<string>();
  return [...origins, ...prs].flatMap((ref) => {
    if (ref.repository === undefined || seen.has(ref.repository)) return [];
    seen.add(ref.repository);
    return [{ ...ref, repository: ref.repository }];
  });
}
