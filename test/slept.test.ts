import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localActivityId } from '../src/activities.js';
import { initialState, reduce } from '../src/orchestrator.js';
import type { LegacyStage } from '../src/config-migrate.js';
import { type Item, SLEPT_MAX, type SleptRun, type State } from '../src/types.js';
import { chained } from './fakes.js';

// Three stages, the prompt ones each a new session: a finished spec run is killed, never continued in place, and its task stays in the Hive
const STAGES: LegacyStage[] = [
  { name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive-spec {url}', session: 'new' },
  { name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}', session: 'new' },
  { name: 'review', from: { board: ['In review'] } },
];
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
const HOUR_MS = 3_600_000;
const item: Item = { itemId: 'board:item1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const base = (): State => ({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, ...chained(STAGES) });
const without = ({ at: _at, ...rest }: SleptRun) => rest;

// Task 1's spec run with its SessionStart seen: a run whose session is kept
function running(): { state: State; ptyId: string } {
  const polled = reduce(base(), { type: 'poll', source: 'board', items: [{ item, column: 'Backlog' }] }).state;
  const ptyId = polled.workers[0].runId ?? '';
  const seen = reduce(polled, { type: 'hook', ptyId, payload: { hook_event_name: 'SessionStart', session_id: SESSION, cwd: '/wt/hive-1-task-1' }, branch: 'hive/1-task-1' }).state;
  return { state: seen, ptyId };
}

test('a stop with a cause marks the worker ending, and its exit records the run as sleeping with that cause, its task and its stage (#672)', () => {
  const { state, ptyId } = running();
  for (const cause of ['manual', 'all'] as const) {
    const stopped = reduce(state, { type: 'stop', ptyId, cause }).state;
    assert.equal(stopped.workers.find((w) => w.runId === ptyId)?.ending, cause);
    const exited = reduce(stopped, { type: 'exit', ptyId }).state;
    assert.deepEqual(exited.slept?.map(without), [{ ptyId, sessionId: SESSION, agent: 'claude', kind: 'stage', taskId: 'board:item1', stage: 'spec', cause }]);
  }
});

test('an exit with no cause records the run with none, and a /exit\'s SessionEnd records it once (#672)', () => {
  const { state, ptyId } = running();
  const exited = reduce(state, { type: 'exit', ptyId }).state;
  assert.equal(exited.slept?.length, 1);
  assert.equal('cause' in (exited.slept?.[0] ?? {}), false);
  const ended = reduce(state, { type: 'hook', ptyId, payload: { hook_event_name: 'SessionEnd', session_id: SESSION } }).state;
  assert.equal(ended.slept?.length, 1, 'SessionEnd frees the worker');
  assert.equal(reduce(ended, { type: 'exit', ptyId }).state.slept?.length, 1, 'the process exit after it finds no live worker');
});

test('a failed spawn and a run that never saw a hook record nothing (#672)', () => {
  const { state, ptyId } = running();
  assert.deepEqual(reduce(state, { type: 'spawnFailed', ptyId, message: 'pty: boom' }).state.slept ?? [], []);
  const polled = reduce(base(), { type: 'poll', source: 'board', items: [{ item, column: 'Backlog' }] }).state;
  const fresh = polled.workers[0].runId ?? '';
  assert.deepEqual(reduce(polled, { type: 'exit', ptyId: fresh }).state.slept ?? [], []);
});

test('the stage end the auto flow reaches records the run it kills with cause auto (#672)', () => {
  const { state, ptyId } = running();
  const done = reduce(state, { type: 'done', ptyId }).state;
  const { state: ended, effects } = reduce(done, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop', session_id: SESSION } });
  assert.ok(effects.some((e) => e.type === 'kill' && e.ptyId === ptyId), 'the next stage is a new session: the run is killed');
  assert.deepEqual(ended.slept?.map((s) => [s.ptyId, s.cause, s.stage]), [[ptyId, 'auto', 'spec']]);
});

test('the idle shutdown stops a waiting run with cause idle, and its exit records it so (#672)', () => {
  const { state, ptyId } = running();
  const waiting = reduce(state, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop', session_id: SESSION } }).state;
  const longAgo = new Date(Date.now() - 2 * HOUR_MS).toISOString();
  const armed: State = { ...waiting, shutdown: { armedAt: longAgo }, workers: waiting.workers.map((w) => (w.runId === ptyId ? { ...w, waitingSince: longAgo } : w)) };
  const { state: swept, effects } = reduce(armed, { type: 'tick' });
  assert.deepEqual(effects.flatMap((e) => (e.type === 'kill' ? [e.ptyId] : [])), [ptyId]);
  assert.equal(swept.workers.find((w) => w.runId === ptyId)?.ending, 'idle');
  assert.equal(reduce(swept, { type: 'exit', ptyId }).state.slept?.[0]?.cause, 'idle');
});

test('past SLEPT_MAX the oldest record goes with a forgetScrollback for its run (#672)', () => {
  const { state, ptyId } = running();
  const old = (n: number): SleptRun => ({ ptyId: `old-${n}`, sessionId: `s-${n}`, agent: 'claude', kind: 'session', at: n });
  const full: State = { ...state, slept: Array.from({ length: SLEPT_MAX }, (_, i) => old(i)) };
  const { state: exited, effects } = reduce(full, { type: 'exit', ptyId });
  assert.equal(exited.slept?.length, SLEPT_MAX);
  assert.deepEqual([exited.slept?.[0]?.ptyId, exited.slept?.at(-1)?.ptyId], ['old-1', ptyId]);
  assert.deepEqual(effects.filter((e) => e.type === 'forgetScrollback'), [{ type: 'forgetScrollback', ptyId: 'old-0' }]);
});

test('forgetSlept drops its record and always forgets the transcript, for a run with no record yet too (#672)', () => {
  const { state, ptyId } = running();
  const exited = reduce(state, { type: 'exit', ptyId }).state;
  const { state: forgot, effects } = reduce(exited, { type: 'forgetSlept', ptyId });
  assert.deepEqual([forgot.slept, effects], [[], [{ type: 'forgetScrollback', ptyId }]]);
  assert.deepEqual(reduce(state, { type: 'forgetSlept', ptyId: 'still-running' }).effects, [{ type: 'forgetScrollback', ptyId: 'still-running' }]);
});

test('a local session\'s exit records its workspace, and continuing the session drops the record with a forgetScrollback (#672)', () => {
  const booted = reduce({ ...initialState(0), workspaces: ['hive'] }, { type: 'boot' }).state;
  const opened = reduce(booted, { type: 'newLocalSession', activityId: localActivityId('hive') }).state;
  const worker = opened.workers.find((w) => w.activityId === localActivityId('hive') && w.status !== 'empty');
  const ptyId = worker?.runId ?? '';
  const sessionId = worker?.sessionId ?? '';
  const seen = reduce(opened, { type: 'hook', ptyId, payload: { hook_event_name: 'SessionStart', session_id: sessionId } }).state;
  const exited = reduce(seen, { type: 'exit', ptyId }).state;
  assert.deepEqual(exited.slept?.map((s) => [s.ptyId, s.kind, s.workspace, s.taskId]), [[ptyId, 'session', 'hive', undefined]]);
  const { state: continued, effects } = reduce(exited, { type: 'openLocalSession', activityId: localActivityId('hive'), sessionId });
  assert.deepEqual(continued.slept, []);
  assert.deepEqual(effects.filter((e) => e.type === 'forgetScrollback'), [{ type: 'forgetScrollback', ptyId }]);
});

test('the input state is never written to (#672)', () => {
  const { state, ptyId } = running();
  const stopped = reduce(state, { type: 'stop', ptyId, cause: 'manual' }).state;
  const before = JSON.stringify(stopped);
  reduce(stopped, { type: 'exit', ptyId });
  reduce(stopped, { type: 'forgetSlept', ptyId });
  assert.equal(JSON.stringify(stopped), before);
});

test('a forgetSlept that reaches the reducer before its run\'s exit leaves that exit no record, and forgets the transcript again (#672)', () => {
  const { state, ptyId } = running();
  const stopped = reduce(state, { type: 'stop', ptyId, cause: 'manual' }).state;
  const forgot = reduce(stopped, { type: 'forgetSlept', ptyId }).state;
  const { state: exited, effects } = reduce(forgot, { type: 'exit', ptyId });
  assert.deepEqual(exited.slept ?? [], []);
  assert.deepEqual(effects.filter((e) => e.type === 'forgetScrollback'), [{ type: 'forgetScrollback', ptyId }]);
});

test('a forgetSlept for a run that is not ending leaves its later exit its record (#672)', () => {
  const { state, ptyId } = running();
  const forgot = reduce(state, { type: 'forgetSlept', ptyId }).state;
  assert.equal(forgot.workers.find((w) => w.runId === ptyId)?.forgotten, undefined);
  const stopped = reduce(forgot, { type: 'stop', ptyId, cause: 'manual' }).state;
  assert.equal(reduce(stopped, { type: 'exit', ptyId }).state.slept?.length, 1);
});

test('a run that ends with no record forgets its transcript: never opened, or failed to spawn (#672)', () => {
  const polled = reduce(base(), { type: 'poll', source: 'board', items: [{ item, column: 'Backlog' }] }).state;
  const fresh = polled.workers[0].runId ?? '';
  const forgets = (event: Parameters<typeof reduce>[1]) => reduce(polled, event).effects.filter((e) => e.type === 'forgetScrollback');
  assert.deepEqual(forgets({ type: 'exit', ptyId: fresh }), [{ type: 'forgetScrollback', ptyId: fresh }]);
  assert.deepEqual(forgets({ type: 'spawnFailed', ptyId: fresh, message: 'pty: boom' }), [{ type: 'forgetScrollback', ptyId: fresh }]);
  const { state, ptyId } = running();
  assert.deepEqual(reduce(state, { type: 'exit', ptyId }).effects.filter((e) => e.type === 'forgetScrollback'), [], 'a recorded run keeps it');
});

test('the records of a task no longer in the Hive and of a removed workspace go, each forgetting its transcript (#672)', () => {
  const { state } = running();
  const record = (ptyId: string, extra: Partial<SleptRun>): SleptRun => ({ ptyId, sessionId: `s-${ptyId}`, agent: 'claude', kind: 'session', at: 1, ...extra });
  const slept = [record('task-gone', { taskId: 'board:gone' }), record('ws-gone', { workspace: 'gone' }), record('kept', { taskId: 'board:item1' }), record('local', { workspace: 'hive' })];
  const { state: next, effects } = reduce({ ...state, slept }, { type: 'tick' });
  assert.deepEqual(next.slept?.map((s) => s.ptyId), ['kept', 'local']);
  assert.deepEqual(effects.filter((e) => e.type === 'forgetScrollback').map((e) => e.ptyId), ['task-gone', 'ws-gone']);
});
