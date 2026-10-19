import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { taskOfWorker } from './activities.js';
import { taskWorkspace } from './config.js';
import { correlationOf } from './event-derive.js';
import type { Correlation, EventLog, RecordInput, RefusalCode } from './events.js';
import { isMemoryRefusal, lessonRefusal, looksLikeSecret, MEMORY_SECRET_MESSAGE, memoryCounts, type MemoryStore, whyProblem, withEntry, withUse } from './memory.js';
import { liveRecord } from './record-kit.js';
import { freeEndRefused } from './runs.js';
import { isBlocked, stageOf, taskId } from './tasks.js';
import { refsOf, type RelateOutcome } from './server-blockers.js';
import { verdictProblem, withVerdict } from './transit.js';
import { MCP_ROUTE } from './hooks-settings.js';
import { isPrUrl } from './orchestrator.js';
import { appendMessage, markAgentResolved } from './review-store.js';
import { type ReplyReviews, workerReview } from './mcp-review.js';
import { createTask } from './create-task.js';
import { conventionsAnswer, forkConventions, workerWorkspace } from './mcp-conventions.js';
import { MEMORY_KINDS, type MemoryKind, SOURCE_ACTIONS, type Stage, type BlockerChange, type Config, type Source, type SourceConfig, type CloseReason, type Effect, type Exec, type HiveEvent, REVIEW_TEXT_MAX, type ReviewMessage, type State, type Task, type Worker } from './types.js';

const SERVER_INFO = { name: 'hive', version: '1.0.0' }; // Claude Code names the tools mcp__hive__<tool>
const RESULT_MAX_BYTES = 64 * 1024; // serialized, UTF-8
const QUESTION_MAX = 2000; // characters, after the trim
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_SERVER_ERROR = 500;
const JSONRPC_SERVER_ERROR = -32000;
const JSONRPC_INTERNAL_ERROR = -32603;
const OK = 'ok';
export const UNKNOWN_WORKER_MESSAGE = 'unknown worker';
export const ASK_REPLY = 'ok: now ask it in chat and end your turn';
const RESULT_OBJECT_MESSAGE = 'result must be a JSON object';
const RESULT_SIZE_MESSAGE = `result, merged with the task's, is over ${RESULT_MAX_BYTES / 1024} KB serialized`;
const URL_MESSAGE = 'url must be an https://github.com/<owner>/<repo>/pull/<n> pull request URL';
const QUESTION_MESSAGE = `question must be 1 to ${QUESTION_MAX} characters`;
const CLOSE_REASONS = ['wontDo', 'duplicate'] as const satisfies readonly CloseReason[];
const DUPLICATE_OF_MESSAGE = 'duplicateOf needs reason "duplicate" and the original issue\'s number, a positive integer';
export const CANNOT_CLOSE_MESSAGE = 'this task\'s source cannot close it; call hive_stop without reason';
export const BLOCK_WITH_REASON_MESSAGE = 'block records what the task waits for; it takes no reason or duplicateOf';
export const BLOCK_MESSAGE = 'block must be 1 to 10 refs, each an issue (12, #12, owner/repo#12) or a task id';
export const CANNOT_BLOCK_MESSAGE = 'this task\'s source cannot record a blocker; call hive_stop without block';
export const NOT_BLOCKED_MESSAGE = 'none of these blockers is open; go on with the task';
export const NO_SESSION_MESSAGE = 'your session id is not known yet';
export const REPLY_TEXT_MESSAGE = `text must be 1 to ${REVIEW_TEXT_MAX} characters`;
export const UNKNOWN_THREAD_MESSAGE = 'unknown conversation for this task';
export const NOT_PARTICIPANT_MESSAGE = 'this conversation was not sent to your session';
export const THREAD_RESOLVED_MESSAGE = 'the user already resolved this conversation';

/** What the tools read and do: the live state with the config (undefined while the Hive has no config), and the server's dispatch. The
 * review files hive_reply answers in come with ReplyReviews (#591, #344). */
