// The answer and record helpers every tool module shares, out of mcp.ts for #333 so the optional tools can live apart.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { correlationOf } from './fact-derive.js';
import type { FactLog, RecordInput, RefusalCode } from './facts.js';
import type { MemoryStore } from './memory.js';
import type { ReplyReviews } from './mcp-review.js';
import type { RelateOutcome } from './server-blockers.js';
import type { BlockerChange, Config, Effect, Exec, HiveEvent, MemoryKind, Source, State } from './types.js';

export const OK = 'ok';
export const UNKNOWN_WORKER_MESSAGE = 'unknown worker';

/** What the tools read and do: the live state with the config (undefined while the Hive has no config), and the server's dispatch. The
 * review files hive_reply answers in come with ReplyReviews (#591, #344). */
export interface McpDeps extends ReplyReviews {
  live(): { state: State; config: Config; sources: ReadonlyMap<string, Pick<Source, 'create' | 'comments'>> } | undefined; // hive_task's comments (#7); config: the Comb's prefix and createIn (hive_create_task), the Hive's language and a fork's base (hive_conventions)
  poll(names: string[], manual?: string[]): Promise<void>; // #846: hive_create_task on a source polls it through the route's own path
  dispatch(event: HiveEvent): Promise<Effect[]>;
  canClose(itemId: string): boolean; // hive_stop's reason (#314): whether the task's source can close its item
  relate(itemId: string, change: BlockerChange): Promise<RelateOutcome>; // hive_stop's block (#294): the blockers route's own write, relateItem
  canRelate(itemId: string): boolean; // hive_stop's block (#294): a hive task, or a task whose source relates
  facts: Pick<FactLog, 'write'>; // #742: each tool call's mcp.call
  memory: Pick<MemoryStore, 'read' | 'update'>; // #797: hive_remember and hive_applied write the worker's workspace's memory
  preloadPr?(url: string): Promise<void>; // #497: hive_pr's PR read and stored ahead of its page; never awaited
  exec: Exec; // #854: the remotes behind a fork's hive_conventions
}

// A refusal's code rides on a symbol key (#742): JSON drops symbol keys, so the agent reads only the text, exactly as before
const REFUSAL = Symbol('refusal');
export type Answer = CallToolResult & { [REFUSAL]?: RefusalCode };
export const reply = (text: string): Answer => ({ content: [{ type: 'text', text }] });
export const refuse = (code: RefusalCode, text: string): Answer => ({ content: [{ type: 'text', text }], isError: true, [REFUSAL]: code });
// The header's worker, only while it holds a worker: a stale session or a forged call gets the tool error and touches nothing.
export function livePtyId(deps: Pick<McpDeps, 'live'>, ptyId: string | undefined): string | undefined {
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
export async function recorded(deps: Pick<McpDeps, 'live' | 'facts'>, header: string | undefined, tool: string, call: () => Promise<Answer>, facts: CallFacts = {}): Promise<CallToolResult> {
  const began = Date.now();
  const state = deps.live()?.state;
  const worker = state?.workers.find((s) => s.runId === header && s.status !== 'empty');
  const ids = state && worker ? correlationOf(state, worker) : {};
  const kind = facts.kind === undefined ? {} : { kind: facts.kind };
  const written = (fields: Pick<Extract<RecordInput, { event: 'mcp.call' }>, 'level' | 'outcome' | 'reason' | 'result_keys' | 'result_keys_dropped'>): void =>
    deps.facts.write({ event: 'mcp.call', ...ids, tool, latency_ms: Date.now() - began, ...kind, ...fields });
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
