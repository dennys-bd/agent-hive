import { HIVE_SOURCE, itemSource, onSource, stageOf } from './tasks.js';
import type { Refusal } from './server-tasks.js'; // a type only: no runtime cycle
import type { CombConfig, Effect, HiveEvent, Source, State } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const TITLE_MAX = 200; // characters, after the trim
const BODY_MAX_BYTES = 64 * 1024; // UTF-8 bytes
const TITLE_REQUIRED_MESSAGE = 'título obrigatório';
const TITLE_TOO_LONG_MESSAGE = `título passa de ${TITLE_MAX} caracteres`;
const BODY_MESSAGE = 'descrição precisa ser texto de até 64 KB';
const URL_MAX_BYTES = 2 * 1024; // #756: a created task's link back to its issue
const HTTPS_URL = /^https:\/\/\S+$/;
const URL_MESSAGE = 'url precisa ser um link https de até 2 KB';
const ORIGIN_MESSAGE = 'origin precisa ser o item de uma source configurada';
const ORIGIN_TAKEN_MESSAGE = 'já existe uma tarefa criada desse item';
export const UNKNOWN_STAGE_MESSAGE = 'etapa desconhecida';
export const UNKNOWN_WORKSPACE_MESSAGE = 'unknown workspace';
export const HIVE_OFF_MESSAGE = 'hive is turned off: create the task in a source';
export const UNKNOWN_SOURCE_MESSAGE = 'source must be "hive" or a configured source';
export const WORKSPACE_ON_SOURCE_MESSAGE = "a source's task properties set its workspace: leave workspace out";
export const noCreateMessage = (name: string): string => `source ${name} cannot create tasks: it has no repository for new issues`;
export const noColumnMessage = (stage: string, name: string): string => `stage ${stage} reads no column of source ${name}`;
// Neutral on why: a filtered item and a poll that failed or was rate limited both land here, and the next poll brings the second in
export const notInFlowNotice = (name: string, itemId: string): string => `created ${itemId} on ${name}; it is not in the flow yet: the source's filter may leave it out, or the next poll will bring it in`;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a create answers (#846): the task once the state holds it, or the source item and why it is not in the flow. */
export type Created = { id: string; itemId: string } | { itemId: string; notice: string };

/** What createTask reads and does: the state the check reads, the Comb, the live sources, the dispatch, the poll loop's one-source poll and the
 * state after it. POST /tasks and hive_create_task hand the same. */
export interface CreateDeps {
  state: State;
  config: { comb: Pick<CombConfig, 'prefix' | 'hiveSource' | 'createIn' | 'sources'> };
  sources: ReadonlyMap<string, Pick<Source, 'create'>>;
  dispatch(event: HiveEvent): Promise<Effect[]>;
  poll(names: string[], manual?: string[]): Promise<void>; // manual: item ids that enter the state with auto off
  latest(): State | undefined;
}

// The native view's link back to the issue a task is created from (#756): an https url of at most 2 KB, and the source item's id, which names
// a configured source and no other task holds. Neither: the plain create.
function linkOf(state: State, sources: readonly string[], url: unknown, origin: unknown): { url?: string; origin?: string } | Refusal {
  if (url !== undefined && (typeof url !== 'string' || !HTTPS_URL.test(url) || Buffer.byteLength(url, 'utf8') > URL_MAX_BYTES)) return { status: HTTP_BAD_REQUEST, message: URL_MESSAGE };
  const link = url === undefined ? {} : { url };
  if (origin === undefined) return link;
  const source = typeof origin === 'string' ? itemSource(origin) : undefined;
  if (typeof origin !== 'string' || source === undefined || !sources.includes(source)) return { status: HTTP_BAD_REQUEST, message: ORIGIN_MESSAGE };
  if (state.tasks.some((c) => c.item.origin === origin)) return { status: HTTP_CONFLICT, message: ORIGIN_TAKEN_MESSAGE };
  return { ...link, origin };
}

/** The createTask the body asks for, or why not: a trimmed title of 1 to 200 characters, an optional text body of at most 64 KB, the name
 * of a Comb stage, an optional Comb workspace (#179), and the native view's url and origin (#756), `sources` being the configured source
 * names an origin may name. Shared by POST /tasks and the hive_create_task tool (src/mcp.ts, #99), which hands no sources. */
export function createEvent(state: State, prefix: string, body: unknown, sources: readonly string[] = []): Extract<HiveEvent, { type: 'createTask' }> | Refusal {
  const { title, body: text = '', stage, workspace, auto, url, origin } = (body ?? {}) as { title?: unknown; body?: unknown; stage?: unknown; workspace?: unknown; auto?: unknown; url?: unknown; origin?: unknown };
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (trimmed === '') return { status: HTTP_BAD_REQUEST, message: TITLE_REQUIRED_MESSAGE };
  if (trimmed.length > TITLE_MAX) return { status: HTTP_BAD_REQUEST, message: TITLE_TOO_LONG_MESSAGE };
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > BODY_MAX_BYTES) return { status: HTTP_BAD_REQUEST, message: BODY_MESSAGE };
  if (typeof stage !== 'string' || stageOf(state.stages, stage) === undefined) return { status: HTTP_BAD_REQUEST, message: UNKNOWN_STAGE_MESSAGE };
  if (workspace !== undefined && (typeof workspace !== 'string' || !state.workspaces.includes(workspace))) return { status: HTTP_BAD_REQUEST, message: UNKNOWN_WORKSPACE_MESSAGE }; // #179
  const link = linkOf(state, sources, url, origin);
  if ('status' in link) return link;
  // auto: false keeps the fill off a task its creator starts right away (redesign 03); anything else is the plain create, born auto (#573)
  return { type: 'createTask', title: trimmed, body: text, stage, prefix, ...(workspace === undefined ? {} : { workspace }), auto: auto !== false, ...link };
}

