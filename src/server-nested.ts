import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Express, Request, Response } from 'express';
import { workspaceBase } from './fork.js';
import { readNestedRepos } from './nested-check.js';
import type { Config, Exec } from './types.js';
import { gitOrWords, workspacePathProblem } from './worktree.js';
import { remoteHead } from './worktree-base.js';

// GET /settings/nested-repos (#653): what Settings › workspaces › nested repos shows, with the real git and read-only.

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
const PATH_MESSAGE = 'path precisa ser a pasta de um repositório git'; // as /settings/remotes says it
const execFileAsync: Exec = promisify(execFile);

export interface NestedRouteDeps { config(): Pick<Config, 'comb' | 'baseBranch'> | undefined } // undefined in setup mode: every folder is unsaved

// The base branch name the rows show: a saved workspace's effective base, else its base remote's HEAD; a folder not saved yet, origin's
// HEAD. Read-only: never set-head here
async function baseNameOf(path: string, config: Pick<Config, 'comb' | 'baseBranch'> | undefined): Promise<string> {
  const saved = config?.comb.workspaces.find((w) => w.path === path);
  const { remote, branch } = saved && config ? workspaceBase(config, saved) : { remote: 'origin', branch: undefined };
  return branch ?? remoteHead((...args) => gitOrWords(path, args, execFileAsync), remote, false);
}

/** GET /settings/nested-repos?path=<folder>&repos=<a,b> (#653): `path` must be a saved workspace's or pass workspacePathProblem, the same guard
 * as /settings/remotes; each listed path is checked by shape before any git runs in it. */
export function registerNestedRoute(app: Express, deps: NestedRouteDeps): void {
  app.get('/settings/nested-repos', async (req: Request, res: Response) => {
    const { path, repos } = req.query;
    if (typeof path !== 'string') return void res.status(HTTP_BAD_REQUEST).json({ error: PATH_MESSAGE });
    const config = deps.config();
    const saved = config?.comb.workspaces.some((w) => w.path === path) === true;
    const problem = saved ? undefined : await workspacePathProblem(path);
    if (problem) return void res.status(HTTP_BAD_REQUEST).json({ error: problem });
    const listed = typeof repos === 'string' && repos !== '' ? repos.split(',') : [];
    try {
      res.json(await readNestedRepos(path, await baseNameOf(path, config), listed));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
