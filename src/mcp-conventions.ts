// hive_conventions' pure answer (#294): kept out of mcp.ts, which was at 400 lines and needed room for hive_stop's block
import { join } from 'node:path';
import { activityOfWorker, taskOfWorker } from './activities.js';
import { taskWorkspace, workspaceByName } from './config.js';
import { forkRepos, workspaceBase } from './fork.js';
import { systemLanguage } from './language.js';
import { originRepository } from './repos/repositories.js';
import { stageOf } from './tasks.js';
import { gitOrWords } from './worktree.js';
import { remoteHead } from './worktree-base.js';
import type { Config, Exec, Language, PrTarget, State, Worker, Workspace } from './types.js';

/** Where a fork workspace's PRs go (#854): the target, the two repositories (owner/name), the remote the work starts from and the effective base. */
export interface ForkConventions { pr: PrTarget; original: string; fork: string; baseRemote: string; base: string }

/** A nested repo as the skills read it (#653): its path relative to the worktree and the owner/name of its GitHub origin, when it has one */
export interface NestedConventions { path: string; repository?: string }

/** What hive_conventions answers (#692, #318): the Hive's language, the worker's stage with its approval, a fork workspace's PR target
 * (#854) and the workspace's nested repos (#653). The conventions themselves are each skill's variables since #317, so the Hive answers none. */
export interface ConventionsAnswer { hiveLanguage: Language; approval: boolean; stage?: string; fork?: ForkConventions; nestedRepos: NestedConventions[] }

/** The workspace a worker runs in (#692): its task's, or a local activity's own */
export function workerWorkspace(state: Pick<State, 'tasks' | 'activities' | 'activityRecords'>, config: Pick<Config, 'comb'>, worker: Worker): Workspace | undefined {
  const task = taskOfWorker(state, worker);
  return task ? taskWorkspace(config, task) : workspaceByName(config, activityOfWorker(state, worker)?.workspace);
}

/** hive_conventions' answer for `worker` (#692): the stage and its approval only for a stage run, since a free or a local session runs no
 * stage. `fork` only when given (#854). */
export function conventionsAnswer(state: Pick<State, 'tasks' | 'stages' | 'activities' | 'activityRecords'>, config: Pick<Config, 'language'>, worker: Worker, fork?: ForkConventions, nestedRepos: NestedConventions[] = []): ConventionsAnswer {
  const task = taskOfWorker(state, worker);
  const stage = task && !worker.freeSession ? stageOf(state.stages, task.stage) : undefined;
  return {
    hiveLanguage: config.language ?? systemLanguage(), approval: stage?.approval === true,
    ...(stage ? { stage: stage.name } : {}), ...(fork ? { fork } : {}), nestedRepos,
  };
}

/** A fork workspace's PR target as the skills read it (#854): none for a workspace that is not a fork or whose remotes are off GitHub. The base
 * is the workspace's own, else config.baseBranch, else the base remote's HEAD, else main. */
export async function forkConventions(exec: Exec, workspace: Workspace | undefined, config: Pick<Config, 'baseBranch'>): Promise<ForkConventions | undefined> {
  if (!workspace?.fork) return undefined;
  const repos = await forkRepos(exec, workspace);
  if (!repos) return undefined;
  const { remote, branch } = workspaceBase(config, workspace);
  const base = branch ?? (await remoteHead((...args) => gitOrWords(workspace.path, args, exec), remote));
  return { pr: workspace.fork.pr, original: repos.original, fork: repos.fork, baseRemote: remote, base };
}

/** The nested repos of a worker's workspace as the skills read them (#653): each path, relative to the worktree, with the owner/name of its
 * GitHub origin; absent when its origin is off GitHub or it has none. None for a worker with no workspace. */
export async function nestedConventions(exec: Exec, workspace: Workspace | undefined): Promise<NestedConventions[]> {
  if (!workspace) return [];
  return Promise.all(workspace.nestedRepos.map(async (path) => {
    const repository = await originRepository(exec, join(workspace.path, path));
    return repository === undefined ? { path } : { path, repository };
  }));
}
