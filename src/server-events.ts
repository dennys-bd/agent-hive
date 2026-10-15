import { correlationOf, deriveEvents, endedStageRuns, prCorrelation, signalRecords, startedRuns, visibleId } from './event-derive.js';
import type { NextFunction, Request, Response } from 'express';
import type { Correlation, EventLog, RecordInput } from './events.js';
import { createHumanSignals, type HumanSignals } from './human-signals.js';
import type { Logger } from './log.js';
import { taskOfActivity } from './activities.js';
import { taskId } from './tasks.js';
import { NO_PR_SEEN, parsePrActivity, prActivityQuery, prActivityRecords, type PrActivity, type PrSeen } from './pull-requests.js';
import type { Effect, Gql, HiveEvent, HookPayload, Signal, SourceItem, State, Worker } from './types.js';
import type { TurnUsage } from './usage.js';

/** The server's side of events.jsonl (#742): what server.ts calls, so it does not grow. The derivation runs after every dispatch, beside
 * describeChanges; the human signals are fed by the hook route and the effects; the rest are facts only the server sees. Every method is
 * isolated: a throw inside one is one error line in hive.log, never a failed dispatch, hook answer, effect or source call. */
export interface ServerEvents {
  readonly events: EventLog; // the writer itself: the MCP handlers and the worktree steps write their own records through it
  afterDispatch(prev: State, next: State, event: HiveEvent): void;
  beforeHook(state: State | undefined, ptyId: string, payload: HookPayload, usage?: TurnUsage): void; // before the hook's dispatch: the worker as it stood
  onEffect(effect: Effect): void; // before the effect runs: a stage spawn's or a copy's prompt is counted as the Hive's own
  typed(ptyId: string): void; // an input effect's text reached the pty: its UserPromptSubmit is the Hive's
  usageSince(ptyId: string): number | undefined; // the open stage run's start: what the turn-end read counts usage from
  prActivity(state: State | undefined, reads: PrActivity[], open?: readonly string[]): void; // pr.checks once per run, pr.commits on a change
  // The PR poll's second query (commits and check runs), after the state query and failure-isolated from it: merge detection never waits on it
  pollPrActivity(state: State | undefined, urls: string[], gql: Gql): Promise<void>;
  // A source write's outcome as source.action (warn when it failed) and a listing's as source.polled (debug) or source.poll_failed (warn): each
  // wraps the call's promise and hands it back settled the same way, so server.ts keeps its own lines
  sourceAction<T>(state: State | undefined, taskId: string, action: string, work: Promise<T>): Promise<T>;
  polled(source: string, listing: Promise<SourceItem[]>): Promise<SourceItem[]>;
  // After the gate: http.error for every 4xx and 5xx, ui.action for every UI write answered 2xx, once per request; state: what :id resolves against
  httpRecords(state: () => State | undefined): (req: Request, res: Response, next: NextFunction) => void;
  booted(startedAt: number): void; // the boot reduced: hive.booted, timed from the server's creation
  quit(state: State, reason: string): void; // close() on a configured Hive: every open wait unresolved, then hive.quit
}

type ErrorLog = Pick<Logger, 'error'>;
const HTTP_ERROR = 400; // a status at or above it is a refusal or a failure
const HTTP_OK = 200;
const HTTP_REDIRECT = 300; // ui.action is 2xx only
// Layout and filter writes (#484): the UI's, but no intervention, and frequent enough to crowd events.jsonl's rotation
const NOT_ACTIONS: readonly string[] = ['/view-state/:key'];
export const HOOKS_PREFIX = '/hooks/';
export const UI_HEADER = 'x-hive-ui'; // every dashboard write carries it; the value is irrelevant
export const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE']; // #591: the review's PUT and DELETE routes too; #315: a version's rename
const UNMATCHED = 'unmatched';

// A recorder's body run so a throw stays here: one line with the method's name and the error's class, never its message (a derivation's
// message can quote state)
function guard<A extends unknown[], R>(log: ErrorLog, name: string, fn: (...args: A) => R, fallback: R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      log.error(`events: ${name} failed (${err instanceof Error ? err.name : typeof err})`);
      return fallback;
    }
  };
}

// The prompts the Hive types itself and knows it sent: a stage spawn's, a copy's notice. An input effect's counts only once its write
// went through (typed). A held Stop's continue is its block reason, not a prompt
function hivePrompt(effect: Effect): string | undefined {
  if (effect.type === 'spawn') return effect.worker.runId;
  return effect.type === 'spawnSession' && effect.copy?.notice !== undefined ? effect.worker.runId : undefined;
}

