import type { Express, Request, Response } from 'express';
import { workspaceByName } from './config.js';
import { forkRepos, remotesOf, syncFork, workspaceBase } from './fork.js';
import type { Config, Exec, ForkSyncAnswer, Workspace } from './types.js';
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

export interface ForkRouteDeps {
  requireLive(res: Response): { runtime: { config: Pick<Config, 'comb' | 'baseBranch'> } } | undefined;
  exec: Exec; // git for the remotes and the base, gh for the sync
}

const refuse = (res: Response, status: number, message: string): void => {
  res.status(status).json({ error: message });
};
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The GitHub sync of the workspace's effective base, run once and only answered: nothing is kept (#854)
async function manualSync(exec: Exec, workspace: Workspace, config: Pick<Config, 'baseBranch'>): Promise<ForkSyncAnswer> {
  const { remote, branch } = workspaceBase(config, workspace);
  const base = branch ?? (await remoteHead((...args) => gitOrWords(workspace.path, args, exec), remote));
  return syncFork(exec, await forkRepos(exec, workspace), base);
}

/** POST /workspaces/:name/sync and GET /settings/remotes (#854). */
export function registerForkRoutes(app: Express, deps: ForkRouteDeps): void {
  app.post('/workspaces/:name/sync', async (req: Request, res: Response) => {
    const live = deps.requireLive(res);
    if (!live) return;
    const workspace = workspaceByName(live.runtime.config, req.params.name as string);
    if (!workspace) return refuse(res, HTTP_NOT_FOUND, UNKNOWN_WORKSPACE_MESSAGE);
    if (!workspace.fork || workspace.fork.pr === 'original' || workspace.fork.sync !== 'manual') return refuse(res, HTTP_CONFLICT, NOT_MANUAL_MESSAGE);
    res.json(await manualSync(deps.exec, workspace, live.runtime.config)); // syncFork never throws: gh's refusal is its error
  });
  // A folder POST /settings would take (#202): absolute and a work tree's top level, before git reads its remotes
  app.get('/settings/remotes', async (req: Request, res: Response) => {
    const { path } = req.query;
    if (typeof path !== 'string') return refuse(res, HTTP_BAD_REQUEST, PATH_MESSAGE);
    const problem = await workspacePathProblem(path);
    if (problem) return refuse(res, HTTP_BAD_REQUEST, problem);
    try {
      res.json(await remotesOf(deps.exec, path));
    } catch (err) {
      refuse(res, HTTP_SERVER_ERROR, errorMessage(err));
    }
  });
}
