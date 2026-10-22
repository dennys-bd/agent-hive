import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { benchmarkReduce } from '../../src/benchmark-reducer.js';
import type { LockDeps } from '../../src/benchmark/run-lock.js';
import { createBenchRunner } from '../../src/benchmark/runner.js';
import type { BenchmarkEvent, Experiment } from '../../src/types.js';
import { tempDir } from '../temp-dir.js';
import { experiment, run, SLEEP_SNAP, stateWith, stubIo, until } from './fixtures.js';

const AT = '2026-10-22T22:00:00.000Z';
const { until: _until, ...PACE } = experiment().pace;
const ONE_PAIR = experiment({ pace: { ...PACE, pairs: 1 } });

async function rig(t: TestContext, exp: Experiment, o: { down?: (home: string) => boolean; lock?: LockDeps; slow?: boolean } = {}) {
  const hiveDir = await tempDir(t, 'runner-');
  await mkdir(join(hiveDir, 'benchmark', exp.id), { recursive: true });
  let state = stateWith(exp);
  let now = Date.parse(AT);
  let cancelled = 0;
  const failing = { on: (_event: BenchmarkEvent): boolean => false }; // tests' switch: a dispatch that throws
  const events: BenchmarkEvent[] = [];
  const lines: string[] = [];
  const scheduled: { ms: number; wake: () => void }[] = [];
  const io = stubIo(hiveDir, { snapshot: SLEEP_SNAP, ...(o.down === undefined ? {} : { down: o.down }) });
  const runner = createBenchRunner({
    latest: () => state, config: () => undefined, hiveDir, now: () => new Date(now),
    dispatch: async (event) => {
      if (o.slow) await new Promise((resolve) => setImmediate(resolve)); // the real dispatch is async: a second click lands in this gap
      if (failing.on(event)) throw new Error('dispatch failed');
      events.push(event);
      state = benchmarkReduce(state, event);
    },
    evaluator: { evaluate: async (_id, tokens) => { io.calls.push(`evaluate ${tokens.join(',')}`); } },
    log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    io: io.io, schedule: (ms, wake) => { scheduled.push({ ms, wake }); return () => { cancelled += 1; }; }, lock: o.lock ?? {}, abortWaitMs: 200,
  });
  t.after(() => runner.abortAll());
  return {
    runner, events, lines, io, scheduled, failing, hiveDir, cancelled: () => cancelled, advance: (ms: number) => { now += ms; },
    latest: () => state.benchmark.experiments.find((e) => e.id === exp.id),
  };
}
const endAll = (r: { io: { watching: Map<string, (end: { outcome: 'done' }) => void> } }): void => { for (const end of r.io.watching.values()) end({ outcome: 'done' }); };

test('sleep records the sleep and posts /ptys/sleep once per activity of every live run; wake continues each stopped activity, adds the slept span and applies the deadline (#472)', async (t) => {
  const r = await rig(t, ONE_PAIR);
  assert.equal(await r.runner.run('exp-1'), 'started');
  await until(() => r.io.watching.size === 2);
  await r.runner.sleep('exp-1', 'night', '07:00');
  assert.deepEqual(r.events.filter((e) => e.type === 'benchmarkSlept'), [{ type: 'benchmarkSlept', id: 'exp-1', sleep: { round: 1, at: AT, reason: 'night' } }]);
  assert.equal(r.latest()?.status, 'sleeping');
  for (const client of r.io.clients.values()) assert.deepEqual(client.posts, ['sleep r1,r2', 'sleep r3']);
  r.advance(60_000);
  await r.runner.wake('exp-1', 'finish-round');
  for (const client of r.io.clients.values()) assert.deepEqual(client.posts.slice(2), ['continue act-1', 'continue act-2']);
  const woken = r.events.slice(r.events.findIndex((e) => e.type === 'benchmarkSlept') + 1);
  assert.deepEqual(woken.map((e) => e.type).slice(0, 4), ['benchmarkRunChanged', 'benchmarkRunChanged', 'benchmarkWoken', 'benchmarkStopAfterRound']);
  assert.deepEqual(r.latest()?.rounds[0].runs.map((x) => [x.status, x.sleptMs]), [['running', 60_000], ['running', 60_000]]);
  assert.equal(r.cancelled(), 1, "the wake clears the sleep's wakeAt timer");
  endAll(r);
  await until(() => r.latest()?.status === 'done');
  assert.deepEqual(r.io.calls.filter((c) => c.startsWith('stop')).sort(), ['stop tok1', 'stop tok2']);
});

