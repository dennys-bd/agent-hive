// The plugins view's workspace values (#621, decision 11): PUT sets one of a workspace's variables, DELETE removes it. Each runs on the POST
// /settings chain, writes hive.config.json through the server's own writer and re-renders that workspace's plugin folder and protocol files only. The value is
// not checked against the templates that read it: the lint shows where one cannot take it (decision 6).
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { Logger } from './log.js';
import type { MemoryStore } from './memory.js';
import type { PluginRender } from './plugin-render.js';
import { writeMemoryProtocols } from './server-memory.js';
import { bodyOf } from './server-plugins.js';
import { BUILT_INS, isVariableName } from './template.js';
import type { Config, VariableValue, Workspace } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
export const WORKSPACE_MESSAGE = 'workspace: no such workspace';
export const NAME_MESSAGE = `name: a variable name is a letter or _ followed by letters, digits or _, and never a built-in: ${BUILT_INS.join(', ')}`;
export const SAVE_MESSAGE = 'hive.config.json could not be written; see hive.log';
const VALUE = z.object({ value: z.union([z.string(), z.boolean(), z.null()]) });

export interface VariableRouteDeps {
  requireLive(res: Response): { runtime: { config: Config } } | undefined;
  /** Runs `save` on the POST /settings chain, after every save already queued: one writer of hive.config.json at a time. */
  queueSave(save: () => Promise<void>): Promise<void>;
  saveConfig(config: Config): Promise<void>; // writes hive.config.json as POST /settings does, and makes it the live config
  plugin: Pick<PluginRender, 'write'>;
  memory: Pick<MemoryStore, 'writeProtocol'>; // the protocol passages render with the workspace's values (protocolRenderer's valuesOf)
  log: Pick<Logger, 'error'>;
}

// The class only: an fs error's message holds the home's path
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

// A new map with `name` set, or without it when value is undefined. fromEntries, never an assignment by key: a name like __proto__ stays an
// own entry
function withValue(variables: Workspace['variables'], name: string, value: VariableValue | undefined): Workspace['variables'] {
  const rest = Object.entries(variables).filter(([key]) => key !== name);
  return Object.fromEntries(value === undefined ? rest : [...rest, [name, value]]);
}

// The workspace is read on the chain, not at arrival: a Settings save queued first may have renamed or removed it
async function write(deps: VariableRouteDeps, req: Request, res: Response, value: VariableValue | undefined): Promise<void> {
  const name = String(req.params.name);
  if (!isVariableName(name)) return void res.status(HTTP_BAD_REQUEST).json({ error: NAME_MESSAGE });
  await deps.queueSave(async () => {
    const live = deps.requireLive(res);
    if (!live) return;
    const { config } = live.runtime;
    const workspace = String(req.params.workspace);
    const target = config.comb.workspaces.find((w) => w.name === workspace);
    if (target === undefined) return void res.status(HTTP_BAD_REQUEST).json({ error: WORKSPACE_MESSAGE });
    const variables = withValue(target.variables, name, value);
    const saved: Workspace = { ...target, variables };
    const next: Config = { ...config, comb: { ...config.comb, workspaces: config.comb.workspaces.map((w) => (w === target ? saved : w)) } };
    try {
      await deps.saveConfig(next);
    } catch (err) {
      deps.log.error(`variables ${workspace}: hive.config.json not written (${errorName(err)})`);
      return void res.status(HTTP_SERVER_ERROR).json({ error: SAVE_MESSAGE });
    }
    await deps.plugin.write(next, [workspace]); // never rejects: a failed render is the render's to log
    await writeMemoryProtocols(deps.memory, { ...next, comb: { ...next.comb, workspaces: [saved] } }, deps.log); // nor this one: it logs
    res.json({ variables });
  });
}

/** PUT and DELETE /workspaces/:workspace/variables/:name (#621), behind the server's host, secret and x-hive-ui gates. */
export function registerVariableRoutes(app: Express, deps: VariableRouteDeps): void {
  app.put('/workspaces/:workspace/variables/:name', async (req: Request, res: Response) => {
    if (!deps.requireLive(res)) return;
    const body = bodyOf(VALUE, req, res);
    if (body) await write(deps, req, res, body.value);
  });
  app.delete('/workspaces/:workspace/variables/:name', async (req: Request, res: Response) => {
    if (deps.requireLive(res)) await write(deps, req, res, undefined);
  });
}
