import { randomUUID } from 'node:crypto';
import { taskOfPr } from './activities.js';
import { isPrUrl } from './orchestrator.js';
import type { Logger } from './log.js';
import { canCreate, type CanCreate } from './create-in.js';
import { HIVE_SOURCE, itemSource, onSource, stageOf } from './tasks.js';
import { CreateRefusedError, IssuePlacementError } from './source-create.js';
import { rateLimitAnswer, type ReportRetry } from './source-errors.js';
import type { Refusal } from './server-tasks.js'; // a type only: no runtime cycle
import type { CombConfig, CreatedRef, Effect, HiveEvent, Source, SourceConfig, State } from './types.js';

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
export const ORIGIN_TAKEN_MESSAGE = 'já existe uma tarefa criada desse item';
export const UNKNOWN_STAGE_MESSAGE = 'etapa desconhecida';
export const UNKNOWN_WORKSPACE_MESSAGE = 'unknown workspace';
export const HIVE_OFF_MESSAGE = 'hive is turned off: create the task in a source';
export const UNKNOWN_SOURCE_MESSAGE = 'source must be "hive" or a configured source';
export const NO_STAGE_ON_SOURCE_MESSAGE = 'a task outside the flow is created only in hive'; // #566: the column a source task is born in is its stage's
export const WORKSPACE_ON_SOURCE_MESSAGE = "a source's task properties set its workspace: leave workspace out";
const LABELS_MAX = 20; // #767: the open point's answer
const LABEL_MAX = 50; // characters: GitHub's own limit on a label's name
export const LABELS_MESSAGE = `labels must be up to ${LABELS_MAX} distinct label names of at most ${LABEL_MAX} characters`;
export const HIVE_ISSUE_FIELDS_MESSAGE = 'labels and status are fields of an issue: create it in a source';
export const STATUS_OR_STAGE_MESSAGE = 'send status or stage, not both';
export const STATUS_MESSAGE = "status must be a Status option's name or null";
export const PR_HIVE_ONLY_MESSAGE = 'pr creates in hive only: leave source out or set it to "hive"';
export const PR_URL_MESSAGE = 'pr must be a GitHub pull request link';
export const PR_TAKEN_MESSAGE = 'a task already holds this PR';
// Why a source of each type cannot create (#811): a Record, so a new type must say whether it has a reason to point at, as canCreate's switch
// makes it say how it creates; undefined = only the neutral words
const NO_CREATE_REASON: Record<SourceConfig['type'], string | undefined> = { github: 'it has no repository for new issues' };
export const noCreateMessage = (entry: Pick<SourceConfig, 'name' | 'type'>): string => {
  const reason = NO_CREATE_REASON[entry.type] as string | undefined; // a test's cast type finds no entry
  return reason === undefined ? `source ${entry.name} cannot create tasks` : `source ${entry.name} cannot create tasks: ${reason}`;
};
export const noColumnMessage = (stage: string, name: string): string => `stage ${stage} reads no column of source ${name}`;
// Neutral on why: a filtered item and a poll that failed or was rate limited both land here, and the next poll brings the second in
export const notInFlowNotice = (name: string, itemId: string): string => `created ${itemId} on ${name}; it is not in the flow yet: the source's filter may leave it out, or the next poll will bring it in`;