export interface McpDeps extends ReplyReviews {
  live(): { state: State; config: Config; sources: ReadonlyMap<string, Pick<Source, 'create'>> } | undefined; // config: the Comb's prefix and createIn (hive_create_task), the Hive's language and a fork's base (hive_conventions)
  poll(names: string[], manual?: string[]): Promise<void>; // #846: hive_create_task on a source polls it through the route's own path
  dispatch(event: HiveEvent): Promise<Effect[]>;
  canClose(itemId: string): boolean; // hive_stop's reason (#314): whether the task's source can close its item
  relate(itemId: string, change: BlockerChange): Promise<RelateOutcome>; // hive_stop's block (#294): the blockers route's own write, relateItem
  canRelate(itemId: string): boolean; // hive_stop's block (#294): a hive task, or a task whose source relates
  events: Pick<EventLog, 'write'>; // #742: each tool call's mcp.call
  memory: Pick<MemoryStore, 'read' | 'update'>; // #797: hive_remember and hive_applied write the worker's workspace's memory
  exec: Exec; // #854: the remotes behind a fork's hive_conventions
}

// A refusal's code rides on a symbol key (#742): JSON drops symbol keys, so the agent reads only the text, exactly as before
const REFUSAL = Symbol('refusal');
type Answer = CallToolResult & { [REFUSAL]?: RefusalCode };
const reply = (text: string): Answer => ({ content: [{ type: 'text', text }] });
const refuse = (code: RefusalCode, text: string): Answer => ({ content: [{ type: 'text', text }], isError: true, [REFUSAL]: code });
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isJsonObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Why a hive_done result is refused, or undefined: absent is fine, otherwise a JSON object that, merged into the task's current
 * result, stays at most 64 KB serialized (a cap per call alone would let repeated calls grow the task without bound). */
export function resultProblem(result: unknown, current: Record<string, unknown> | undefined): string | undefined {
  if (result === undefined) return undefined;
  if (!isJsonObject(result)) return RESULT_OBJECT_MESSAGE;
  return Buffer.byteLength(JSON.stringify({ ...current, ...result }), 'utf8') > RESULT_MAX_BYTES ? RESULT_SIZE_MESSAGE : undefined;
}

/** Whether hive_stop may close a task's item (#314): the task sits on a Comb source whose type lists close in SOURCE_ACTIONS. A local task
 * has no source; a task or source that is gone has nothing to write to. */
export function canCloseTask(state: State, sources: SourceConfig[], itemId: string): boolean {
  const source = state.tasks.find((c) => taskId(c) === itemId)?.item.source;
  const type = source === undefined ? undefined : sources.find((b) => b.name === source)?.type;
  return type !== undefined && SOURCE_ACTIONS[type].includes('close');
}

// The worker and the task it holds (a stage run's or a free session's: its activity's first task, #629), from one live snapshot; none in a
// local session. #339: hive_done's check and its message read the same stage
function workerTask(deps: McpDeps, ptyId: string): { state: State; worker: Worker; task: Task } | undefined {
  const state = deps.live()?.state;
  const worker = state?.workers.find((s) => s.runId === ptyId);
  const task = state && worker ? taskOfWorker(state, worker) : undefined;
  return state && worker && task ? { state, worker, task } : undefined;
}

const workerTaskId = (deps: McpDeps, ptyId: string): string | undefined => workerTask(deps, ptyId)?.task.item.itemId;

// The result already in the live record of the task the worker runs (#629), for the merged size check.
function taskResult(deps: McpDeps, ptyId: string): Record<string, unknown> | undefined {
  const held = workerTask(deps, ptyId);
  return held && liveRecord(held.state, held.task)?.result;
}

// The stage of the task the worker runs (#134): what its verdict is checked against
function workerStage(deps: McpDeps, ptyId: string): Stage | undefined {
  const held = workerTask(deps, ptyId);
  return held && stageOf(held.state.stages, held.task.stage);
}

