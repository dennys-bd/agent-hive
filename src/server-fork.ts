import type { Machine, MachineFor } from './machine.js';
import type { Express, Request, Response } from 'express';
import { workspaceByName } from './config.js';
import { machineQuery } from './config-machines.js';
import { forkRepos, remotesOf, syncFork, workspaceBase } from './fork.js';
import { machineRefusal } from './machines.js';
import { refuse as refuseWith } from './server-tasks.js';
import type { Config, ForkSyncAnswer, Workspace } from './types.js';
import { gitOrWords, workspacePathProblem } from './worktree.js';
import { remoteHead } from './worktree-base.js';

// A fork workspace's routes (#854): sincronizar agora, and the remotes Settings' repository section reads.

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const UNKNOWN_WORKSPACE_MESSAGE = 'workspace desconhecido';
const NOT_MANUAL_MESSAGE = 'a fork deste workspace não sincroniza à mão';
const PATH_MESSAGE = 'path precisa ser a pasta de um repositório git';
export const MACHINE_MESSAGE = 'machine must be "local" or "wsl:<distro>"'; // #932: a folder not saved yet names the machine it is on

export interface ForkRouteDeps {
  machineFor: MachineFor; // #158, #932: the workspace's machine, or the one the Settings form's draft names
  requireLive(res: Response): { runtime: { config: Pick<Config, 'comb' | 'baseBranch' | 'gitlabHosts'> } } | undefined;
}

const refuse = (res: Response, status: number, message: string): void => {
  res.status(status).json({ error: message });
};
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The GitHub sync of the workspace's effective base, run once and only answered: nothing is kept (#854). #1045: its remotes read against the
// config's GitLab hosts, so a fork on GitLab answers the save's words
async function manualSync(machine: Machine, workspace: Workspace, config: Pick<Config, 'baseBranch' | 'gitlabHosts'>): Promise<ForkSyncAnswer> {
  const { remote, branch } = workspaceBase(config, workspace);
  const base = branch ?? (await remoteHead((...args) => gitOrWords(workspace.path, args, machine.exec), remote));
  return syncFork(machine, await forkRepos(machine, workspace, config.gitlabHosts), base);
}

/** POST /workspaces/:name/sync and GET /settings/remotes (#854). */
export function registerForkRoutes(app: Express, deps: ForkRouteDeps): void {
  app.post('/workspaces/:name/sync', async (req: Request, res: Response) => {
    const live = deps.requireLive(res);
    if (!live) return;
    const workspace = workspaceByName(live.runtime.config, req.params.name as string);
    if (!workspace) return refuse(res, HTTP_NOT_FOUND, UNKNOWN_WORKSPACE_MESSAGE);
    if (!workspace.fork || workspace.fork.pr === 'original' || workspace.fork.sync !== 'manual') return refuse(res, HTTP_CONFLICT, NOT_MANUAL_MESSAGE);
    const machine = deps.machineFor(workspace); // #932: the clone is on the workspace's machine
    const unavailable = await machineRefusal(machine, workspace.path);
    if (unavailable) return refuseWith(res, unavailable);
    res.json(await manualSync(machine, workspace, live.runtime.config)); // syncFork never throws: gh's refusal is its error
  });
  // A folder POST /settings would take (#202): absolute and a work tree's top level on the machine the draft names (#932), before git reads its remotes
  app.get('/settings/remotes', async (req: Request, res: Response) => {
    const { path, machine: asked } = req.query;
    const id = machineQuery(asked);
    if (id === undefined) return refuse(res, HTTP_BAD_REQUEST, MACHINE_MESSAGE);
    if (typeof path !== 'string') return refuse(res, HTTP_BAD_REQUEST, PATH_MESSAGE);
    const machine = deps.machineFor({ machine: id });
    const unavailable = await machineRefusal(machine, path);
    if (unavailable) return refuseWith(res, unavailable);
    const problem = await workspacePathProblem(machine, path);
    if (problem) return refuse(res, HTTP_BAD_REQUEST, problem);
    try {
      res.json(await remotesOf(machine, path));
    } catch (err) {
      refuse(res, HTTP_SERVER_ERROR, errorMessage(err));
    }
  });
}