export const offProjectNotice = (url: string): string => `created ${url} off the Project: no source lists it`; // #767

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a create answers (#846): the task once the state holds it, or why it is not in the flow; on a source, its issue and the stage it entered
 * (#767), and no item off the Project. */
export type Created = { id: string; itemId: string; ref?: CreatedRef; stage?: string } | { itemId?: string; ref?: CreatedRef; notice: string };

/** What createTask reads and does: the state the check reads, the Comb, the live sources, the dispatch, the poll loop's one-source poll and the
 * state after it. POST /tasks and hive_create_task hand the same. */
export interface CreateDeps {
  state: State;
  config: { comb: Pick<CombConfig, 'prefix' | 'hiveSource' | 'createIn' | 'sources'> };
  sources: ReadonlyMap<string, Pick<Source, 'create'>>;
  dispatch(event: HiveEvent): Promise<Effect[]>;
  poll(names: string[], manual?: string[]): Promise<void>; // manual: item ids that enter the state with auto off
  latest(): State | undefined;
  canCreate?: CanCreate; // #811: whether a source takes new tasks; absent = canCreate. A test hands one that accepts a type the union lacks
  reportRetry?: ReportRetry; // #812: POST /tasks' rate-limit report; hive_create_task hands none, as it hands no log, and keeps its refusal
  log?: Pick<Logger, 'warn'>; // #772: a failed create's words to hive.log; hive_create_task hands none, since its answer gives them to the agent
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
 * of a Comb stage or none (#566: absent = outside the flow), an optional Comb workspace (#179), and the native view's url and origin (#756),
 * `sources` being the configured source names an origin may name. Shared by POST /tasks and the hive_create_task tool (src/mcp.ts, #99), which hands no sources. */
export function createEvent(state: State, prefix: string, body: unknown, sources: readonly string[] = []): Extract<HiveEvent, { type: 'createTask' }> | Refusal {
  const { title, body: text = '', stage, workspace, auto, url, origin } = (body ?? {}) as { title?: unknown; body?: unknown; stage?: unknown; workspace?: unknown; auto?: unknown; url?: unknown; origin?: unknown };
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (trimmed === '') return { status: HTTP_BAD_REQUEST, message: TITLE_REQUIRED_MESSAGE };
  if (trimmed.length > TITLE_MAX) return { status: HTTP_BAD_REQUEST, message: TITLE_TOO_LONG_MESSAGE };
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > BODY_MAX_BYTES) return { status: HTTP_BAD_REQUEST, message: BODY_MESSAGE };
  if (stage !== undefined && (typeof stage !== 'string' || stageOf(state.stages, stage) === undefined)) return { status: HTTP_BAD_REQUEST, message: UNKNOWN_STAGE_MESSAGE };
  if (workspace !== undefined && (typeof workspace !== 'string' || !state.workspaces.includes(workspace))) return { status: HTTP_BAD_REQUEST, message: UNKNOWN_WORKSPACE_MESSAGE }; // #179
  const link = linkOf(state, sources, url, origin);
  if ('status' in link) return link;
  // auto: false keeps the fill off a task its creator starts right away (redesign 03); anything else is the plain create, born auto (#573)
  return { type: 'createTask', title: trimmed, body: text, ...(stage === undefined ? {} : { stage }), prefix, ...(workspace === undefined ? {} : { workspace }), auto: auto !== false, ...link };
}

type CreatePr = Extract<HiveEvent, { type: 'createTask' }>['pr'];

/** A new task where the body's source says, else where comb.createIn does (#846): hive runs createEvent as before #846; a source creates
 * its item through Source.create, then polls that source, the only way a source task enters the state. A body with pr is a hive task made
 * from that PR (#67). */
export async function createTask(deps: CreateDeps, body: unknown): Promise<Created | Refusal> {
  const { comb } = deps.config;
  const { source, pr } = (body ?? {}) as { source?: unknown; pr?: unknown };
  if (pr !== undefined) return createFromPr(deps, body as Record<string, unknown>, source, pr);
  const destination = source ?? comb.createIn;
  if (destination === HIVE_SOURCE) return createInHive(deps, body);
  const entry = typeof destination === 'string' ? comb.sources.find((s) => s.name === destination) : undefined;
  if (entry === undefined) return { status: HTTP_BAD_REQUEST, message: UNKNOWN_SOURCE_MESSAGE };
  return createInSource(deps, body, entry);
}

// A hive task made from a PR, often another person's (#67): hive only, since a source would write an issue to GitHub; a pull request link as
// hive_pr accepts it; one task per PR, as origin is for an issue. The record id is drawn here so the reducer stays pure. Nothing reaches GitHub.
async function createFromPr(deps: CreateDeps, body: Record<string, unknown>, source: unknown, pr: unknown): Promise<Created | Refusal> {
  if (source !== undefined && source !== HIVE_SOURCE) return { status: HTTP_BAD_REQUEST, message: PR_HIVE_ONLY_MESSAGE };
  if (typeof pr !== 'string' || !isPrUrl(pr)) return { status: HTTP_BAD_REQUEST, message: PR_URL_MESSAGE };
  if (taskOfPr(deps.state, pr) !== undefined) return { status: HTTP_CONFLICT, message: PR_TAKEN_MESSAGE };
  return createInHive(deps, { ...body, url: body.url ?? pr }, { url: pr, recordId: randomUUID() });
}

async function createInHive(deps: CreateDeps, body: unknown, pr?: CreatePr): Promise<Created | Refusal> {
  const { labels, status } = (body ?? {}) as { labels?: unknown; status?: unknown };
  if (labels !== undefined || status !== undefined) return { status: HTTP_BAD_REQUEST, message: HIVE_ISSUE_FIELDS_MESSAGE }; // #767: hive has no repository labels or Project
  const { prefix, hiveSource, sources } = deps.config.comb;
  if (!hiveSource) return { status: HTTP_CONFLICT, message: HIVE_OFF_MESSAGE };
  const event = createEvent(deps.state, prefix, body, sources.map((s) => s.name)); // #756: an origin names one of them
  if ('status' in event) return event;
  const n = deps.state.localCount + 1; // dispatch reduces before its first await: the number createTask hands out
  await deps.dispatch(pr === undefined ? event : { ...event, pr });
  return { id: `${prefix}-${n}`, itemId: `local:${n}` };
}

const isLabels = (labels: unknown): labels is string[] => Array.isArray(labels) && labels.length <= LABELS_MAX && new Set(labels).size === labels.length
  && labels.every((l) => typeof l === 'string' && l !== '' && l.length <= LABEL_MAX);

// #767: the new issue's labels and, from status, its column (a Status option's name, or null: off the Project), or why not. Whether the
// names exist is the adapter's check, where the ids are
function issueFields(body: unknown): { labels: string[]; column?: string | null } | Refusal {
  const { labels = [], status, stage } = (body ?? {}) as { labels?: unknown; status?: unknown; stage?: unknown };
  if (!isLabels(labels)) return { status: HTTP_BAD_REQUEST, message: LABELS_MESSAGE };
  if (status !== undefined && status !== null && typeof status !== 'string') return { status: HTTP_BAD_REQUEST, message: STATUS_MESSAGE };
  if (status !== undefined && stage !== undefined) return { status: HTTP_BAD_REQUEST, message: STATUS_OR_STAGE_MESSAGE };
  return { labels, ...(status === undefined ? {} : { column: status }) };
}

// #566: with no status, the column a source task is born in is its stage's first from column there
function stageColumn(state: State, stage: string | undefined, name: string): string | Refusal {
  if (stage === undefined) return { status: HTTP_BAD_REQUEST, message: NO_STAGE_ON_SOURCE_MESSAGE };
  return onSource(stageOf(state.stages, stage)?.from, name)?.[0] ?? { status: HTTP_BAD_REQUEST, message: noColumnMessage(stage, name) };
}

// #767: a name the source refused created nothing (400, a safe retry); an issue left behind rides on the 502, so no retry makes a second one.
// #772: either way the dialog shows its own words, so the source's go to hive.log, on one line as githubRefusal writes them (src/server-pr.ts).
// The GitHub transports never put the token in an error (src/sources/github-gql.ts), so the line carries none
function createFailure(err: unknown, name: string, log: CreateDeps['log']): Refusal {
  const message = errorMessage(err);
  log?.warn(`create on ${name}: GitHub refused the write: ${message.replace(/\s+/g, ' ')}`);
  if (err instanceof CreateRefusedError) return { status: HTTP_BAD_REQUEST, message };
  return { status: HTTP_BAD_GATEWAY, message, ...(err instanceof IssuePlacementError ? { ref: err.ref } : {}) };
}

// The same title and body rules as a task created in hive (createEvent); the column is status's (#767), else the stage's first from column on that source
async function createInSource(deps: CreateDeps, body: unknown, entry: SourceConfig): Promise<Created | Refusal> {
  const { name } = entry;
  const source = deps.sources.get(name);
  if (!(deps.canCreate ?? canCreate)(entry) || !source?.create) return { status: HTTP_BAD_REQUEST, message: noCreateMessage(entry) };
  if (((body ?? {}) as { workspace?: unknown }).workspace !== undefined) return { status: HTTP_BAD_REQUEST, message: WORKSPACE_ON_SOURCE_MESSAGE };
  const fields = issueFields(body);
  if ('status' in fields) return fields;
  const event = createEvent(deps.state, deps.config.comb.prefix, body);
  if ('status' in event) return event;
  const column = fields.column === undefined ? stageColumn(deps.state, event.stage, name) : fields.column;
  if (column !== null && typeof column === 'object') return column;
  let made: Awaited<ReturnType<NonNullable<Source['create']>>>;
  try {
    made = await source.create({ title: event.title, body: event.body, column, labels: fields.labels });
  } catch (err) {
    // #812 decision 7: a rate limit created nothing, so a 429 with its retry time is a safe retry; anything else keeps #767's answers
    const limited = deps.reportRetry === undefined ? undefined : await rateLimitAnswer(err, name, deps.reportRetry);
    return limited === undefined ? createFailure(err, name, deps.log) : { status: limited.status, message: limited.error, resetsAt: limited.resetsAt };
  }
  // #767: an issue off the Project is listed by no source, so a poll for it would only spend quota
  if (made.itemId === undefined) return { ref: made.ref, notice: offProjectNotice(made.ref.url) };
  return polled(deps, name, { itemId: made.itemId, ref: made.ref }, event.auto);
}

// auto false mirrors the hive path: the poll's fill must not start a task whose creator starts it right away (the item is born with auto off)
// The issue exists from here on: a poll that throws must not turn the answer into an error, or the retry creates a second issue
async function polled(deps: CreateDeps, name: string, made: { itemId: string; ref: CreatedRef }, auto: boolean): Promise<Created> {
  const notice = { ...made, notice: notInFlowNotice(name, made.itemId) };
  try {
    await deps.poll([name], auto ? [] : [made.itemId]); // the poll loop's own path for this one source
  } catch {
    return notice;
  }
  const task = deps.latest()?.tasks.find((c) => c.item.itemId === made.itemId);
  return task ? { id: task.item.id, ...made, ...(task.stage === undefined ? {} : { stage: task.stage }) } : notice;
}
