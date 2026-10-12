import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf } from '../src/activities.js';
import { initialState, reduce } from '../src/orchestrator.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { HiveEvent, HookPayload, Item, RateLimits, SourceItem, State, Terminal, Worker } from '../src/types.js';
import { chained } from './fakes.js';
import { withWork, workId } from './fixtures/work.js';

const MINUTE = 60_000;
const ID = 'board:item1';
const SLUG = 'hive-1-task-1';
const WORKTREE = '/tmp/worktrees/hive-1-task-1';
const SESSION = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const CHILD = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';
const SHELL_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const RUN = 'eeeeeeee-0000-4000-8000-000000000001';
const STAGES: LegacyStage[] = [{ name: 'dev', from: { board: ['Backlog'] }, prompt: '/hive-build {url}' }];
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const listed: SourceItem = { item, column: 'Backlog' };
const iso = (ms: number): string => new Date(ms).toISOString();

// Task 1 running dev in the only worker, green
const running = (): State =>
  reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, ...chained(STAGES) }, { type: 'poll', source: 'board', items: [listed] }).state;
const ptyOf = (state: State): string => state.workers.find((w) => w.status !== 'empty')!.runId!;
const workerOf = (state: State, ptyId: string): Worker => state.workers.find((w) => w.runId === ptyId)!;
const hook = (ptyId: string, payload: HookPayload): HiveEvent => ({ type: 'hook', ptyId, payload });
const failed = (state: State, ptyId: string, error: string) => reduce(state, hook(ptyId, { hook_event_name: 'StopFailure', error }));
const withLimits = (state: State, windows: RateLimits['windows']): State => ({ ...state, rateLimits: { at: iso(Date.now()), windows } });
// The retry as it lands: the timer's retryDue, then the prompt it typed and the turn's first tool
const retried = (state: State, ptyId: string): State => {
  const resumed = reduce(state, { type: 'retryDue', ptyId, until: workerOf(state, ptyId).backoff!.until }).state;
  const prompted = reduce(resumed, hook(ptyId, { hook_event_name: 'UserPromptSubmit' })).state;
  return reduce(prompted, hook(ptyId, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' } })).state;
};
// The user's own session on task 1, no stage run (#459)
const freeSession = (): { state: State; ptyId: string } => {
  const polled = reduce({ ...initialState(0), workspaces: ['hive'], syncs: { board: {} }, ...chained(STAGES) }, { type: 'poll', source: 'board', items: [listed] }).state;
  const ready = withWork(polled, ID, { slug: SLUG, worktree: WORKTREE });
  const state = reduce(ready, { type: 'openSession', activityId: workId(ready, ID) }).state;
  return { state, ptyId: state.workers.find((w) => w.freeSession)!.runId! };
};
// A claude the shim captured in the task's terminal (#696)
const captured = (): State => {
  const start = withWork({ ...initialState(1), signal: 'red', workspaces: ['hive'], tasks: [{ item, stage: 'dev', boardColumn: 'Backlog', auto: true }] }, ID, { slug: SLUG, worktree: WORKTREE });
  const terminal: Terminal = { terminalId: SHELL_ID, activityId: workId(start, ID), startedAt: iso(Date.now()), cwd: WORKTREE };
  return reduce({ ...start, terminals: [terminal] }, { type: 'captureSession', terminalId: SHELL_ID, runId: RUN, agent: 'claude', sessionId: SESSION }).state;
};

test('overloaded backs off 1, 2 and 4 minutes, counting each failure across the retries\' own prompt and tool; the fourth stops the stage run with the error and keeps the task out of the fill (#805)', () => {
  let state = running();
  const ptyId = ptyOf(state);
  for (const [n, minutes] of [[1, 1], [2, 2], [3, 4]] as const) {
    const before = Date.now();
    const { state: next, effects } = failed(state, ptyId, 'overloaded');
    const worker = workerOf(next, ptyId);
    assert.deepEqual([worker.status, worker.apiErrors, worker.backoff?.error, worker.lastEvent, worker.question, effects], ['backoff', n, 'overloaded', { kind: 'apiError', detail: 'overloaded' }, undefined, []], `failure ${n}`);
    const until = Date.parse(worker.backoff!.until);
    assert.ok(until >= before + minutes * MINUTE && until <= Date.now() + minutes * MINUTE, `failure ${n} waits ${minutes} min`);
    state = retried(next, ptyId);
    const back = workerOf(state, ptyId);
    assert.deepEqual([back.status, back.apiErrors, 'backoff' in back], ['working', n, false], `retry ${n}: back at work, the count kept`);
  }
  const { state: stopped, effects } = failed(state, ptyId, 'overloaded');
  assert.deepEqual(effects.flatMap((e) => (e.type === 'kill' ? [e.ptyId] : [])), [ptyId], 'the stage run is killed');
  const activity = activityOf(stopped, ID)!;
  assert.deepEqual([activity.error, activity.stopped], ['API error: overloaded (3 retries)', true]);
  const worker = workerOf(stopped, ptyId);
  assert.deepEqual(['apiErrors' in worker, 'backoff' in worker, worker.lastEvent], [false, false, { kind: 'apiError', detail: 'overloaded' }]);
  const freed = reduce(stopped, { type: 'exit', ptyId }).state;
  assert.deepEqual(reduce(freed, { type: 'poll', source: 'board', items: [listed] }).effects.filter((e) => e.type === 'spawn'), [], 'the error keeps it out of the fill');
});

test('a Stop, a turn that ended well, resets the count: the next overloaded waits 1 minute again (#805)', () => {
  const start = running();
  const ptyId = ptyOf(start);
  const twice = retried(failed(retried(failed(start, ptyId, 'overloaded').state, ptyId), ptyId, 'overloaded').state, ptyId);
  assert.equal(workerOf(twice, ptyId).apiErrors, 2);
  const ended = reduce(twice, hook(ptyId, { hook_event_name: 'Stop' })).state;
  assert.equal('apiErrors' in workerOf(ended, ptyId), false);
  const before = Date.now();
  const again = workerOf(failed(ended, ptyId, 'overloaded').state, ptyId);
  assert.equal(again.apiErrors, 1);
  assert.ok(Date.parse(again.backoff!.until) >= before + MINUTE && Date.parse(again.backoff!.until) <= Date.now() + MINUTE);
});

test('a StopFailure after hive_done is that run\'s Stop: the stage ends as its Stop would end it, with no wait, no count and no error (#805)', () => {
  const start = running();
  const ptyId = ptyOf(start);
  const done = reduce(start, { type: 'done', ptyId }).state;
  const viaStop = reduce(done, hook(ptyId, { hook_event_name: 'Stop' }));
  const viaFailure = failed(done, ptyId, 'overloaded');
  assert.deepEqual(viaFailure.effects.map((e) => e.type), viaStop.effects.map((e) => e.type), 'the same kill and source writes');
  assert.deepEqual(viaFailure.state.tasks.map((c) => c.stage), viaStop.state.tasks.map((c) => c.stage), 'the task moved on the same way');
  assert.equal(viaFailure.state.workers.some((w) => w.status === 'backoff' || w.apiErrors !== undefined), false);
  assert.equal(activityOf(viaFailure.state, ID)?.error, undefined, 'no error on the task');
});

test('authentication_failed and a class that is no snake_case word stop the stage run at once, with no wait and no count (#805)', () => {
  for (const [error, shown] of [['authentication_failed', 'authentication_failed'], ['Overloaded!', 'unknown'], ['', 'unknown']] as const) {
    const start = running();
    const ptyId = ptyOf(start);
    const { state, effects } = failed(start, ptyId, error);
    assert.ok(effects.some((e) => e.type === 'kill'), error);
    assert.equal(activityOf(state, ID)?.error, `API error: ${shown}`, error);
    assert.deepEqual([workerOf(state, ptyId).status, 'apiErrors' in workerOf(state, ptyId)], ['working', false], `${error}: freed on its exit`);
  }
});

test('rate_limit waits for the latest exhausted window to reset plus a minute, counting nothing; past rateLimitWaitMinutes it stops with the ceiling\'s text (#805)', () => {
  const start = running();
  const ptyId = ptyOf(start);
  const reset = Date.now() + 120 * MINUTE;
  const windows = {
    five_hour: { usedPercent: 100, resetsAt: iso(reset) }, seven_day: { usedPercent: 100, resetsAt: iso(reset - MINUTE) },
    seven_day_opus: { usedPercent: 60, resetsAt: iso(reset + 60 * MINUTE) },
  };
  const worker = workerOf(failed(withLimits(start, windows), ptyId, 'rate_limit').state, ptyId);
  assert.deepEqual([worker.status, worker.backoff, 'apiErrors' in worker], ['backoff', { error: 'rate_limit', until: iso(reset + MINUTE) }, false]);
  const { state } = failed({ ...withLimits(start, windows), rateLimitWaitMinutes: 60 }, ptyId, 'rate_limit');
  assert.equal(activityOf(state, ID)?.error, 'API error: rate_limit (rate limit resets in more than 60 min)');
});

test('rate_limit with no exhausted window, or only one whose reset has passed, takes the 1-minute schedule and counts (#805)', () => {
  const start = running();
  const ptyId = ptyOf(start);
  const cases: RateLimits['windows'][] = [{}, { five_hour: { usedPercent: 80, resetsAt: iso(Date.now() + 60 * MINUTE) } }, { five_hour: { usedPercent: 100, resetsAt: iso(Date.now() - MINUTE) } }];
  for (const windows of cases) {
    const before = Date.now();
    const worker = workerOf(failed(withLimits(start, windows), ptyId, 'rate_limit').state, ptyId);
    assert.equal(worker.apiErrors, 1, JSON.stringify(windows));
    assert.ok(Date.parse(worker.backoff!.until) >= before + MINUTE && Date.parse(worker.backoff!.until) <= Date.now() + MINUTE);
  }
});

test('a free session backs off too; on its error path it waits for the user with the text as its question and nothing is killed (#805)', () => {
  const { state: start, ptyId } = freeSession();
  assert.equal(workerOf(failed(start, ptyId, 'overloaded').state, ptyId).status, 'backoff');
  const { state, effects } = failed(start, ptyId, 'billing_error');
  const worker = workerOf(state, ptyId);
  assert.deepEqual([worker.status, worker.question, worker.lastEvent, effects], ['waiting', 'API error: billing_error', { kind: 'apiError', detail: 'billing_error' }, []]);
  assert.equal(activityOf(state, ID)?.error, undefined, 'no task is stopped');
});

test('a captured session gives up at once, even on a transient class: its claude runs in the terminal\'s pty, which the retry cannot reach (#805)', () => {
  const start = captured();
  for (const error of ['overloaded', 'authentication_failed']) {
    const { state, effects } = failed(start, RUN, error);
    const worker = workerOf(state, RUN);
    assert.deepEqual([worker.status, worker.question, effects], ['waiting', `API error: ${error}`, []], error);
  }
});

test('retryDue with the wait\'s own until resumes the run and types continue into it; a stale until, or a run the user resumed first, changes nothing (#805)', () => {
  const start = running();
  const ptyId = ptyOf(start);
  const waiting = failed(start, ptyId, 'overloaded').state;
  const { until } = workerOf(waiting, ptyId).backoff!;
  const { state, effects } = reduce(waiting, { type: 'retryDue', ptyId, until });
  const worker = workerOf(state, ptyId);
  assert.deepEqual([worker.status, worker.lastEvent, worker.apiErrors, 'backoff' in worker], ['working', { kind: 'continuing' }, 1, false]);
  assert.deepEqual(effects, [{ type: 'input', ptyId, text: 'continue' }]);
  assert.equal(reduce(waiting, { type: 'retryDue', ptyId, until: iso(Date.parse(until) + 1) }).state, waiting, 'a stale until');
  const resumed = reduce(waiting, hook(ptyId, { hook_event_name: 'UserPromptSubmit' })).state;
  assert.deepEqual([workerOf(resumed, ptyId).status, workerOf(resumed, ptyId).apiErrors], ['working', 1], 'the user\'s prompt ends the wait, not the count');
  assert.equal(reduce(resumed, { type: 'retryDue', ptyId, until }).state, resumed, 'the user resumed it first');
});

test('a subagent\'s or a teammate\'s StopFailure is skipped, as its Stop is (#24, #805)', () => {
  const start = running();
  const ptyId = ptyOf(start);
  const started = reduce(start, hook(ptyId, { hook_event_name: 'SessionStart', session_id: SESSION })).state;
  assert.equal(reduce(started, hook(ptyId, { hook_event_name: 'StopFailure', error: 'overloaded', session_id: CHILD })).state, started);
});