// #339: a free session's end its stage has no transition for: nothing ended, and the user decides what comes next
const noTransitionMessage = (stage: string, exit: string, hasResult: boolean): string =>
  `The task is in stage \`${stage}\`, which has no transition for \`${exit}\`: no stage ended.${hasResult ? ' Your result was recorded.' : ''} Ask the user what to do next with hive_ask.`;

// The header's worker, only while it holds a worker: a stale session or a forged call gets the tool error and touches nothing.
function livePtyId(deps: McpDeps, ptyId: string | undefined): string | undefined {
  const workers = deps.live()?.state.workers ?? [];
  return ptyId !== undefined && workers.some((s) => s.runId === ptyId && s.status !== 'empty') ? ptyId : undefined;
}

const RESULT_KEY = /^[A-Za-z0-9_.-]{1,40}$/; // a result key a record may carry: any other could be a path or a sentence
const RESULT_KEYS_MAX = 20;

// An accepted hive_done's result keys as mcp.call names them (#742): only safe-shaped ones, at most RESULT_KEYS_MAX, and how many were left out
function resultKeys(keys: string[] | undefined): { result_keys?: string[]; result_keys_dropped?: number } {
  if (keys === undefined) return {};
  const kept = keys.filter((key) => RESULT_KEY.test(key)).slice(0, RESULT_KEYS_MAX);
  return { result_keys: kept, ...(kept.length < keys.length ? { result_keys_dropped: keys.length - kept.length } : {}) };
}

/** What an mcp.call may name besides its outcome (#742, #797): an accepted hive_done's result keys, hive_remember's kind. Never a value or a text. */
interface CallFacts { keys?: string[]; kind?: MemoryKind }

// Times one tool call and writes its mcp.call (#742): ok, refused with the refusal's code, or error when the handler threw (written, then
// rethrown, so the agent's answer is the SDK's as before); an accepted hive_done names its result's keys only
async function recorded(deps: McpDeps, header: string | undefined, tool: string, call: () => Promise<Answer>, facts: CallFacts = {}): Promise<CallToolResult> {
  const began = Date.now();
  const state = deps.live()?.state;
  const worker = state?.workers.find((s) => s.runId === header && s.status !== 'empty');
  const ids = state && worker ? correlationOf(state, worker) : {};
  const kind = facts.kind === undefined ? {} : { kind: facts.kind };
  const written = (fields: Pick<Extract<RecordInput, { event: 'mcp.call' }>, 'level' | 'outcome' | 'reason' | 'result_keys' | 'result_keys_dropped'>): void =>
    deps.events.write({ event: 'mcp.call', ...ids, tool, latency_ms: Date.now() - began, ...kind, ...fields });
  let answer: Answer;
  try {
    answer = await call();
  } catch (err) {
    written({ level: 'error', outcome: 'error' });
    throw err;
  }
  const reason = answer[REFUSAL];
  written(reason ? { level: 'warn', outcome: 'refused', reason } : { level: 'info', outcome: 'ok', ...resultKeys(facts.keys) });
  return answer;
}