test("a wakeAt schedules a wake at the next HH:MM, which wakes with no deadline: pace.until and stopAfterRound stay as they were (#472)", async (t) => {
  const r = await rig(t, experiment({ pace: { ...experiment().pace, pairs: 1 } }));
  await r.runner.run('exp-1');
  await until(() => r.io.watching.size === 2);
  await r.runner.sleep('exp-1', 'lunch', '07:00');
  assert.equal(r.scheduled.length, 1);
  assert.ok(r.scheduled[0].ms > 0 && r.scheduled[0].ms <= 24 * 3_600_000, String(r.scheduled[0].ms));
  r.scheduled[0].wake();
  await until(() => r.latest()?.status === 'running');
  assert.deepEqual([r.latest()?.pace.until, r.latest()?.stopAfterRound], ['07:00', undefined]);
  await until(() => [...r.io.clients.values()].every((c) => c.posts.length === 4));
});

test('a daemon that does not answer on wake makes its run interrupted, stops it, and the round boots that run again with a new token (#472)', async (t) => {
  let down = false;
  const r = await rig(t, ONE_PAIR, { down: (home) => down && home.endsWith('tok1') });
  await r.runner.run('exp-1');
  await until(() => r.io.watching.size === 2);
  await r.runner.sleep('exp-1', 'night');
  down = true;
  await r.runner.wake('exp-1');
  assert.ok(r.events.some((e) => e.type === 'benchmarkRunChanged' && e.token === 'tok1' && e.patch.status === 'interrupted'));
  assert.ok(r.io.calls.includes('stop tok1'));
  r.io.watching.get('tok2')?.({ outcome: 'done' });
  await until(() => r.io.watching.has('tok3'));
  assert.deepEqual(r.io.calls.filter((c) => c.startsWith('prepareRun')), ['prepareRun a1 r1', 'prepareRun a2 r1', 'prepareRun a1 r1']);
  r.io.watching.get('tok3')?.({ outcome: 'done' });
  await until(() => r.latest()?.status === 'done');
  assert.deepEqual(r.latest()?.rounds[0].runs.map((x) => [x.token, x.status]), [['tok1', 'interrupted'], ['tok2', 'done'], ['tok3', 'done']]);
});

test('waking a sleeping experiment after a restart marks its unfinished runs interrupted, wakes it and resumes it as run does (#472)', async (t) => {
  const asleep = experiment({ status: 'sleeping', pace: { ...PACE, pairs: 1 }, sleeps: [{ round: 1, at: AT, reason: 'night' }], rounds: [
    { n: 1, startedAt: AT, runs: [run('aaaa1', { status: 'sleeping' }), run('aaaa2', { armId: 'a2', status: 'done' })] },
  ] });
  const r = await rig(t, asleep);
  assert.equal(r.runner.isLive('exp-1'), false);
  await r.runner.wake('exp-1');
  await until(() => r.io.watching.has('tok1'));
  assert.deepEqual(r.events.slice(0, 2), [
    { type: 'benchmarkRunChanged', id: 'exp-1', token: 'aaaa1', patch: { status: 'interrupted' } },
    { type: 'benchmarkWoken', id: 'exp-1', at: AT },
  ]);
  assert.deepEqual(r.io.calls.filter((c) => c.startsWith('prepareRun')), ['prepareRun a1 r1']);
  endAll(r);
  await until(() => r.latest()?.status === 'done');
});

test("run answers live while its loop runs and locked while another live Hive holds run.lock; the loop's end removes the lock (#472)", async (t) => {
  const r = await rig(t, ONE_PAIR, { lock: { pid: 111, alive: (pid) => pid === 999 } });
  const lock = join(r.hiveDir, 'benchmark', 'exp-1', 'run.lock');
  await writeFile(lock, '999\n');
  assert.equal(await r.runner.run('exp-1'), 'locked');
  assert.equal(r.runner.isLive('exp-1'), false);
  await writeFile(lock, '998\n');
  assert.equal(await r.runner.run('exp-1'), 'started');
  assert.equal(await r.runner.run('exp-1'), 'live');
  assert.equal(await readFile(lock, 'utf8'), '111\n');
  await until(() => r.io.watching.size === 2);
  endAll(r);
  await until(() => !r.runner.isLive('exp-1'));
  assert.equal(existsSync(lock), false);
  assert.equal(r.latest()?.status, 'done');
});

