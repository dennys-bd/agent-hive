import { createHash } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createAppender, generations, type Logger, type LoggerOptions, type LogLevel, passes, type RecordLevel, shortId, UNSAFE_CHARS } from './log.js';
import type { AgentId, MemoryKind, MemoryRefusalCode, Signal } from './types.js';

// facts.jsonl (#742): the fact log, one JSON object per line beside hive.log, for statistics over the Hive's facts. Never a prompt, an output, a title, a
// path, a link, an account or a token: a user's or an agent's text only as its length and the head of its sha256.

export const FACTS_FILE = 'facts.jsonl';
export const SCHEMA_VERSION = 1;
export const RAW_TEXT_MAX = 100; // characters of a raw outside text a record carries: a check's name, a hook's tool, a source's name
const HASH_CHARS = 16;
export const LIST_MAX = 50; // items of a list a record carries: a run's models, a result's keys; a run's models by name (#271)

export type RunKind = 'spawn' | 'restart' | 'continue' | 'feedback';
// source: the poll moved it because its column changed in the source; auto: the flow itself (hive_done and its Stop)
export type MoveBy = 'auto' | 'hand' | 'approval' | 'merge' | 'on_finish' | 'source';
export type GoneReason = 'finished' | 'missing' | 'hand';
// The onFinish mechanism that took a finished task out: a leaving action's type, an onFinish move past the last stage, or no source action
export type FinishVia = 'move' | 'archive' | 'remove' | 'delete' | 'none';
// stop: the user's; agent_stop: a stop with no cause, hive_stop's or a command's timeout
export type StageOutcome = 'done' | 'approval' | 'stop' | 'agent_stop' | 'killed' | 'failed' | 'exit';
export type RefusalCode = 'unknown_worker' | 'bad_result' | 'bad_verdict' | 'bad_url' | 'bad_question' | 'duplicate_of' | 'cannot_close' | 'no_session'
  | 'bad_reply' | 'unknown_thread' | 'not_participant' | 'thread_resolved' | 'event' | 'block_with_reason' | 'cannot_block' | 'not_blocked' | 'block_refused' | 'no_transition'
  | MemoryRefusalCode; // #797: hive_remember's and hive_applied's
export type StepKind = 'COPY' | 'RUN' | 'LOAD' | 'DEL';

/** What joins a record to the rest (#742): each present only when it applies. session_id is Claude Code's, so its transcript joins by it.
 * task_id is the item id (`<source>:<adapter id>`); task, beside it, the id the user sees (an issue number, a Jira key). */
export interface Correlation {
  task_id?: string; task?: string; activity_id?: string; stage?: string; session_id?: string; attempt?: number; run_kind?: RunKind;
}
export interface Tokens { input: number; output: number; cache_write: number; cache_read: number }
export interface TextRef { chars: number; sha256: string }

/** A run's usage as stage.ended and free_session.ended carry it (#271): its tokens, its subagents' share, its models, and its tokens per model
 * (`unknown` for a response that named none), so any row can be priced later with any price table. */
export interface RunUsage { tokens: Tokens; subagent_tokens: Tokens; models: string[]; tokens_by_model: Record<string, Tokens> }
interface Timed { duration_ms: number }
interface Gone { reason: GoneReason; via?: FinishVia } // via: on finished only