// hive_done and hive_pr: the stage's end and its PR, the intent-carrying paths over the hooks' safety net.
function registerStageTools(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_done', {
    description: 'Tell the Hive this stage is completely finished; then end your turn. Optional result: a JSON object later stages read as {result.<key>}. '
      + 'In a stage with verdicts, pass verdict (one of the stage\'s) and evidence (why, with files and lines).',
    inputSchema: { result: z.record(z.string(), z.unknown()).optional(), verdict: z.string().optional(), evidence: z.string().optional() },
  }, async ({ result, verdict, evidence }) => recorded(deps, header, 'hive_done', async () => {
    const ptyId = livePtyId(deps, header);
    if (!ptyId) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const problem = resultProblem(withVerdict(result, verdict, evidence), taskResult(deps, ptyId)); // #134: as the record will hold it
    if (problem) return refuse('bad_result', problem);
    const wrong = verdictProblem(verdict, evidence, workerStage(deps, ptyId));
    if (wrong) return refuse('bad_verdict', wrong);
    const held = workerTask(deps, ptyId);
    const exit = held && freeEndRefused(held.state, held.worker, held.task, verdict); // #339: the reducer re-checks, so a change in between never halts the task
    await deps.dispatch({ type: 'done', ptyId, ...(result ? { result } : {}), ...(verdict === undefined ? {} : { verdict }), ...(evidence === undefined ? {} : { evidence }) });
    return held && exit ? refuse('no_transition', noTransitionMessage(held.task.stage, exit, result !== undefined)) : reply(OK);
  }, { keys: result && Object.keys(result) }));
  server.registerTool('hive_pr', {
    description: 'Tell the Hive a pull request you opened for this task (its https://github.com/<owner>/<repo>/pull/<n> URL); call it once per PR. '
      + 'For a slice PR pass slice: its merge position k (1-based; the integration PR is the number of slices + 1) and the delivery mode.',
    inputSchema: { url: z.string(), slice: z.object({ k: z.number().int().min(1), type: z.enum(['stacked', 'integration']) }).optional() },
  }, async ({ url, slice }) => recorded(deps, header, 'hive_pr', async () => {
    const ptyId = livePtyId(deps, header);
    if (!ptyId) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    if (!isPrUrl(url)) return refuse('bad_url', URL_MESSAGE);
    await deps.dispatch({ type: 'pr', ptyId, url, ...(slice ? { slice } : {}) });
    return reply(OK);
  }));
}

// hive_ask and hive_create_task: the worker's question for the user, and a new local task in the Comb (#132).
function registerUserTools(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_ask', {
    description: 'Tell the Hive you need the user: pass the question, then ask it in chat and end your turn without hive_done.',
    inputSchema: { question: z.string() },
  }, async ({ question }) => recorded(deps, header, 'hive_ask', async () => {
    const ptyId = livePtyId(deps, header);
    if (!ptyId) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const text = question.trim();
    if (text === '' || text.length > QUESTION_MAX) return refuse('bad_question', QUESTION_MESSAGE);
    await deps.dispatch({ type: 'ask', ptyId, question: text });
    return reply(ASK_REPLY);
  }));
  server.registerTool('hive_create_task', {
    description: 'Create a task in the Hive. stage defaults to the first stage. Optional workspace: a Comb workspace name, for a task created in hive. '
      + "Optional source: where the task is created; defaults to the Hive's setting. Answers the new task id, or a notice when the source's filter leaves it out of the flow.",
    inputSchema: { title: z.string(), body: z.string().optional(), stage: z.string().optional(), workspace: z.string().optional(), source: z.string().optional() },
  }, async ({ title, body, stage, workspace, source }) => recorded(deps, header, 'hive_create_task', async () => {
    const current = deps.live();
    if (!livePtyId(deps, header) || !current) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const { state, config, sources } = current;
    const request = { title, body, stage: stage ?? state.stages[0]?.name, ...(workspace === undefined ? {} : { workspace }), ...(source === undefined ? {} : { source }) };
    // POST /tasks' own resolution (#846): the two cannot drift
    const created = await createTask({ state, config, sources, dispatch: deps.dispatch, poll: deps.poll, latest: () => deps.live()?.state }, request);
    if ('status' in created) return refuse('event', created.message);
    return reply('notice' in created ? created.notice : created.id);
  }));
}

