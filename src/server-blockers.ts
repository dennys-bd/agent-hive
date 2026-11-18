import type { Express, Request, Response } from 'express';
import { ItemNotOnSourceError } from './field-values.js';
import { blockerProblem, hiveCandidates } from './hive-blockers.js';
import type { Logger } from './log.js';
import { backoffAnswer, refusedInBackoff } from './server-project.js';
import { BadBlockerRefError, BadRelationTypeError, BlockerRefNotFoundError, RelationRereadError, SelfBlockerError } from './blocker-errors.js';
import { answeredRateLimit, rateLimitAnswer, type ReportRetry } from './source-errors.js';
import { HIVE_SOURCE, itemSource } from './tasks.js';
import type { BlockerChange, BlockerRef, BlockerWrite, HiveEvent, ItemBlockers, Relation, RelationChange, RelationWrite, Source, SourceConfig, SourceItem, State } from './types.js';

/** The route's refusal codes (#56): stable keys the details panel maps to its copy (#57); `error` beside them is an English sentence. */
export const BLOCKER_CODES = {
  unknownItem: 'blockers.unknownItem', unknownRef: 'blockers.unknownRef', crossSource: 'blockers.crossSource', self: 'blockers.self',
  cycle: 'blockers.cycle', refused: 'blockers.refused', badRequest: 'blockers.badRequest',
} as const;
type Refusal = keyof typeof BLOCKER_CODES;

const NO_SOURCE = 'no such source';
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const SEARCH_MAX = 200; // #57: the add row's text, as long as the longest ref may be; a longer one is no search
const TYPE_MAX = 200; // a link type's name as a site names it; anything longer names none
const REF_MAX = 200; // an owner (39), a repository (100), `/`, `#` and a number fit; anything longer names nothing

const REFUSALS: Record<Refusal, { status: number; error: string }> = {
  unknownItem: { status: HTTP_NOT_FOUND, error: 'no such item on this source' },
  unknownRef: { status: HTTP_NOT_FOUND, error: 'no such item or task to relate' },
  crossSource: { status: HTTP_BAD_REQUEST, error: 'a relation joins two items of the same source' },
  self: { status: HTTP_BAD_REQUEST, error: 'an item cannot block itself' },
  cycle: { status: HTTP_CONFLICT, error: 'the other item is already blocked by this one' },
  refused: { status: HTTP_BAD_GATEWAY, error: 'the source refused the relation' },
  badRequest: { status: HTTP_BAD_REQUEST, error: 'the body must be { action: add | remove, kind: blockedBy | blocking, ref }' },
};
const BAD_RELATION = 'the body must be { action: add | remove, type, direction: inward | outward, ref }';
const NO_BLOCKERS: ItemBlockers = { blockedBy: [], blocking: [] };
// The adapter's refusals that are the request's own, each to its code; anything else is the source's (502)
const KNOWN: [new (...args: never[]) => Error, Refusal][] = [
  [BlockerRefNotFoundError, 'unknownRef'], [SelfBlockerError, 'self'], [ItemNotOnSourceError, 'unknownItem'],
];

type RelateSource = Partial<Pick<Source, 'relate' | 'findBlockers' | 'linkTypes' | 'setRelation'>>;

/** What the blocker route needs (#56): the live state and sources, the dispatch, the state after it, and the log a source's words go to. */
export interface BlockerRouteDeps {
  requireLive(res: Response): { state: State; runtime: { sources: ReadonlyMap<string, RelateSource> } } | undefined;
  dispatch(event: HiveEvent): Promise<unknown>; // blockerSet for a hive task; itemRead with a source write's re-read entry
  latest(): State | undefined;
  reportRetry: ReportRetry; // #812: a relation the source rate limited puts the source in backoff and answers 429
  log?: Logger;
  blockingLinkTypes(source: string): readonly string[]; // #829: the source's blocking types, which link-types?relations=1 leaves out
}
type Live = NonNullable<ReturnType<BlockerRouteDeps['requireLive']>>;
type RelateDeps = Pick<BlockerRouteDeps, 'dispatch' | 'latest' | 'log' | 'reportRetry'>;

/** A refusal as the route answers it (#294): status and body, so the route and hive_stop's block read the same words. */
export interface RelateRefusal { status: number; error: string; code?: string; resetsAt?: string }
/** One relation's outcome (#294): the item's blockers, or the refusal. */
export type RelateOutcome = { blockers: ItemBlockers } | { refusal: RelateRefusal };