/** Each event's own fields (#742), by name: what `write` checks a record against, so a misspelled field fails tsc. */
export interface FactFields {
  // unresolved: the wait was still open when its stage run ended, its run exited or the Hive quit
  'question.answered': Timed & { kind: 'ask' | 'elicitation'; outcome: 'answered' | 'unresolved' };
  'permission.answered': Timed & { outcome: 'granted' | 'denied' | 'unresolved'; tool: string };
  'run.takeover': Timed & { outcome: 'ended' | 'unresolved' };
  'approval.granted': Timed;
  'approval.rejected': Timed & TextRef & { start: boolean };
  'approval.extended': Timed;
  'approval.expired': Timed;
  'run.stopped': Timed;
  'run.restarted': Timed;
  // #271: worker, the slot it ran in as run.spawned's, joins it to its tracker; agent: what it ran; the usage: its last turn end's, from its own
  // start, which the server adds (absent only for a run no tracker opened)
  'free_session.ended': Timed & { worker: number; agent?: AgentId } & Partial<RunUsage>;
  'terminal.ended': Timed & { command?: string }; // command: the Command's name when it ran one, never its line
  'task.discovered': { source: string; source_created_at?: string };
  'task.moved': { from: string; to: string; by: MoveBy };
  'task.closed': Gone;
  'task.deleted': Gone;
  // #797: the workspace memory its launch got, only when non-empty. memory_chars: the rendered section's length, what the run received
  // lsp_servers (#803): the entries of its workspace's language-server plugin, [] for none; the server's, so the derivation never sets it
  'run.spawned': { worker: number; model?: string; memory_ids?: string[]; memory_chars?: number; workspace?: string; lsp_servers?: string[] };
  'run.started': { spawn_latency_ms: number };
  'run.spawn_failed': { code: string }; // fact-derive's closed set, never the message
  'run.exited': Timed;
  // #805: failure is the failure's number when it counts one (never the stage run's attempt, a correlation field); wait_ms on a backoff
  'run.api_error': { error: string; action: 'backoff' | 'stopped'; failure?: number; wait_ms?: number };
  'stage.started': Record<never, never>;
  // tokens: the stage run's own, its subagents' included; subagent_tokens: their share. agent (#271): what the run ran, absent on a commands stage's
  'stage.ended': Timed & RunUsage & { agent?: AgentId; outcome: StageOutcome; waited_ms: number; tool_counts: Record<string, number> };
  // error: the handler threw. result_keys: an accepted hive_done's safe-shaped keys, at most 20; result_keys_dropped: how many were left out; kind: hive_remember's lesson kind (#797), never its text
  'mcp.call': { tool: string; outcome: 'ok' | 'refused' | 'error'; reason?: RefusalCode; latency_ms: number; result_keys?: string[]; result_keys_dropped?: number; kind?: MemoryKind };
  // #797: a lesson saved, edited or removed, and a run citing one. Never a lesson's text or a why. used: the sum of the texts, as the cap counts
  'memory.changed': { action: 'added' | 'edited' | 'removed'; kind: MemoryKind; by: 'worker' | 'user'; id: string; entries: number; used: number; workspace: string };
  'memory.applied': { id: string; kind: MemoryKind; uses: number; workspace: string };
  'pr.opened': { pr: number };
  'pr.state': { pr: number; state: 'merged' | 'closed'; since_opened_ms?: number; since_stage_started_ms?: number };
  'pr.commit': { pr: number; sha: string; committed_at: string }; // one per commit newly seen on the PR: sha 8 chars, GitHub's committedDate
  'pr.commits': { pr: number; count: number; after_open?: number }; // after_open: absent when GitHub gave no creation time
  'pr.checks': { pr: number; sha: string; check_run_id: number; name: string; conclusion: string; duration_ms?: number };
  'ci.ended': Timed & { verdict: 'passed' | 'failed' }; // #834: a wait for CI ended with a verdict; duration_ms from the stage's start
  'ci.fallback': Record<never, never>; // #834: a required wait read a base branch with no required checks: every check counts
  'workers.changed': { active: number; max: number };
  'signal.changed': { from: Signal; to: Signal; rule?: string; usage_percent?: number };
  'source.action': { action: string; outcome: 'ok' | 'failed'; latency_ms: number };
  'source.polled': Timed & { source: string; items: number };
  'source.poll_failed': { source: string };
  'worktree.step': Timed & { phase: 'setup' | 'teardown'; index: number; kind: StepKind; outcome: 'ok' | 'failed' };
  'http.error': { route: string; status: number };
  'ui.action': { route: string; method: string }; // a UI write answered 2xx: the route's pattern, never the URL nor the body
  'hive.booted': Timed;
  'hive.quit': { reason: string };
  'hive.crash_recovered': { workers: number };
}

export type FactName = keyof FactFields;
/** What a caller writes (#742): the event, its level, its correlation and its own fields; the writer stamps schema_version and ts. */
export type RecordInput = { [E in FactName]: { event: E; level: RecordLevel } & Correlation & FactFields[E] }[FactName];
/** A line of facts.jsonl. */
export type FactRecord = RecordInput & { schema_version: typeof SCHEMA_VERSION; ts: string };

export interface FactLog {
  write(record: RecordInput): void;
  setLevel(level: LogLevel): void;
}