// The facts of the layers around the reducer: a source's writes and listings, and the HTTP answers
function outsideRecorders(events: EventLog, log: ErrorLog, now: () => number): Pick<ServerEvents, 'sourceAction' | 'polled'> {
  const written = (name: string) => guard(log, name, (record: RecordInput): void => events.write(record), undefined);
  return {
    sourceAction: async (state, id, action, work) => {
      const began = now();
      const task = visibleId(state?.tasks.find((t) => taskId(t) === id));
      const record = (ok: boolean): RecordInput =>
        ({ event: 'source.action', level: ok ? 'info' : 'warn', task_id: id, ...task, action, outcome: ok ? 'ok' : 'failed', latency_ms: now() - began });
      try {
        const result = await work;
        written('sourceAction')(record(true));
        return result;
      } catch (err) {
        written('sourceAction')(record(false));
        throw err;
      }
    },
    polled: async (source, listing) => {
      const began = now();
      try {
        const items = await listing;
        written('polled')({ event: 'source.polled', level: 'debug', source, items: items.length, duration_ms: now() - began });
        return items;
      } catch (err) {
        written('polled')({ event: 'source.poll_failed', level: 'warn', source });
        throw err;
      }
    },
  };
}

// The task and activity a route's :id names (a run's pty id, a task's item id, or an activity's or a record's id), in the state the request
// found: a delete takes it away. Nothing for an id that names none
function idCorrelation(state: State | undefined, id: unknown): Correlation {
  if (state === undefined || typeof id !== 'string') return {};
  const worker = state.workers.find((w) => w.runId === id && w.status !== 'empty');
  if (worker) return correlationOf(state, worker);
  const task = state.tasks.find((t) => taskId(t) === id) ?? taskOfActivity(state, id);
  if (task) return correlationOf(state, undefined, task);
  return state.activities.some((a) => a.id === id) || state.activityRecords.some((r) => r.id === id) ? { activity_id: id } : {};
}

// A write the dashboard made: the gate let a POST, PUT, PATCH or DELETE outside the hooks through only with the UI's header
const isUiWrite = (req: Request): boolean => WRITE_METHODS.includes(req.method) && !req.path.startsWith(HOOKS_PREFIX) && req.header(UI_HEADER) !== undefined;

// The HTTP answers: the route's pattern, never the URL (a path or a query can carry a task's text), and never a body. A request no route
// matched is a probe or a typo, not a refusal of the Hive's: debug. A UI write is a human's action; which ones are intervention is analysis's
function httpRecorder(events: EventLog, log: ErrorLog): ServerEvents['httpRecords'] {
  return (state) => (req, res, next) => {
    const found = guard(log, 'httpRecords', state, undefined)();
    res.on('finish', guard(log, 'httpRecords', (): void => {
      const route: unknown = req.route?.path;
      const matched = typeof route === 'string';
      if (res.statusCode >= HTTP_ERROR) {
        events.write({ event: 'http.error', level: matched ? 'warn' : 'debug', route: matched ? route : UNMATCHED, status: res.statusCode });
        return;
      }
      if (!matched || res.statusCode < HTTP_OK || res.statusCode >= HTTP_REDIRECT || NOT_ACTIONS.includes(route) || !isUiWrite(req)) return;
      events.write({ event: 'ui.action', level: 'info', ...idCorrelation(found, req.params.id), route, method: req.method });
    }, undefined));
    next();
  };
}

// The PR poll's activity: its second query, and the check runs and commit counts already written, in memory like the tracker
function prRecorders(log: ErrorLog, write: Write): Pick<ServerEvents, 'prActivity' | 'pollPrActivity'> {
  let seenPrs: PrSeen = NO_PR_SEEN;
  const prActivity = guard(log, 'prActivity', (state: State | undefined, reads: PrActivity[], open: readonly string[] = reads.map((r) => r.url)): void => {
    const { records, seen } = prActivityRecords(reads, seenPrs, (url) => (state ? prCorrelation(state, url) : {}), open);
    seenPrs = seen;
    write(records);
  }, undefined);
  return {
    prActivity,
    pollPrActivity: async (state, urls, gql) => {
      const query = prActivityQuery(urls);
      if (query === undefined) return;
      try {
        const data = await gql(query);
        prActivity(state, guard(log, 'parsePrActivity', parsePrActivity, [])(urls, data), urls);
      } catch (err) {
        log.error(`pr activity: ${err instanceof Error ? err.message : String(err)}`); // the state query's own line, as it logs its failure
      }
    },
  };
}

// The live runs' ptys: a tracker for any other pty is dropped
const livePtys = (state: State): Set<string> => new Set(state.workers.flatMap((w) => (w.runId !== undefined && w.status !== 'empty' ? [w.runId] : [])));