test('abortAll aborts every loop and dispatches nothing after it, cancels the wakeAt timer, releases the lock, and starts nothing new (#472)', async (t) => {
  const r = await rig(t, ONE_PAIR);
  await r.runner.run('exp-1');
  await until(() => r.io.watching.size === 2);
  await r.runner.sleep('exp-1', 'night', '07:00');
  const seen = r.events.length;
  await r.runner.abortAll();
  assert.equal(r.events.length, seen);
  assert.equal(r.runner.isLive('exp-1'), false);
  assert.equal(r.cancelled(), 1);
  assert.equal(existsSync(join(r.hiveDir, 'benchmark', 'exp-1', 'run.lock')), false);
  assert.equal(await r.runner.run('exp-1'), 'locked');
});

test('two wakes at once wake once: the slept span is added once and benchmarkWoken is dispatched once (#472)', async (t) => {
  const r = await rig(t, ONE_PAIR, { slow: true });
  await r.runner.run('exp-1');
  await until(() => r.io.watching.size === 2);
  await r.runner.sleep('exp-1', 'night');
  r.advance(60_000);
  await Promise.all([r.runner.wake('exp-1'), r.runner.wake('exp-1')]);
  assert.equal(r.events.filter((e) => e.type === 'benchmarkWoken').length, 1);
  assert.deepEqual(r.latest()?.rounds[0].runs.map((x) => x.sleptMs), [60_000, 60_000]);
});

test('two wakes at once after a restart resume once and never finish the experiment (#472)', async (t) => {
  const asleep = experiment({ status: 'sleeping', pace: { ...PACE, pairs: 1 }, sleeps: [{ round: 1, at: AT, reason: 'night' }], rounds: [
    { n: 1, startedAt: AT, runs: [run('aaaa1', { status: 'sleeping' }), run('aaaa2', { armId: 'a2', status: 'done' })] },
  ] });
  const r = await rig(t, asleep, { slow: true });
  await Promise.all([r.runner.wake('exp-1'), r.runner.wake('exp-1')]);
  await until(() => r.io.watching.has('tok1'));
  assert.equal(r.events.filter((e) => e.type === 'benchmarkFinished').length, 0);
  endAll(r);
  await until(() => r.latest()?.status === 'done');
});

test('a second sleep while the experiment sleeps does nothing, even raced with the first (#472)', async (t) => {
  const r = await rig(t, ONE_PAIR, { slow: true });
  await r.runner.run('exp-1');
  await until(() => r.io.watching.size === 2);
  await Promise.all([r.runner.sleep('exp-1', 'night'), r.runner.sleep('exp-1', 'night')]);
  await r.runner.sleep('exp-1', 'again');
  assert.equal(r.events.filter((e) => e.type === 'benchmarkSlept').length, 1);
});

test('a sleep whose dispatch throws reopens the gate and rethrows, so a later sleep still works (#472)', async (t) => {
  const r = await rig(t, ONE_PAIR);
  await r.runner.run('exp-1');
  await until(() => r.io.watching.size === 2);
  r.failing.on = (event) => event.type === 'benchmarkSlept';
  await assert.rejects(r.runner.sleep('exp-1', 'night'), /dispatch failed/);
  r.failing.on = () => false;
  await r.runner.sleep('exp-1', 'night');
  assert.equal(r.latest()?.status, 'sleeping');
});

test('run rejects when the lock cannot be taken for an I/O reason, and the experiment does not read live (#472)', async (t) => {
  const r = await rig(t, ONE_PAIR);
  await rm(join(r.hiveDir, 'benchmark', 'exp-1'), { recursive: true });
  await assert.rejects(r.runner.run('exp-1'));
  assert.equal(r.runner.isLive('exp-1'), false);
});