// hive_stop with block (#294): every relation is written first, in order, so relate's re-read gates the task before the kill and no fill can
// pick it up between the kill and the exit. A refused ref, or no open blocker, refuses the call and the session runs on; relations already
// written stay, and a retry is a no-op for them (relate and blockerSet read before they write).
async function stopBlocked(deps: McpDeps, ptyId: string, block: (number | string)[]): Promise<Answer> {
  const refs = refsOf(block);
  if (refs === undefined) return refuse('block_refused', BLOCK_MESSAGE);
  const itemId = workerTaskId(deps, ptyId) ?? ''; // a local session has no task: it cannot relate
  if (!deps.canRelate(itemId)) return refuse('cannot_block', CANNOT_BLOCK_MESSAGE);
  for (const ref of refs) {
    const written = await deps.relate(itemId, { action: 'add', kind: 'blockedBy', ref });
    if ('refusal' in written) return refuse('block_refused', `${ref}: ${written.refusal.error}`);
  }
  const task = deps.live()?.state.tasks.find((t) => taskId(t) === itemId);
  if (!task || !isBlocked(task.item)) return refuse('not_blocked', NOT_BLOCKED_MESSAGE);
  await deps.dispatch({ type: 'stop', ptyId, block: true });
  return reply(OK); // the kill may land before this reaches the worker: the call is its last act
}

// hive_stop (#314): the worker's own Stop, for a task that will not be done. With a reason the task's issue is closed too, after the kill;
// a source that cannot close it refuses the call whole, so the worker learns and may stop without one. With block (#294) the blockers are
// written and the task is left unstopped.
function registerStopTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_stop', {
    description: 'Tell the Hive this task will not be done: your session is stopped. Pass reason "wontDo" or "duplicate" (with duplicateOf, the original issue number) to have the Hive close the issue; never close it yourself. Without reason nothing is written to the source.'
      + ' When the task cannot go on until another issue is done, pass block instead (that issue\'s number, or several: 12, #12, owner/repo#12): the Hive records the blocker and starts the task again once it closes. block takes no reason.',
    inputSchema: { reason: z.enum(CLOSE_REASONS).optional(), duplicateOf: z.number().optional(), block: z.array(z.union([z.number(), z.string()])).optional() },
  }, async ({ reason, duplicateOf, block }) => recorded(deps, header, 'hive_stop', async () => {
    const ptyId = livePtyId(deps, header);
    if (!ptyId) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    if (block !== undefined && (reason !== undefined || duplicateOf !== undefined)) return refuse('block_with_reason', BLOCK_WITH_REASON_MESSAGE);
    if (block !== undefined) return stopBlocked(deps, ptyId, block);
    if (duplicateOf !== undefined && (reason !== 'duplicate' || !Number.isInteger(duplicateOf) || duplicateOf < 1)) return refuse('duplicate_of', DUPLICATE_OF_MESSAGE);
    if (reason !== undefined && !deps.canClose(workerTaskId(deps, ptyId) ?? '')) return refuse('cannot_close', CANNOT_CLOSE_MESSAGE);
    const close = reason === undefined ? {} : { close: { type: 'close' as const, reason, ...(duplicateOf === undefined ? {} : { duplicateOf }) } };
    await deps.dispatch({ type: 'stop', ptyId, ...close });
    return reply(OK); // the kill may land before this reaches the worker: the call is its last act
  }));
}