export interface FactLogOptions extends LoggerOptions {
  log: Pick<Logger, 'record'>; // where each record's text line goes: hive.log stays the file humans read
  keep?: (record: FactRecord) => void; // #271: the usage store's write; it gets every record, whatever the level, and keeps its own events
}

export const ZERO_TOKENS: Tokens = { input: 0, output: 0, cache_write: 0, cache_read: 0 };

/** A raw outside text as a record carries it (#742): one line, no control, separator or bidi character, at most RAW_TEXT_MAX characters. */
export const rawText = (text: string): string => text.replace(UNSAFE_CHARS, ' ').slice(0, RAW_TEXT_MAX);

/** A user's or an agent's text as a reference (#742): its length and the first 16 hex characters of its sha256, so repeats show without it. */
export const textRef = (text: string): TextRef => ({ chars: text.length, sha256: createHash('sha256').update(text).digest('hex').slice(0, HASH_CHARS) });

// Every string the record holds, a list's too, cut and kept on one line; a list cut to LIST_MAX items; an undefined field left out
function bounded(record: RecordInput): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).flatMap(([key, value]): [string, unknown][] => {
    if (value === undefined) return [];
    if (typeof value === 'string') return [[key, rawText(value)]];
    if (Array.isArray(value)) return [[key, value.slice(0, LIST_MAX).map((v: unknown) => (typeof v === 'string' ? rawText(v) : v))]];
    return [[key, value]];
  }));
}

const SHORT_IDS: readonly string[] = ['activity_id', 'session_id'];
// The facts hive.log already writes in a richer line of its own (server.ts: the effect's `ok` with its column, fail()'s error, the poll's
// count): mirroring them would write the same fact twice
const OWN_LINE: readonly FactName[] = ['source.action', 'source.polled', 'source.poll_failed'];
const HIDDEN: readonly string[] = ['schema_version', 'ts', 'level', 'event'];

/** A record's hive.log line (#742): the event, then key=value; the uuids through shortId, a list joined, an object as JSON. */
export function describeRecord(record: Record<string, unknown>): string {
  const pairs = Object.entries(record).filter(([key, value]) => !HIDDEN.includes(key) && value !== undefined).map(([key, value]) => {
    if (SHORT_IDS.includes(key)) return `${key}=${shortId(String(value))}`;
    if (Array.isArray(value)) return `${key}=${value.join(',')}`;
    return `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
  });
  return [String(record.event), ...pairs].join(' ');
}

/** facts.jsonl in `dir` (#742), the same shape as createLogger: sync appends, one rotation at maxBytes, a broken disk disables the file with
 * one stderr line and never throws. A record under the level reaches neither file; error always passes. `keep` (#271) gets every record,
 * stamped and bounded as its line is, under any level and with the file disabled. */
export function createFactLog(dir: string, level: LogLevel, options: FactLogOptions): FactLog {
  const { log, keep, ...fileOptions } = options;
  const append = createAppender(dir, FACTS_FILE, fileOptions);
  let current = level;
  return {
    write: (record) => {
      // #271: stamped and bounded above the level check, so the usage store keeps exactly the record the line holds, under any level
      const fields = bounded(record);
      const line = { schema_version: SCHEMA_VERSION, ts: new Date().toISOString(), ...fields };
      if (passes(record.level, current)) {
        append(`${JSON.stringify(line)}\n`);
        if (!OWN_LINE.includes(record.event)) log.record(record.level, describeRecord(fields)); // never error's stderr echo: its failure had its own
      }
      keep?.(line as FactRecord); // bounded keeps each field's type: a string stays a string, a list a list
    },
    setLevel: (next) => {
      current = next;
    },
  };
}

/** Before #93 the fact log was events.jsonl: each of its generations moves to the same generation of facts.jsonl, before the usage store's
 * first import reads them and before the writer appends. A target already there is never overwritten, and its source is left as it is. Never
 * throws: a rename that fails is one hive.log line, never a failed boot. */
export function moveEventsFiles(home: string, log: Pick<Logger, 'error'>): void {
  for (const to of generations(FACTS_FILE)) {
    const from = `events.jsonl${to.slice(FACTS_FILE.length)}`; // the same generation: '' or '.<n>'
    if (!existsSync(join(home, from)) || existsSync(join(home, to))) continue;
    try {
      renameSync(join(home, from), join(home, to));
    } catch (err) {
      log.error(`facts: ${from} not moved to ${to} (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`); // the code only: the message holds the home path
    }
  }
}