type Write = (records: readonly RecordInput[]) => void;

// Every wait still open on these ptys, unresolved, before the record that ends them: no human wait vanishes with its run
function flushWaits(signals: HumanSignals, write: Write, state: State, ptyIds: Iterable<string>, at: number): void {
  for (const ptyId of ptyIds) {
    const worker = state.workers.find((w) => w.runId === ptyId && w.status !== 'empty');
    write(signals.flush(ptyId, worker, worker ? correlationOf(state, worker) : {}, at));
  }
}

/** run.spawned's memory fields for a run (#797): the server's, since the derivation is pure and knows no store. */
export type RunFields = (state: State, worker: Worker) => { memory_ids?: string[]; memory_chars?: number; workspace?: string; lsp_servers?: string[] };

// #797: a run.spawned names the workspace memory its launch reads; every other record passes as it is
function withRunFields(record: RecordInput, state: State, fieldsOf: RunFields): RecordInput {
  if (record.event !== 'run.spawned') return record;
  const worker = state.workers[record.worker - 1];
  return worker ? { ...record, ...fieldsOf(state, worker) } : record;
}

// What every dispatch writes. A stage run ends before the next one opens in the same pty: a continue in place reads as ended, then started
function dispatchRecorder(signals: HumanSignals, write: Write, log: ErrorLog, now: () => number, fieldsOf: RunFields): ServerEvents['afterDispatch'] {
  let signal: Signal | undefined; // the last signal.changed written: the clock moves the signal with no state change
  return (prev, next, event) => {
    const at = now();
    // Each step guarded on its own: a throw in one must not skip opening the stage runs that started, or their stage.ended is lost
    const ended = guard(log, 'endedStageRuns', () => endedStageRuns(prev, next, event, at), [])();
    guard(log, 'flush', () => {
      const left = [...livePtys(prev)].filter((id) => !livePtys(next).has(id)); // run.exited and free_session.ended
      flushWaits(signals, write, prev, [...ended.map((e) => e.ptyId), ...left], at);
    }, undefined)();
    guard(log, 'stageEnded', () => {
      for (const end of ended) {
        const record = signals.endStageRun(end, at);
        if (record) write([record]);
      }
    }, undefined)();
    guard(log, 'transitions', () => write(deriveEvents(prev, next, event, at).map((record) => withRunFields(record, next, fieldsOf))), undefined)();
    guard(log, 'signalRecords', () => {
      const signalled = signalRecords(signal, prev, next, at);
      signal = signalled.signal;
      write(signalled.records);
    }, undefined)();
    guard(log, 'openStageRuns', () => {
      for (const run of startedRuns(prev, next, event, at)) signals.openStageRun(run, at);
    }, undefined)();
    guard(log, 'prune', () => signals.prune(livePtys(next)), undefined)();
  };
}

export function createServerEvents(events: EventLog, log: ErrorLog, now: () => number = Date.now, fieldsOf: RunFields = () => ({})): ServerEvents {
  const signals = createHumanSignals();
  const write: Write = (records) => {
    for (const record of records) events.write(record);
  };
  return {
    events,
    afterDispatch: guard(log, 'afterDispatch', dispatchRecorder(signals, write, log, now, fieldsOf), undefined),
    beforeHook: guard(log, 'beforeHook', (state: State | undefined, ptyId: string, payload: HookPayload, usage?: TurnUsage): void => {
      const worker = state?.workers.find((w) => w.runId === ptyId && w.status !== 'empty');
      if (state && worker) write(signals.onHook(ptyId, payload, worker, correlationOf(state, worker), now(), usage));
    }, undefined),
    onEffect: guard(log, 'onEffect', (effect: Effect): void => {
      const ptyId = hivePrompt(effect);
      if (ptyId !== undefined) signals.expectPrompt(ptyId);
    }, undefined),
    typed: guard(log, 'typed', (ptyId: string): void => signals.expectPrompt(ptyId), undefined),
    usageSince: guard(log, 'usageSince', (ptyId: string): number | undefined => signals.usageSince(ptyId), undefined),
    ...prRecorders(log, write),
    ...outsideRecorders(events, log, now),
    httpRecords: httpRecorder(events, log),
    booted: guard(log, 'booted', (startedAt: number): void => events.write({ event: 'hive.booted', level: 'info', duration_ms: now() - startedAt }), undefined),
    quit: guard(log, 'quit', (state: State, reason: string): void => {
      flushWaits(signals, write, state, livePtys(state), now()); // approvals are not flushed: approval.since is in the State and resolves after a restart
      events.write({ event: 'hive.quit', level: 'info', reason });
    }, undefined),
  };
}