/** #829: a source's blocking link types from comb.sources; a type with none (GitHub) or an unknown name has none. */
export function blockingTypesOf(sources: readonly SourceConfig[], name: string): readonly string[] {
  const entry = sources.find((s) => s.name === name);
  return entry?.type === 'jira' ? entry.blockingLinkTypes : [];
}

/** One relation's outcome (#829): the item's relations, or the refusal. */
type RelationOutcome = { relations: Relation[] } | { refusal: RelateRefusal };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function refuse(res: Response, refusal: Refusal): void {
  const { status, error } = REFUSALS[refusal];
  res.status(status).json({ error, code: BLOCKER_CODES[refusal] });
}

const refusalOf = (r: Refusal): { refusal: RelateRefusal } => ({ refusal: { status: REFUSALS[r].status, error: REFUSALS[r].error, code: BLOCKER_CODES[r] } });

// The outcome as the routes answer it: the refusal's status and body, else 200 with the outcome
function answer(res: Response, outcome: RelateOutcome | RelationOutcome): void {
  if (!('refusal' in outcome)) return void res.json(outcome);
  const { status, ...body } = outcome.refusal;
  res.status(status).json(body);
}

// The body as a BlockerChange, its ref trimmed; any other shape is undefined
function changeOf(body: unknown): BlockerChange | undefined {
  const { action, kind, ref } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if ((action !== 'add' && action !== 'remove') || (kind !== 'blockedBy' && kind !== 'blocking') || typeof ref !== 'string') return undefined;
  const trimmed = ref.trim();
  return trimmed === '' || trimmed.length > REF_MAX ? undefined : { action, kind, ref: trimmed };
}

// A hive task's relation (#56): checked with the reducer's own rule, so the answer names the problem; then blockerSet writes both tasks
async function relateHive(deps: RelateDeps, state: State, itemId: string, change: BlockerChange): Promise<RelateOutcome> {
  const problem = blockerProblem(state.tasks, itemId, change);
  if (problem !== undefined) return refusalOf(problem);
  try {
    await deps.dispatch({ type: 'blockerSet', itemId, change });
  } catch (err) {
    deps.log?.error(`blockerSet for ${itemId} failed: ${errorMessage(err)}`);
    return refusalOf('refused');
  }
  return { blockers: deps.latest()?.tasks.find((t) => t.item.itemId === itemId)?.item.blockers ?? NO_BLOCKERS };
}

// A source's refusal (#56): the request's own fault to its code. A write that landed but whose re-read failed is a success with what was read
// (the next poll brings the item back). Anything else is the source's: its raw words go to the log, never to the answer
function failed(deps: RelateDeps, itemId: string, err: unknown): RelateOutcome {
  if (err instanceof RelationRereadError) {
    deps.log?.error(`blockers of ${itemId} written, but their re-read failed: ${err.message}`);
    // Nothing read: refused, so the UI does not show the written relation as gone; a retry is a no-op, relate reads before it writes
    return err.blockers === undefined ? refusalOf('refused') : { blockers: err.blockers };
  }
  // #810: the adapter's own sentence, which names its type's forms; the route cannot, since it does not know the source's type.
  // It echoes the ref, which changeOf and refsOf cap at 200 characters before any adapter sees it
  if (err instanceof BadBlockerRefError) return { refusal: { status: HTTP_BAD_REQUEST, error: err.message, code: BLOCKER_CODES.badRequest } };
  const known = KNOWN.find(([type]) => err instanceof type);
  if (known !== undefined) return refusalOf(known[1]);
  deps.log?.error(`blockers of ${itemId} refused: ${errorMessage(err)}`);
  return refusalOf('refused');
}

// A source item's relation (#56): the adapter writes it and re-reads the item; its entry goes through itemRead, as a field write's
async function relateOnSource(deps: RelateDeps, current: Live, name: string, itemId: string, change: BlockerChange): Promise<RelateOutcome> {
  const relate = current.runtime.sources.get(name)?.relate;
  if (relate === undefined || itemSource(itemId) !== name) return refusalOf('unknownItem');
  const backoff = backoffAnswer(current.state, name);
  if (backoff !== undefined) return { refusal: backoff };
  let written: BlockerWrite;
  try {
    written = await relate(itemId, change);
  } catch (err) {
    const limited = await rateLimitAnswer(err, name, deps.reportRetry); // #812: before the adapter's own refusals
    return limited === undefined ? failed(deps, itemId, err) : { refusal: limited };
  }
  await dispatchEntry(deps, name, itemId, written.entry);
  return { blockers: written.blockers };
}

