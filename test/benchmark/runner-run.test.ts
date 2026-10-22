import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkReduce } from '../../src/benchmark-reducer.js';
import { noMetrics } from '../../src/benchmark/metrics.js';
import { endRun, type LiveRun, type RunContext, startRun, TOKENS_EVERY_MS, watchOne } from '../../src/benchmark/runner-run.js';
import { createGate } from '../../src/benchmark/runner-sleep.js';
import type { Tokens } from '../../src/facts.js';
import type { BenchmarkEvent, Experiment } from '../../src/types.js';
import { experiment, fakeChild, run, snap, stateWith, stubClient, stubIo, until } from './fixtures.js';

const AT = '2026-10-22T22:00:00.000Z';
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function context(exp: Experiment, o: { modelTokens?: Record<string, Tokens> } = {}) {
  let state = stateWith(exp);
  let now = Date.parse(AT);
  const events: BenchmarkEvent[] = [];
  const lines: string[] = [];
  const rig = stubIo('/hive', o);
  const latest = (): Experiment | undefined => state.benchmark.experiments.find((e) => e.id === 'exp-1');
  const ctx: RunContext = {
    id: 'exp-1', workspace: 'hive', hiveDir: '/hive', signal: new AbortController().signal, io: rig.io, gate: createGate(), latest,
    dispatch: async (event) => { events.push(event); state = benchmarkReduce(state, event); },
    now: () => new Date(now), log: (line) => lines.push(line), ready: async () => undefined,
    handles: new Map(), watched: new Map(), tokensAt: new Map(),
  };
  return { ctx, rig, events, lines, latest, advance: (ms: number) => { now += ms; } };
}

const liveRun = (token: string): LiveRun => {
  const home = `/hive/benchmark/exp-1/runs/${token}`;
  return {
    token, armId: 'a1', round: 1, home, startedAt: AT, controller: new AbortController(), client: stubClient(snap([])),
    running: { token, daemon: { home, address: { port: 1, secret: 's' }, child: fakeChild().child } },
  };
};

test('endRun reads the metrics (unpriced kept and logged) and the interventions, dispatches them, then the end, then stops the run; an aborted end does nothing (#472)', async () => {
  const c = context(experiment({ status: 'running', rounds: [{ n: 1, runs: [run('tok1', { sleptMs: 1_000 })] }] }), { modelTokens: { mystery: { input: 5, output: 0, cache_write: 0, cache_read: 0 } } });
  const live = liveRun('tok1');
  await endRun(c.ctx, live, { outcome: 'aborted' });
  assert.deepEqual([c.events, c.rig.calls], [[], []]);
  c.advance(600_000);
  await endRun(c.ctx, live, { outcome: 'error', reason: 'MON-1: its Build run ended without hive_done' });
  const [changed, ended] = c.events;
  assert.ok(changed?.type === 'benchmarkRunChanged');
  assert.deepEqual([changed.patch.metrics?.ms, changed.patch.metrics?.diff, changed.patch.unpriced, changed.patch.interventions], [599_000, { files: 2, insertions: 10, deletions: 1 }, ['mystery'], []]);
  assert.deepEqual(ended, { type: 'benchmarkRunEnded', id: 'exp-1', token: 'tok1', status: 'error', at: new Date(Date.parse(AT) + 600_000).toISOString(), reason: 'MON-1: its Build run ended without hive_done' });
  assert.deepEqual(c.rig.calls, ['stop tok1']);
  assert.ok(c.lines.includes('benchmark exp-1 tok1: no price for mystery'));
});

test('a run that failed to prepare or boot ends error with its reason and empty metrics, never measured or stopped (#472)', async () => {
  const c = context(experiment({ status: 'running', rounds: [{ n: 1, runs: [run('tok1')] }] }));
  const { running: _running, client: _client, ...unbooted } = liveRun('tok1');
  await endRun(c.ctx, { ...unbooted, failed: 'the daemon exited with 1' }, { outcome: 'error', reason: 'the daemon exited with 1' });
  assert.deepEqual(c.events[0], { type: 'benchmarkRunChanged', id: 'exp-1', token: 'tok1', patch: { metrics: noMetrics() } });
  assert.deepEqual([c.latest()?.rounds[0].runs[0].status, c.latest()?.rounds[0].runs[0].reason], ['error', 'the daemon exited with 1']);
  assert.deepEqual(c.rig.calls, []);
});