// hive_reply (#591): a session answers a review conversation of its own task, or a local session one of its workspace's local review (#344).
// The worker gives the file and the session, so a thread is looked up only in that file, and only a session the conversation was delivered
// to may answer.
function registerReplyTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_reply', {
    description: 'Answer a review conversation the user opened on your diff or design: pass the thread id the review message named and your answer. Pass resolve: true when the comment is done: the conversation reads resolved by you and stays open until the user confirms it.',
    inputSchema: { thread: z.string(), text: z.string(), resolve: z.boolean().optional() },
  }, async ({ thread, text, resolve }) => recorded(deps, header, 'hive_reply', async () => {
    const ptyId = livePtyId(deps, header);
    const state = deps.live()?.state;
    const worker = ptyId === undefined ? undefined : state?.workers.find((s) => s.runId === ptyId);
    const review = state && worker ? workerReview(deps, state, worker) : undefined;
    if (!worker || !review) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    if (worker.sessionId === undefined) return refuse('no_session', NO_SESSION_MESSAGE);
    const body = text.trim();
    if (body === '' || body.length > REVIEW_TEXT_MAX) return refuse('bad_reply', REPLY_TEXT_MESSAGE);
    const found = (await review.store.read(review.key)).threads.find((t) => t.id === thread);
    if (!found) return refuse('unknown_thread', UNKNOWN_THREAD_MESSAGE);
    if (!found.participants.includes(worker.sessionId)) return refuse('not_participant', NOT_PARTICIPANT_MESSAGE);
    const session = worker.sessionId;
    const message: ReviewMessage = { id: randomUUID(), author: { session }, at: new Date().toISOString(), text: body };
    // One edit: the answer, then the proposal (#111), a later call replacing the mark. The user's resolve wins: appending would reopen it
    let late = false;
    await review.store.update(review.key, (file) => {
      late = resolve === true && file.threads.some((t) => t.id === thread && t.resolved);
      if (late) return file;
      const replied = appendMessage(file, thread, message);
      return resolve === true ? markAgentResolved(replied, thread, session, message.at) : replied;
    });
    if (late) return refuse('thread_resolved', THREAD_RESOLVED_MESSAGE);
    review.notify();
    return reply(OK);
  }));
}

// hive_conventions (#692, #318): the Hive's language, the stage's approval and a fork's PR target, which the plugin's skills read. Any skill may call it; it only reads.
function registerConventionsTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_conventions', {
    description: 'Read the Hive\'s language (hiveLanguage), whether your stage waits for the user\'s approval in the Hive (approval) and the stage\'s name (stage, absent in a free or local session), and, for a fork workspace, fork: where the PRs go (pr: original, fork or ask), the original and fork repositories, the base remote and the base branch. Answers a JSON object.',
    inputSchema: {},
  }, async () => recorded(deps, header, 'hive_conventions', async () => {
    const ptyId = livePtyId(deps, header);
    const current = deps.live();
    const worker = ptyId === undefined ? undefined : current?.state.workers.find((s) => s.runId === ptyId);
    if (!current || !worker) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const fork = await forkConventions(deps.exec, workerWorkspace(current.state, current.config, worker), current.config); // #854
    return reply(JSON.stringify(conventionsAnswer(current.state, current.config, worker, fork)));
  }));
}

/** Who saves or cites a lesson (#797): the workspace the worker's task resolves to, the lesson's origin (the stage only for a stage run) and
 * the ids its records join by. */
interface MemoryCaller { workspace: string; cap: number; origin: { task: string; stage?: string }; correlation: Correlation }

// None for an unknown worker, a local session (no task) or a task whose workspace no longer resolves: the tools answer unknown_worker
function memoryCaller(deps: McpDeps, header: string | undefined): MemoryCaller | undefined {
  const ptyId = livePtyId(deps, header);
  const current = deps.live();
  const worker = ptyId === undefined ? undefined : current?.state.workers.find((s) => s.runId === ptyId);
  const task = current && worker ? taskOfWorker(current.state, worker) : undefined;
  const workspace = current && task ? taskWorkspace(current.config, task) : undefined;
  if (!current || !worker || !task || !workspace) return undefined;
  const stage = worker.freeSession ? {} : { stage: task.stage };
  return { workspace: workspace.name, cap: workspace.memoryCap, origin: { task: task.item.id, ...stage }, correlation: correlationOf(current.state, worker) };
}

const REMEMBER_DESCRIPTION = 'Save a lesson to this workspace\'s memory, which the Hive gives every later run on its tasks. kind: "pref" (how the user wants things done, often learned from a correction), "fact" (a fact about this repository a later task needs) or "avoid" (something that fails or must not be done here). text: one line, at most 300 characters. Never save details of this task only, what the repository already records (its agent instructions, the code, git history), or anything a token or a secret could be in.';
const APPLIED_DESCRIPTION = 'Tell the Hive a lesson of this workspace\'s memory changed what you did: pass its id (m-<n>, as the memory shows it) and why, in one line. Call it each time a lesson makes you act differently, not for lessons you only read.';