// A written entry goes through itemRead, as a field write's; the write is done, so a failed dispatch only logs and the answer still goes out
async function dispatchEntry(deps: RelateDeps, name: string, itemId: string, entry: SourceItem | undefined): Promise<void> {
  if (entry === undefined) return;
  try {
    await deps.dispatch({ type: 'itemRead', source: name, itemId, entry });
  } catch (err) {
    deps.log?.error(`itemRead for ${itemId} failed: ${errorMessage(err)}`);
  }
}

// #829: the body as a RelationChange; the type is compared exactly, as the site names it, so only the ref is trimmed
function relationChangeOf(body: unknown): RelationChange | undefined {
  const { action, type, direction, ref } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if ((action !== 'add' && action !== 'remove') || (direction !== 'inward' && direction !== 'outward') || typeof type !== 'string' || typeof ref !== 'string') return undefined;
  const trimmed = ref.trim();
  if (type.trim() === '' || type.length > TYPE_MAX || trimmed === '' || trimmed.length > REF_MAX) return undefined;
  return { action, type, direction, ref: trimmed };
}

// #829: relate's mapping, with the relations a failed re-read carries; a blocking type is the request's own fault, in the adapter's words
function relationFailed(deps: RelateDeps, itemId: string, err: unknown): RelationOutcome {
  if (err instanceof RelationRereadError) {
    deps.log?.error(`relations of ${itemId} written, but their re-read failed: ${err.message}`);
    return err.relations === undefined ? refusalOf('refused') : { relations: err.relations };
  }
  if (err instanceof BadRelationTypeError) return { refusal: { status: HTTP_BAD_REQUEST, error: err.message, code: BLOCKER_CODES.badRequest } };
  const outcome = failed(deps, itemId, err);
  return 'refusal' in outcome ? outcome : refusalOf('refused'); // failed answers blockers only for a re-read, handled above
}

// #829: a source item's relation through its setRelation, refused and dispatched as relateOnSource; the Hive's own tasks have none
async function setRelationOnSource(deps: RelateDeps, current: Live, name: string, itemId: string, change: RelationChange): Promise<RelationOutcome> {
  const setRelation = name === HIVE_SOURCE ? undefined : current.runtime.sources.get(name)?.setRelation;
  if (setRelation === undefined || itemSource(itemId) !== name) return refusalOf('unknownItem');
  const backoff = backoffAnswer(current.state, name);
  if (backoff !== undefined) return { refusal: backoff };
  let written: RelationWrite;
  try {
    written = await setRelation(itemId, change);
  } catch (err) {
    const limited = await rateLimitAnswer(err, name, deps.reportRetry);
    return limited === undefined ? relationFailed(deps, itemId, err) : { refusal: limited };
  }
  await dispatchEntry(deps, name, itemId, written.entry);
  return { relations: written.relations };
}

// The route's own choice: `hive` edits the Hive's tasks, any other name goes through that source's relate
const relateOn = (deps: RelateDeps, current: Live, name: string, itemId: string, change: BlockerChange): Promise<RelateOutcome> =>
  (name === HIVE_SOURCE ? relateHive(deps, current.state, itemId, change) : relateOnSource(deps, current, name, itemId, change));

/** One relation written exactly as the blockers route writes it (#294), for hive_stop's block. The item's own source picks the path: a hive
 * task's blockerSet, or its source's relate. An unknown task takes the hive path, which answers unknownItem; so does a Hive with no config. */
export async function relateItem(deps: RelateDeps, current: Live | undefined, itemId: string, change: BlockerChange): Promise<RelateOutcome> {
  if (current === undefined) return refusalOf('unknownItem');
  const source = current.state.tasks.find((t) => t.item.itemId === itemId)?.item.source;
  return relateOn(deps, current, source ?? HIVE_SOURCE, itemId, change);
}

/** Whether hive_stop may write a blocker on the item (#294): a hive task always can (blockerSet); a source's task when its adapter relates. */
export function canRelateItem(current: Live, itemId: string): boolean {
  const task = current.state.tasks.find((t) => t.item.itemId === itemId);
  if (task === undefined) return false;
  return task.item.source === undefined || current.runtime.sources.get(task.item.source)?.relate !== undefined;
}

const BLOCK_MAX = 10; // #294: hive_stop's block names a handful of issues; more is no single blocker

/** hive_stop's block as the route's refs (#294): each a positive integer or a string of 1 to REF_MAX after the trim, 1 to BLOCK_MAX of them;
 * any other list is undefined. */