test('startRun: a prepare that throws still records a running run under a drawn token, failed with the first line; a boot that throws fails the prepared run (#472)', async () => {
  const exp = experiment();
  const c = context(exp);
  const failed = await startRun({ ...c.ctx, io: { ...c.rig.io, prepareRun: async () => { throw new Error('workspace hive is gone\nmore'); } } }, exp, exp.arms[0], 1);
  assert.match(failed.token, /^[a-z][a-z0-9]{7}$/);
  assert.deepEqual([failed.failed, failed.client], ['workspace hive is gone', undefined]);
  assert.deepEqual(c.events[0], { type: 'benchmarkRunStarted', id: 'exp-1', run: {
    token: failed.token, armId: 'a1', round: 1, status: 'running', home: `/hive/benchmark/exp-1/runs/${failed.token}`, branch: `work/${failed.token}`,
    sleptMs: 0, delivered: 0, total: 1, interventions: [], startedAt: AT,
  } });
  const unbooted = await startRun({ ...c.ctx, io: { ...c.rig.io, boot: async () => { throw new Error('the daemon exited with 1 (see daemon.out)'); } } }, exp, exp.arms[1], 1);
  assert.deepEqual([unbooted.token, unbooted.failed, unbooted.client], ['tok1', 'the daemon exited with 1 (see daemon.out)', undefined]);
  const booted = await startRun(c.ctx, exp, exp.arms[0], 2);
  assert.deepEqual([booted.token, booted.failed, booted.client !== undefined, c.ctx.handles.has('tok2')], ['tok2', undefined, true, true]);
});

test("watchOne watches the arm's tasks with the pace's timeout and the slept time so far, the open sleep included, and keeps the watch state (#472)", async () => {
  const exp = experiment({ status: 'running', rounds: [{ n: 1, runs: [run('tok1', { sleptMs: 5_000 })] }] });
  const c = context(exp);
  const watching = watchOne(c.ctx, liveRun('tok1'));
  await until(() => c.rig.watchDeps.has('tok1'));
  const deps = c.rig.watchDeps.get('tok1');
  assert.ok(deps);
  assert.deepEqual([deps.timeoutMs, deps.sleptMs?.()], [exp.pace.runTimeoutMs, 5_000]);
  assert.deepEqual(c.rig.tasksOf.get('tok1'), [{ itemId: 'local:1', key: 'T1', title: 'One', blockedBy: [] }]);
  await c.ctx.dispatch({ type: 'benchmarkSlept', id: 'exp-1', sleep: { round: 1, at: AT, reason: 'night' } });
  c.advance(30_000);
  assert.equal(deps.sleptMs?.(), 35_000);
  c.rig.watching.get('tok1')?.({ outcome: 'timeout' });
  assert.deepEqual(await watching, { outcome: 'timeout' });
  assert.ok(c.ctx.watched.has('tok1'));
});

test('progress becomes delivered, total and running or waiting; the tokens are read at most once a minute; nothing while the experiment sleeps (#472)', async () => {
  const c = context(experiment({ status: 'running', rounds: [{ n: 1, runs: [run('tok1')] }] }), { modelTokens: { sonnet: { input: 4, output: 3, cache_write: 2, cache_read: 1 } } });
  void watchOne(c.ctx, liveRun('tok1'));
  await until(() => c.rig.watchDeps.has('tok1'));
  const deps = c.rig.watchDeps.get('tok1');
  assert.ok(deps?.onProgress);
  deps.onProgress({ delivered: 1, total: 2, waiting: true, tasks: [] });
  await until(() => c.events.length === 2);
  assert.deepEqual(c.events[0], { type: 'benchmarkRunChanged', id: 'exp-1', token: 'tok1', patch: { delivered: 1, total: 2, status: 'waiting' } });
  assert.equal(c.latest()?.rounds[0].runs[0].metrics?.tokens, 10);
  deps.onProgress({ delivered: 2, total: 2, waiting: false, tasks: [] });
  await until(() => c.events.length === 3);
  await tick();
  assert.equal(c.events.length, 3, 'no second token read within the minute');
  c.advance(TOKENS_EVERY_MS);
  deps.onProgress({ delivered: 2, total: 2, waiting: true, tasks: [] });
  await until(() => c.events.length === 5);
  await c.ctx.dispatch({ type: 'benchmarkSlept', id: 'exp-1', sleep: { round: 1, at: AT, reason: 'night' } });
  const seen = c.events.length;
  deps.onProgress({ delivered: 0, total: 2, waiting: false, tasks: [] });
  await tick();
  assert.equal(c.events.length, seen);
});
