import type { Express, Request, Response } from 'express';
import { machineQuery } from './config-machines.js';
import { workspaceBase } from './fork.js';
import type { Machine, MachineFor } from './machine.js';
import { machineRefusal } from './machines.js';
import { readNestedRepos } from './nested-check.js';
import { MACHINE_MESSAGE } from './server-fork.js';
import { refuse } from './server-tasks.js';
import type { Config, MachineId } from './types.js';
import { gitOrWords, workspacePathProblem } from './worktree.js';
import { remoteHead } from './worktree-base.js';

// GET /settings/nested-repos (#653): what Settings › workspaces › nested repos shows, read-only, on the machine the draft names (#932).

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
const PATH_MESSAGE = 'path precisa ser a pasta de um repositório git'; // as /settings/remotes says it

// undefined in setup mode: every folder is unsaved; machineFor: the folder's machine (#932)
export interface NestedRouteDeps { config(): Pick<Config, 'comb' | 'baseBranch'> | undefined; machineFor: MachineFor }

type Saved = Pick<Config, 'comb' | 'baseBranch'> | undefined;
const savedAt = (config: Saved, path: string, machine: MachineId) => config?.comb.workspaces.find((w) => w.path === path && w.machine === machine);

// The base branch name the rows show: a saved workspace's effective base, else its base remote's HEAD; a folder not saved yet, origin's
// HEAD. Read-only: never set-head here
async function baseNameOf(machine: Pick<Machine, 'exec'>, path: string, config: Saved, id: MachineId): Promise<string> {
  const saved = savedAt(config, path, id);
  const { remote, branch } = saved && config ? workspaceBase(config, saved) : { remote: 'origin', branch: undefined };
  return branch ?? remoteHead((...args) => gitOrWords(path, args, machine.exec), remote, false);
}

/** GET /settings/nested-repos?path=<folder>&repos=<a,b>&machine=<id> (#653, #932): `path` must be a saved workspace's (by path and machine) or
 * pass workspacePathProblem on that machine, the same guard as /settings/remotes; each listed path is checked by shape before any git runs in it. */
export function registerNestedRoute(app: Express, deps: NestedRouteDeps): void {
  app.get('/settings/nested-repos', async (req: Request, res: Response) => {
    const { path, repos, machine: asked } = req.query;
    const id = machineQuery(asked);
    if (id === undefined) return void res.status(HTTP_BAD_REQUEST).json({ error: MACHINE_MESSAGE });
    if (typeof path !== 'string') return void res.status(HTTP_BAD_REQUEST).json({ error: PATH_MESSAGE });
    const config = deps.config();
    const machine = deps.machineFor({ machine: id });
    const unavailable = await machineRefusal(machine, path);
    if (unavailable) return refuse(res, unavailable);
    const problem = savedAt(config, path, id) !== undefined ? undefined : await workspacePathProblem(machine, path);
    if (problem) return void res.status(HTTP_BAD_REQUEST).json({ error: problem });
    const listed = typeof repos === 'string' && repos !== '' ? repos.split(',') : [];
    try {
      res.json(await readNestedRepos(path, await baseNameOf(machine, path, config, id), listed, machine.paths, machine.exec));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