/** A new task where the body's source says, else where comb.createIn does (#846): hive runs createEvent as before #846; a source creates
 * its item through Source.create, then polls that source, the only way a source task enters the state. */
export async function createTask(deps: CreateDeps, body: unknown): Promise<Created | Refusal> {
  const { comb } = deps.config;
  const destination = ((body ?? {}) as { source?: unknown }).source ?? comb.createIn;
  if (destination === HIVE_SOURCE) return createInHive(deps, body);
  if (typeof destination !== 'string' || !comb.sources.some((s) => s.name === destination)) return { status: HTTP_BAD_REQUEST, message: UNKNOWN_SOURCE_MESSAGE };
  return createInSource(deps, body, destination);
}

async function createInHive(deps: CreateDeps, body: unknown): Promise<Created | Refusal> {
  const { prefix, hiveSource, sources } = deps.config.comb;
  if (!hiveSource) return { status: HTTP_CONFLICT, message: HIVE_OFF_MESSAGE };
  const event = createEvent(deps.state, prefix, body, sources.map((s) => s.name)); // #756: an origin names one of them
  if ('status' in event) return event;
  const n = deps.state.localCount + 1; // dispatch reduces before its first await: the number createTask hands out
  await deps.dispatch(event);
  return { id: `${prefix}-${n}`, itemId: `local:${n}` };
}

// The same title, body and stage rules as a task created in hive (createEvent); the column is the stage's first from column on that source
async function createInSource(deps: CreateDeps, body: unknown, name: string): Promise<Created | Refusal> {
  const entry = deps.config.comb.sources.find((s) => s.name === name);
  const source = deps.sources.get(name);
  if (entry?.repository === undefined || !source?.create) return { status: HTTP_BAD_REQUEST, message: noCreateMessage(name) };
  if (((body ?? {}) as { workspace?: unknown }).workspace !== undefined) return { status: HTTP_BAD_REQUEST, message: WORKSPACE_ON_SOURCE_MESSAGE };
  const event = createEvent(deps.state, deps.config.comb.prefix, body);
  if ('status' in event) return event;
  const column = onSource(stageOf(deps.state.stages, event.stage)?.from, name)?.[0];
  if (column === undefined) return { status: HTTP_BAD_REQUEST, message: noColumnMessage(event.stage, name) };
  let itemId: string;
  try {
    itemId = await source.create({ title: event.title, body: event.body, column });
  } catch (err) {
    return { status: HTTP_BAD_GATEWAY, message: errorMessage(err) };
  }
  // auto false mirrors the hive path: the poll's fill must not start a task whose creator starts it right away (the item is born with auto off)
  // The issue exists from here on: a poll that throws must not turn the answer into an error, or the retry creates a second issue
  try {
    await deps.poll([name], event.auto ? [] : [itemId]); // the poll loop's own path for this one source
  } catch {
    return { itemId, notice: notInFlowNotice(name, itemId) };
  }
  const task = deps.latest()?.tasks.find((c) => c.item.itemId === itemId);
  return task ? { id: task.item.id, itemId } : { itemId, notice: notInFlowNotice(name, itemId) };
}
