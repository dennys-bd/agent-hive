import { taskOfWorker } from './activities.js';
import { ranAgent } from './agents.js';
import { liveWorker, none, patch, type Reduced, withError } from './reducer-kit.js';
import { stop } from './runs.js';
import type { HookPayload, RateLimits, State, Worker, WorkerEvent } from './types.js';

// A turn that ended on an API error (#805): Claude Code's StopFailure, which fires instead of Stop and leaves the run at its prompt. A wait
// alone fixes a transient class and a plan window reopens at its reset; anything else needs the user. Pure, like every reducer rule.

export const BACKOFF_RETRIES = 3;
export const BACKOFF_WAITS_MS: readonly number[] = [60_000, 120_000, 240_000];
export const RATE_LIMIT_MARGIN_MS = 60_000;
export const TRANSIENT_ERRORS: readonly string[] = ['overloaded', 'server_error'];
export const RETRY_TEXT = 'continue'; // what a user would type: Claude Code resumes the same work
const RATE_LIMIT = 'rate_limit';
const UNKNOWN = 'unknown';
const FULL_PERCENT = 100;
const MINUTE_MS = 60_000;
// Claude Code's classes are snake_case words; any other value came from another local process and is never shown as it is
const ERROR_CLASS = /^[a-z_]{1,64}$/;

/** One failure's outcome: wait until `until` (epoch ms), or stop with `text`. `failure` is its number when it counts one. */
export type StopFailureDecision =
  | { action: 'backoff'; error: string; until: number; failure?: number }
  | { action: 'stopped'; error: string; text: string; failure?: number };

/** The payload's error class (#805): Claude Code's word, else unknown. */
export const apiErrorOf = (payload: HookPayload): string =>
  typeof payload.error === 'string' && ERROR_CLASS.test(payload.error) ? payload.error : UNKNOWN;

const errorText = (error: string): string => `API error: ${error}`;

// The latest reset among the used-up plan windows whose reset is still ahead; undefined with none
function exhaustedReset(limits: RateLimits | undefined, now: number): number | undefined {
  const resets = Object.values(limits?.windows ?? {})
    .filter((window) => window.usedPercent >= FULL_PERCENT)
    .map((window) => Date.parse(window.resetsAt))
    .filter((at) => at > now);
  return resets.length === 0 ? undefined : Math.max(...resets);
}

// A plan window's wait counts no failure; past the user's ceiling the run stops instead
function rateLimitWait(state: State, reset: number, now: number): StopFailureDecision {
  const until = reset + RATE_LIMIT_MARGIN_MS;
  if (until - now <= state.rateLimitWaitMinutes * MINUTE_MS) return { action: 'backoff', error: RATE_LIMIT, until };
  return { action: 'stopped', error: RATE_LIMIT, text: `${errorText(RATE_LIMIT)} (rate limit resets in more than ${state.rateLimitWaitMinutes} min)` };
}

// The schedule alone: a rate limit with a window to wait for, a transient class (a rate limit with none included) until its retries run out
function scheduled(state: State, worker: Worker, error: string, now: number): StopFailureDecision {
  const reset = error === RATE_LIMIT ? exhaustedReset(state.rateLimits?.[ranAgent(worker)], now) : undefined; // #929: the failing run's own agent's window
  if (reset !== undefined) return rateLimitWait(state, reset, now);
  if (error !== RATE_LIMIT && !TRANSIENT_ERRORS.includes(error)) return { action: 'stopped', error, text: errorText(error) };
  const failure = (worker.apiErrors ?? 0) + 1;
  if (failure > BACKOFF_RETRIES) return { action: 'stopped', error, text: `${errorText(error)} (${BACKOFF_RETRIES} retries)`, failure };
  return { action: 'backoff', error, until: now + BACKOFF_WAITS_MS[failure - 1], failure };
}

/** The decision for one StopFailure of `worker` (#805). A captured session's claude runs in a terminal's pty (#696), which the retry's input
 * cannot reach by its run id: it gives up at once. Never asked for a worker that called hive_done: that failure is the run's Stop
 * (applyHook). event-derive asks it again for run.api_error. */
export function decideStopFailure(state: State, worker: Worker, error: string, now: number): StopFailureDecision {
  const decision = scheduled(state, worker, error, now);
  return decision.action === 'backoff' && worker.terminalId !== undefined ? { action: 'stopped', error, text: errorText(error) } : decision;
}

// The wait goes, and the count too unless `keepCount`; a worker with neither is left as it is, so no empty key lands on it
function dropWait(state: State, ptyId: string, keepCount: boolean): State {
  const live = state.workers.find((w) => w.runId === ptyId);
  if (!live || (live.backoff === undefined && (keepCount || live.apiErrors === undefined))) return state;
  const { backoff: _backoff, apiErrors, ...rest } = live;
  const kept: Worker = keepCount && apiErrors !== undefined ? { ...rest, apiErrors } : rest;
  return { ...state, workers: state.workers.map((w) => (w === live ? kept : w)) };
}

/** What a hook ends of a wait (#805): a Stop, a turn that ended well, ends the wait and the count; a prompt or a tool, the user's or the
 * retry's own, only the wait, so failures with no good turn between them still add up. */
export function settleWait(state: State, ptyId: string, hook: string): State {
  if (hook === 'Stop') return dropWait(state, ptyId, false);
  return hook === 'UserPromptSubmit' || hook === 'PreToolUse' ? dropWait(state, ptyId, true) : state;
}

// The run gives up. A stage run is stopped as the user's stop does, its task carrying the text, which keeps it out of the fill until a
// manual start; the exit frees the worker. A free, local or captured session is the user's own: it waits for them, nothing killed.
function giveUp(state: State, ptyId: string, worker: Worker, lastEvent: WorkerEvent, text: string): Reduced {
  const task = taskOfWorker(state, worker);
  if (!task || worker.freeSession || worker.terminalId !== undefined) {
    return none(dropWait(patch(state, ptyId, { status: 'waiting', question: text, lastEvent }).state, ptyId, false));
  }
  const stopped = stop(state, ptyId);
  const marked = withError(stopped.state, task, text);
  return { state: dropWait(patch(marked, ptyId, { lastEvent }).state, ptyId, false), effects: stopped.effects };
}

/** A StopFailure (#805) of a worker that has not called hive_done: the run waits for its retry with status backoff, or gives up. */
export function stopFailure(state: State, ptyId: string, worker: Worker, payload: HookPayload, now: number): Reduced {
  const error = apiErrorOf(payload);
  const lastEvent: WorkerEvent = { kind: 'apiError', detail: error };
  const decision = decideStopFailure(state, worker, error, now);
  if (decision.action === 'stopped') return giveUp(state, ptyId, worker, lastEvent, decision.text);
  const counted = decision.failure === undefined ? {} : { apiErrors: decision.failure };
  return patch(state, ptyId, { status: 'backoff', question: undefined, lastEvent, backoff: { error, until: new Date(decision.until).toISOString() }, ...counted });
}

/** The server's timer for a wait (#805): the run goes back to work and the Hive types continue into it, its count kept. Only for the wait that
 * set this very `until`: a newer wait, a run the user resumed or one gone changes nothing. */
export function retryDue(state: State, ptyId: string, until: string): Reduced {
  const worker = liveWorker(state, ptyId);
  if (worker?.status !== 'backoff' || worker.backoff?.until !== until) return none(state);
  const resumed = patch(dropWait(state, ptyId, true), ptyId, { status: 'working', lastEvent: { kind: 'continuing' } }).state;
  return { state: resumed, effects: [{ type: 'input', ptyId, text: RETRY_TEXT }] };
}