export function refsOf(block: readonly (number | string)[]): string[] | undefined {
  const refs = block.map((r) => (typeof r === 'number' ? (Number.isInteger(r) && r > 0 ? String(r) : '') : r.trim()));
  return refs.length === 0 || refs.length > BLOCK_MAX || refs.some((r) => r === '' || r.length > REF_MAX) ? undefined : refs;
}

// #57: the add row's text, trimmed; absent, empty or too long is no search
function searchOf(q: unknown): string | undefined {
  if (typeof q !== 'string') return undefined;
  const trimmed = q.trim();
  return trimmed === '' || trimmed.length > SEARCH_MAX ? undefined : trimmed;
}

// #57: a source item's candidates through its findBlockers, refused as relate is; the source's words go to the log, never to the answer
async function findOnSource(deps: BlockerRouteDeps, res: Response, current: Live, name: string, itemId: string, text: string): Promise<void> {
  const find = current.runtime.sources.get(name)?.findBlockers;
  if (find === undefined || itemSource(itemId) !== name) return refuse(res, 'unknownItem');
  if (refusedInBackoff(current.state, name, res)) return;
  let candidates: BlockerRef[];
  try {
    candidates = await find(itemId, text);
  } catch (err) {
    deps.log?.error(`blocker search on ${itemId} refused: ${errorMessage(err)}`);
    return refuse(res, 'refused');
  }
  res.json({ candidates });
}

// #828: the site's link types for a saved source, read live; with relations=1 (#829), less the source's blockingLinkTypes. A source whose type has none answers [] with no call, and an unknown name 404.
// Refused inside the backoff as the other source reads are; a rate limit is a 429 (#812); any other failure a 502 with the transport's words,
// which never carry a body or a token (jira-fetch.ts)
function registerLinkTypesRoute(app: Express, deps: BlockerRouteDeps): void {
  app.get('/sources/:name/link-types', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const name = req.params.name as string;
    const source = current.runtime.sources.get(name);
    if (source === undefined) return void res.status(HTTP_NOT_FOUND).json({ error: NO_SOURCE });
    if (source.linkTypes === undefined) return void res.json({ linkTypes: [] });
    if (refusedInBackoff(current.state, name, res)) return;
    try {
      // #829: ?relations=1 answers the types the relations section may add: the site's less the source's blocking ones
      const blocking = req.query.relations === '1' ? deps.blockingLinkTypes(name) : [];
      res.json({ linkTypes: (await source.linkTypes()).filter((type) => !blocking.includes(type.name)) });
    } catch (err) {
      if (await answeredRateLimit(err, name, deps.reportRetry, res)) return;
      deps.log?.error(`link types of ${name} refused: ${errorMessage(err)}`);
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
    }
  });
}

/** POST /sources/:name/items/:itemId/blockers (#56): one relation added or removed, `{ action, kind, ref }`, answering the item's
 * `{ blockers }`. `hive` edits the Hive's own tasks (item `local:<n>`, ref a hive task's id); any other source goes through its relate.
 * GET …/blockers/candidates?q= (#57): the add row's suggestions, `{ candidates }`, from the hive tasks or the source's findBlockers.
 * GET /sources/:name/link-types (#828): the site's link types, `{ linkTypes }`.
 * POST …/relations (#829): one non-blocking relation added or removed, `{ action, type, direction, ref }`, answering `{ relations }`; a source
 * without setRelation and `hive` answer unknownItem. */
export function registerBlockerRoutes(app: Express, deps: BlockerRouteDeps): void {
  app.post('/sources/:name/items/:itemId/blockers', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const change = changeOf(req.body);
    if (change === undefined) return refuse(res, 'badRequest');
    const name = req.params.name as string;
    const itemId = req.params.itemId as string;
    answer(res, await relateOn(deps, current, name, itemId, change));
  });
  app.get('/sources/:name/items/:itemId/blockers/candidates', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const text = searchOf(req.query.q);
    if (text === undefined) return refuse(res, 'badRequest');
    const name = req.params.name as string;
    const itemId = req.params.itemId as string;
    if (name === HIVE_SOURCE) return void res.json({ candidates: hiveCandidates(current.state.tasks, itemId, text) });
    await findOnSource(deps, res, current, name, itemId, text);
  });
  app.post('/sources/:name/items/:itemId/relations', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const change = relationChangeOf(req.body);
    if (change === undefined) return void res.status(HTTP_BAD_REQUEST).json({ error: BAD_RELATION, code: BLOCKER_CODES.badRequest });
    answer(res, await setRelationOnSource(deps, current, req.params.name as string, req.params.itemId as string, change));
  });
  registerLinkTypesRoute(app, deps);
}
