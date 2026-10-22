import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGate, currentRound, deadlineEvents, gatedClient, interruptedEvents, sleepDaemon, sleepGroups, sleptSoFar, wakeDaemon, wokenEvents,
} from '../../src/benchmark/runner-sleep.js';
import type { WatchClient } from '../../src/benchmark/watcher.js';
import { experiment, run, SLEEP_SNAP, snap, stubClient, task, worker } from './fixtures.js';

const AT = '2026-10-22T22:00:00.000Z';
const LATER = new Date(Date.parse(AT) + 30 * 60_000);
const SLEEPING = experiment({
  status: 'sleeping',
  sleeps: [{ round: 1, at: '2026-10-21T08:00:00.000Z', reason: 'lunch', wokeAt: '2026-10-21T09:00:00.000Z' }, { round: 1, at: AT, reason: 'night' }],
  rounds: [{ n: 1, runs: [
    run('aaaa1', { status: 'sleeping', sleptMs: 3_600_000 }),
    run('aaaa2', { armId: 'a2', status: 'sleeping', startedAt: '2026-10-22T22:10:00.000Z' }),
    run('aaaa3', { status: 'done', sleptMs: 7 }),
  ] }],
});
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('sleepGroups groups the live stage runs by activity; an empty worker, a free session or one with no activity is left out (#472)', () => {
  assert.deepEqual(sleepGroups(SLEEP_SNAP), [['r1', 'r2'], ['r3']]);
  const { activityId: _activity, ...orphan } = worker(1, 'r9');
  assert.deepEqual(sleepGroups(snap([task(1, 'Build')], [orphan])), []);
});

test('sleepDaemon posts /ptys/sleep once per activity; wakeDaemon continues every stopped activity and no other; a daemon down rejects (#472)', async () => {
  const client = stubClient(SLEEP_SNAP);
  await sleepDaemon(client);
  await wakeDaemon(client);
  assert.deepEqual(client.posts, ['sleep r1,r2', 'sleep r3', 'continue act-1', 'continue act-2']);
  await assert.rejects(wakeDaemon(stubClient(SLEEP_SNAP, { down: () => true })));
});

test('sleptSoFar is the recorded sleep, plus the open sleep while the experiment sleeps, from the later of its start and the run start (#472)', () => {
  assert.equal(sleptSoFar(SLEEPING, 'aaaa1', LATER), 3_600_000 + 30 * 60_000);
  assert.equal(sleptSoFar(SLEEPING, 'aaaa2', LATER), 20 * 60_000);
  assert.equal(sleptSoFar(SLEEPING, 'aaaa3', LATER), 7);
  assert.equal(sleptSoFar({ ...SLEEPING, status: 'running' }, 'aaaa1', LATER), 3_600_000);
  assert.equal(sleptSoFar(undefined, 'aaaa1', LATER), 0);
});

test("wokenEvents: each running, waiting or sleeping run gains the open sleep's span, then benchmarkWoken; an ended run none (#472)", () => {
  assert.deepEqual(wokenEvents(SLEEPING, LATER), [
    { type: 'benchmarkRunChanged', id: 'exp-1', token: 'aaaa1', patch: { sleptMs: 3_600_000 + 30 * 60_000 } },
    { type: 'benchmarkRunChanged', id: 'exp-1', token: 'aaaa2', patch: { sleptMs: 20 * 60_000 } },
    { type: 'benchmarkWoken', id: 'exp-1', at: LATER.toISOString() },
  ]);
});

test('deadlineEvents: finish-round stops after the round, { until } edits pace.until, none removes it, absent changes nothing (#472)', () => {
  const exp = experiment({ status: 'sleeping' });
  const { until: _until, ...withoutUntil } = exp.pace;
  assert.deepEqual(deadlineEvents(exp, undefined), []);
  assert.deepEqual(deadlineEvents(exp, 'finish-round'), [{ type: 'benchmarkStopAfterRound', id: 'exp-1', on: true }]);
  assert.deepEqual(deadlineEvents(exp, { until: '09:30' }), [{ type: 'benchmarkEdited', id: 'exp-1', patch: { pace: { ...exp.pace, until: '09:30' } } }]);
  assert.deepEqual(deadlineEvents(exp, 'none'), [{ type: 'benchmarkEdited', id: 'exp-1', patch: { pace: withoutUntil } }]);
});

test('interruptedEvents marks every queued, running, waiting or sleeping run interrupted and no ended one; currentRound is the highest round (#472)', () => {
  const exp = experiment({ rounds: [{ n: 2, runs: [run('q', { status: 'queued' }), run('w', { status: 'waiting' }), run('e', { status: 'error' })] }] });
  assert.deepEqual(interruptedEvents(exp).map((e) => (e.type === 'benchmarkRunChanged' ? [e.token, e.patch.status] : [])), [['q', 'interrupted'], ['w', 'interrupted']]);
  assert.deepEqual(interruptedEvents(SLEEPING).length, 2);
  assert.equal(currentRound(exp), 2);
  assert.equal(currentRound(experiment()), 1);
});

test('gatedClient holds every call while the gate is closed and reads again a state that came back after the gate closed (#472)', async () => {
  const gate = createGate();
  let reads = 0;
  const inner: WatchClient = { state: async () => { reads += 1; if (reads === 1) gate.close(); return SLEEP_SNAP; }, setAuto: async () => undefined, setGreen: async () => undefined, interventions: async () => [] };
  const client = gatedClient(inner, gate, new AbortController().signal);
  const read = client.state();
  await tick();
  assert.equal(reads, 1, 'the read that came back after the close is held, not answered');
  gate.open();
  assert.equal(await read, SLEEP_SNAP);
  assert.equal(reads, 2);
});

test("gatedClient's held calls reject once the run's signal aborts, so the watch ends instead of waiting out the sleep (#472)", async () => {
  const gate = createGate();
  gate.close();
  const controller = new AbortController();
  const client = gatedClient({ state: async () => SLEEP_SNAP, setAuto: async () => undefined, setGreen: async () => undefined, interventions: async () => [] }, gate, controller.signal);
  const green = client.setGreen();
  controller.abort();
  await assert.rejects(green);
  assert.equal(gate.isClosed(), true);
});
