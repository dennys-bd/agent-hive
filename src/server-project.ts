import type { Express, Request, Response } from 'express';
import { checkValue, ItemNotOnSourceError, PartialWriteError, STATUS } from './field-values.js';
import type { Logger } from './log.js';
import { inBackoff } from './polling.js';
import { entryStage, itemSource } from './tasks.js';
import type { FieldWrite, HiveEvent, ProjectView, Source, Stage, State } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_BAD_GATEWAY = 502; // the source failed a read or a write the UI asked for
const NO_VIEW_MESSAGE = 'source has no native view';
const NO_FIELDS_MESSAGE = 'source has no editable fields';
const QUOTA_MESSAGE = 'GitHub quota is low';
const ITEM_MESSAGE = 'itemId must be an item of this source';
const STATUS_MESSAGE = "status must be one of the source's Status options";
const FIELD_MESSAGE = "field must be one of the item's fields";

type ProjectSource = Partial<Pick<Source, 'project' | 'fieldsOf' | 'setField' | 'settingsOptions'>>;
type FieldSource = Required<Pick<Source, 'fieldsOf' | 'setField'>>;

/** What the native view's routes need (#756, #686): the live state and sources, and the dispatch a write's re-read item goes through. */
export interface ProjectRouteDeps {
  requireLive(res: Response): { state: State; runtime: { sources: ReadonlyMap<string, ProjectSource> } } | undefined;
  dispatch(event: HiveEvent): Promise<unknown>; // #686: itemRead, the re-read item applied to its task alone, no poll
  log?: Logger;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Each Status option with the stage a task in it enters (#756): the poll's own door, entryStage; an option no stage's from cites has none
function withStages(view: ProjectView, stages: Stage[], source: string): ProjectView {
  return {
    ...view,
    statuses: view.statuses.map((s) => {
      const stage = entryStage(stages, source, s.name)?.name;
      return stage === undefined ? s : { ...s, stage };
    }),
  };
}

// Refused inside the source's quota backoff, as its poll would be (no reading yet: it reads); true when the 429 went out
function refusedInBackoff(state: State, name: string, res: Response): boolean {
  const sync = Object.hasOwn(state.syncs, name) ? state.syncs[name] : undefined;
  if (!inBackoff(sync, Date.now())) return false;
  res.status(HTTP_TOO_MANY_REQUESTS).json({ error: QUOTA_MESSAGE, resetsAt: sync?.quota?.resetsAt });
  return true;
}

// #686: the re-read item to its task, as the poll would apply it; the answer the editors replace their row and fields with. The write is
// done by now: a dispatch that rejects is logged (its message only) and the answer still goes out, so the UI shows what the source has.
async function applied(deps: ProjectRouteDeps, source: string, itemId: string, written: FieldWrite): Promise<Pick<FieldWrite, 'fields' | 'row'>> {
  try {
    await deps.dispatch({ type: 'itemRead', source, itemId, ...(written.entry ? { entry: written.entry } : {}) });
  } catch (err) {
    deps.log?.error(`itemRead for ${itemId} failed: ${errorMessage(err)}`);
  }
  return { fields: written.fields, row: written.row };
}

// A failed read or write (#686): an item the source does not have is a 404; a write that failed midway answers the re-read item beside the
// error, applied like a good write, so the UI resyncs; any other failure of the source is a 502 with its words
async function failed(deps: ProjectRouteDeps, res: Response, source: string, itemId: string, err: unknown): Promise<void> {
  if (err instanceof ItemNotOnSourceError) return void res.status(HTTP_NOT_FOUND).json({ error: err.message });
  if (err instanceof PartialWriteError) return void res.status(HTTP_BAD_GATEWAY).json({ error: err.message, ...(await applied(deps, source, itemId, err.written)) });
  res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
}

/** GET /sources/:name/project (#756): the source's native view, read on demand: never by the poll, never stored. Refused inside the source's
 * quota backoff; a failed read is a 502 with the source's words. */
function registerViewRoute(app: Express, { requireLive }: ProjectRouteDeps): void {
  app.get('/sources/:name/project', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const name = req.params.name as string;
    const source = current.runtime.sources.get(name);
    if (!source?.project) return void res.status(HTTP_NOT_FOUND).json({ error: NO_VIEW_MESSAGE });
    if (refusedInBackoff(current.state, name, res)) return;
    try {
      res.json(withStages(await source.project(), current.state.stages, name));
    } catch (err) {
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
    }
  });
}

/** POST /sources/:name/project/status (#756): the Status select's write, any option, cited or not. The option is checked against the
 * source's own list (settingsOptions), so an unknown one is a 400 rather than the adapter's throw; a refusal by the source is a 502. It writes
 * through setField and dispatches the re-read item (#686): a stopped task follows a new column at once (seenAgain), with no poll. */
function registerStatusRoute(app: Express, deps: ProjectRouteDeps): void {
  app.post('/sources/:name/project/status', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const name = req.params.name as string;
    const source = current.runtime.sources.get(name);
    if (!source?.setField || !source.settingsOptions) return void res.status(HTTP_NOT_FOUND).json({ error: NO_VIEW_MESSAGE });
    const { itemId, status } = (req.body ?? {}) as { itemId?: unknown; status?: unknown };
    if (typeof itemId !== 'string' || itemSource(itemId) !== name) return void res.status(HTTP_BAD_REQUEST).json({ error: ITEM_MESSAGE });
    let written: FieldWrite;
    try {
      const options = await source.settingsOptions();
      if (typeof status !== 'string' || !options.includes(status)) return void res.status(HTTP_BAD_REQUEST).json({ error: STATUS_MESSAGE });
      written = await source.setField(itemId, STATUS, status);
    } catch (err) {
      await failed(deps, res, name, itemId, err);
      return;
    }
    res.json(await applied(deps, name, itemId, written));
  });
}

