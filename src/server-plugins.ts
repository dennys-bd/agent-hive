// The plugins view's items (#315): the catalogue's reads and the custom store's writes. A write answers what the screen shows next: the
// item, or the version it wrote. A refusal answers the store's own message; anything the disk throws is a 500 whose detail goes to
// hive.log only.
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { type CustomStore, MINE } from './custom-store.js';
import { isRefusal, type RefusalCode, type StoreRefusal } from './custom-versions.js';
import { HIVE_ORIGIN, type ItemSources, itemId } from './item-sources.js';
import { findItem, readCatalogue, readItem, type StageRef } from './items-catalogue.js';
import type { Logger } from './log.js';
import { ITEM_KINDS } from './types.js';

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
export const ITEMS_ERROR_MESSAGE = 'the plugins store could not be read or written; see hive.log';
const STATUS: Record<RefusalCode, number> = {
  bad_name: HTTP_BAD_REQUEST,
  bad_path: HTTP_BAD_REQUEST,
  unknown_item: HTTP_NOT_FOUND,
  unknown_version: HTTP_NOT_FOUND,
  unknown_workspace: HTTP_NOT_FOUND,
  exists: HTTP_CONFLICT,
  name_taken: HTTP_CONFLICT,
  original_locked: HTTP_CONFLICT,
  in_use: HTTP_CONFLICT,
};

const NEW_ITEM = z.object({ kind: z.enum(ITEM_KINDS), name: z.string() });
const SAVE_FILE = z.object({ version: z.string().nullable(), path: z.string(), text: z.string(), from: z.string().optional() });
const DELETE_FILE = z.object({ version: z.string(), path: z.string() });
const NEW_VERSION = z.object({ name: z.string(), from: z.string() });
const RENAME = z.object({ name: z.string() });
const ASSIGN = z.object({ workspace: z.string(), version: z.string().nullable() });

export interface PluginRouteDeps {
  requireLive(res: Response): { runtime: { config: { comb: { workspaces: ItemSources['workspaces']; stages: readonly StageRef[] } } } } | undefined;
  store: CustomStore;
  home: string;
  pluginSource: string;
  log: Pick<Logger, 'error'>;
}
type Handle = (req: Request, res: Response, sources: ItemSources, stages: readonly StageRef[]) => Promise<void>;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const refuse = (res: Response, refused: StoreRefusal): void => void res.status(STATUS[refused.code]).json({ error: refused.message });
const idOf = (req: Request): string => String(req.params.id);

// A body the schema refuses is a 400 naming its first field; names and paths are the store's to check
function bodyOf<T>(schema: z.ZodType<T>, req: Request, res: Response): T | undefined {
  const parsed = schema.safeParse(req.body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  res.status(HTTP_BAD_REQUEST).json({ error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` });
  return undefined;
}

function route(deps: PluginRouteDeps, handle: Handle) {
  return async (req: Request, res: Response): Promise<void> => {
    const current = deps.requireLive(res);
    if (!current) return;
    try {
      const { comb } = current.runtime.config;
      await handle(req, res, { home: deps.home, pluginSource: deps.pluginSource, workspaces: comb.workspaces }, comb.stages);
    } catch (err) {
      deps.log.error(`plugins: ${req.method} ${req.path} failed: ${errorMessage(err)}`);
      res.status(HTTP_SERVER_ERROR).json({ error: ITEMS_ERROR_MESSAGE });
    }
  };
}

async function answerRead(res: Response, sources: ItemSources, id: string, version: string | null): Promise<void> {
  const read = await readItem(sources, id, version);
  if (isRefusal(read)) return refuse(res, read);
  res.json(read);
}

// The item after a write; 204 once a revert took a user-created item's last version, and the item with it
async function answerItem(res: Response, sources: ItemSources, id: string): Promise<void> {
  const item = await findItem(sources, id);
  if (item === undefined) return void res.status(HTTP_NO_CONTENT).end();
  res.json(item);
}

function registerItemRoutes(app: Express, deps: PluginRouteDeps): void {
  app.get('/api/items', route(deps, async (_req, res, s, stages) => {
    res.json(await readCatalogue(s, stages));
  }));
  app.get('/api/items/:id', route(deps, async (req, res, s) => {
    const { version } = req.query;
    await answerRead(res, s, idOf(req), typeof version === 'string' && version !== '' ? version : null);
  }));
  app.post('/api/items', route(deps, async (req, res, s) => {
    const body = bodyOf(NEW_ITEM, req, res);
    if (!body) return;
    const done = await deps.store.createItem(body.kind, body.name);
    if (isRefusal(done)) return refuse(res, done);
    res.status(HTTP_CREATED).json(await findItem(s, itemId({ origin: HIVE_ORIGIN, name: body.name })));
  }));
}

function registerFileRoutes(app: Express, deps: PluginRouteDeps): void {
  app.put('/api/items/:id/files', route(deps, async (req, res, s) => {
    const body = bodyOf(SAVE_FILE, req, res);
    if (!body) return;
    const done = await deps.store.saveFile(idOf(req), body.version, body.path, body.text, body.from);
    if (isRefusal(done)) return refuse(res, done);
    await answerRead(res, s, idOf(req), body.version ?? MINE); // saving the original made `mine`
  }));
  app.delete('/api/items/:id/files', route(deps, async (req, res, s) => {
    const body = bodyOf(DELETE_FILE, req, res);
    if (!body) return;
    const done = await deps.store.deleteFile(idOf(req), body.version, body.path);
    if (isRefusal(done)) return refuse(res, done);
    await answerRead(res, s, idOf(req), body.version);
  }));
}

function registerVersionRoutes(app: Express, deps: PluginRouteDeps): void {
  app.post('/api/items/:id/versions', route(deps, async (req, res, s) => {
    const body = bodyOf(NEW_VERSION, req, res);
    if (!body) return;
    const done = await deps.store.createVersion(idOf(req), body.name, body.from);
    if (isRefusal(done)) return refuse(res, done);
    await answerRead(res, s, idOf(req), body.name);
  }));
  app.patch('/api/items/:id/versions/:version', route(deps, async (req, res, s) => {
    const body = bodyOf(RENAME, req, res);
    if (!body) return;
    const done = await deps.store.renameVersion(idOf(req), String(req.params.version), body.name);
    if (isRefusal(done)) return refuse(res, done);
    await answerItem(res, s, idOf(req));
  }));
  app.post('/api/items/:id/assign', route(deps, async (req, res, s) => {
    const body = bodyOf(ASSIGN, req, res);
    if (!body) return;
    const done = await deps.store.assign(idOf(req), body.workspace, body.version);
    if (isRefusal(done)) return refuse(res, done);
    await answerItem(res, s, idOf(req));
  }));
  app.delete('/api/items/:id/versions/:version', route(deps, async (req, res, s) => {
    const done = await deps.store.revert(idOf(req), String(req.params.version));
    if (isRefusal(done)) return refuse(res, done);
    await answerItem(res, s, idOf(req));
  }));
}

/** GET/POST /api/items and the custom store's writes (#315), behind the server's host, secret and x-hive-ui gates. */
export function registerPluginRoutes(app: Express, deps: PluginRouteDeps): void {
  registerItemRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerVersionRoutes(app, deps);
}
