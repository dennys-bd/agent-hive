// hive_conventions' pure answer (#294): kept out of mcp.ts, which was at 400 lines and needed room for hive_stop's block
import { activityOfWorker, taskOfWorker } from './activities.js';
import { taskWorkspace, workspaceByName } from './config.js';
import { forkRepos, workspaceBase } from './fork.js';
import { systemLanguage } from './language.js';
import { stageOf } from './tasks.js';
import { gitOrWords } from './worktree.js';
import { remoteHead } from './worktree-base.js';
import type { Config, Exec, Language, PrTarget, State, Worker, Workspace } from './types.js';

/** Where a fork workspace's PRs go (#854): the target, the two repositories (owner/name), the remote the work starts from and the effective base. */
export interface ForkConventions { pr: PrTarget; original: string; fork: string; baseRemote: string; base: string }

/** What hive_conventions answers (#692, #318): the Hive's language, the worker's stage with its approval, and a fork workspace's PR target
 * (#854). The conventions themselves are each skill's variables since #317, so the Hive answers none. */
export interface ConventionsAnswer { hiveLanguage: Language; approval: boolean; stage?: string; fork?: ForkConventions }

/** The workspace a worker runs in (#692): its task's, or a local activity's own */
export function workerWorkspace(state: Pick<State, 'tasks' | 'activities' | 'activityRecords'>, config: Pick<Config, 'comb'>, worker: Worker): Workspace | undefined {
  const task = taskOfWorker(state, worker);
  return task ? taskWorkspace(config, task) : workspaceByName(config, activityOfWorker(state, worker)?.workspace);
}

/** hive_conventions' answer for `worker` (#692): the stage and its approval only for a stage run, since a free or a local session runs no
 * stage. `fork` only when given (#854). */
export function conventionsAnswer(state: Pick<State, 'tasks' | 'stages' | 'activities' | 'activityRecords'>, config: Pick<Config, 'language'>, worker: Worker, fork?: ForkConventions): ConventionsAnswer {
  const task = taskOfWorker(state, worker);
  const stage = task && !worker.freeSession ? stageOf(state.stages, task.stage) : undefined;
  return {
    hiveLanguage: config.language ?? systemLanguage(), approval: stage?.approval === true,
    ...(stage ? { stage: stage.name } : {}), ...(fork ? { fork } : {}),
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