// What both field routes check first (#686): a live Hive, a source with fieldsOf and setField, an item of that source, no quota backoff.
// undefined: the refusal already went out
function fieldTarget(req: Request, res: Response, { requireLive }: ProjectRouteDeps): { name: string; itemId: string; source: FieldSource } | undefined {
  const current = requireLive(res);
  if (!current) return undefined;
  const name = req.params.name as string;
  const itemId = req.params.itemId as string;
  const source = current.runtime.sources.get(name);
  const fieldsOf = source?.fieldsOf;
  const setField = source?.setField;
  if (!fieldsOf || !setField) return void res.status(HTTP_NOT_FOUND).json({ error: NO_FIELDS_MESSAGE });
  if (itemSource(itemId) !== name) return void res.status(HTTP_BAD_REQUEST).json({ error: ITEM_MESSAGE });
  if (refusedInBackoff(current.state, name, res)) return undefined;
  return { name, itemId, source: { fieldsOf, setField } };
}

/** GET and POST /sources/:name/items/:itemId/fields (#686): an item's fields for its editors, and one field's write. The value is checked
 * against the field's kind and options (400); the source's refusal is a 502 with its words. A written item is re-read by the adapter and
 * dispatched as itemRead: the task shows the source's value with no poll. */
function registerFieldRoutes(app: Express, deps: ProjectRouteDeps): void {
  app.get('/sources/:name/items/:itemId/fields', async (req: Request, res: Response) => {
    const target = fieldTarget(req, res, deps);
    if (!target) return;
    try {
      res.json({ fields: await target.source.fieldsOf(target.itemId) });
    } catch (err) {
      await failed(deps, res, target.name, target.itemId, err);
    }
  });
  app.post('/sources/:name/items/:itemId/fields', async (req: Request, res: Response) => {
    const target = fieldTarget(req, res, deps);
    if (!target) return;
    const { field, value } = (req.body ?? {}) as { field?: unknown; value?: unknown };
    let written: FieldWrite;
    try {
      // ponytail: this read, the adapter's read for the ids and its re-read are three reads per write; one cached read when quota matters
      const found = (await target.source.fieldsOf(target.itemId)).find((f) => f.name === field);
      if (!found) return void res.status(HTTP_BAD_REQUEST).json({ error: FIELD_MESSAGE });
      const checked = checkValue(found, value);
      if ('error' in checked) return void res.status(HTTP_BAD_REQUEST).json({ error: checked.error });
      written = await target.source.setField(target.itemId, found.name, checked.value);
    } catch (err) {
      await failed(deps, res, target.name, target.itemId, err);
      return;
    }
    res.json(await applied(deps, target.name, target.itemId, written));
  });
}

/** The native view's routes (#756): its read and its Status write; an item's fields and their writes (#686). */
export function registerProjectRoutes(app: Express, deps: ProjectRouteDeps): void {
  registerViewRoute(app, deps);
  registerStatusRoute(app, deps);
  registerFieldRoutes(app, deps);
}