// hive_remember (#797): a lesson for every later run on the workspace's tasks. Its records name its kind and id, never its text
function registerRememberTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_remember', {
    description: REMEMBER_DESCRIPTION,
    inputSchema: { kind: z.enum(MEMORY_KINDS), text: z.string() },
  }, async ({ kind, text }) => recorded(deps, header, 'hive_remember', async () => {
    const caller = memoryCaller(deps, header);
    if (!caller) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const refused = lessonRefusal(text);
    if (refused) return refuse(refused.code, refused.message);
    const saved = await deps.memory.update(caller.workspace, (file) => withEntry(file, kind, text, caller.origin, new Date().toISOString(), caller.cap));
    if (isMemoryRefusal(saved)) return refuse(saved.code, saved.message);
    const id = `m-${saved.nextId - 1}`; // withEntry's: the counter it just moved on
    deps.events.write({ event: 'memory.changed', level: 'info', ...caller.correlation, action: 'added', kind, by: 'worker', id, workspace: caller.workspace, ...memoryCounts(saved) });
    return reply(`saved as ${id}`);
  }, { kind }));
}

// hive_applied (#797): the run cites a lesson that changed what it did. A citation is counted on the lesson, never rendered
function registerAppliedTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_applied', {
    description: APPLIED_DESCRIPTION,
    inputSchema: { id: z.string(), why: z.string() },
  }, async ({ id, why }) => recorded(deps, header, 'hive_applied', async () => {
    const caller = memoryCaller(deps, header);
    if (!caller) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const problem = whyProblem(why);
    if (problem) return refuse('bad_memory', problem);
    if (looksLikeSecret(why)) return refuse('memory_secret', MEMORY_SECRET_MESSAGE);
    const lastUsed = { at: new Date().toISOString(), ...caller.origin, why: why.trim() };
    const saved = await deps.memory.update(caller.workspace, (file) => withUse(file, id, lastUsed));
    if (isMemoryRefusal(saved)) return refuse(saved.code, saved.message);
    const lesson = saved.entries.find((e) => e.id === id);
    if (lesson) deps.events.write({ event: 'memory.applied', level: 'info', ...caller.correlation, id, kind: lesson.kind, uses: lesson.uses, workspace: caller.workspace });
    return reply(OK);
  }));
}

/**
 * The workers' MCP server (#99), MCP Streamable HTTP in stateless mode: a server and a transport per request, JSON answers, no session.
 * The worker is the x-hive-pty header of that request. Under /hooks/, so it passes the host guard and needs no UI header.
 */
export function mountMcp(app: Express, deps: McpDeps): void {
  app.post(MCP_ROUTE, async (req: Request, res: Response) => {
    const server = new McpServer(SERVER_INFO);
    const header = req.header('x-hive-pty');
    registerStageTools(server, deps, header);
    registerUserTools(server, deps, header);
    registerStopTool(server, deps, header);
    registerReplyTool(server, deps, header);
    registerConventionsTool(server, deps, header);
    registerRememberTool(server, deps, header); // #797
    registerAppliedTool(server, deps, header);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(HTTP_SERVER_ERROR).json({ jsonrpc: '2.0', error: { code: JSONRPC_INTERNAL_ERROR, message: errorMessage(err) }, id: null });
    }
  });
  // Stateless: no SSE stream to open (GET) and no session to end (DELETE).
  for (const method of ['get', 'delete'] as const) {
    app[method](MCP_ROUTE, (_req: Request, res: Response) => {
      res.status(HTTP_METHOD_NOT_ALLOWED).json({ jsonrpc: '2.0', error: { code: JSONRPC_SERVER_ERROR, message: 'Method not allowed.' }, id: null });
    });
  }
}
