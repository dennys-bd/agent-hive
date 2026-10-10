import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Activity, Task, Worker } from '../../src/types.js';
import { observe, type Snapshot, startWatch, type WatchClient, watchRun } from '../../scripts/experiment/watcher.js';
import { clock, snap, task, worker } from './fixtures.js';

// 1 and 4 free; 2 after 1; 3 after 1 and 2 (the shape of the seed's 4 after 3 and 2)
const GRAPH = [
  { itemId: 'local:1', blockedBy: [] }, { itemId: 'local:2', blockedBy: ['local:1'] },
  { itemId: 'local:3', blockedBy: ['local:1', 'local:2'] }, { itemId: 'local:4', blockedBy: [] },
];
const AT = new Date('2026-10-01T22:00:00.000Z');
const four = (stages: string[], acts: Partial<Activity>[] = []): Snapshot => snap(stages.map((s, i) => task(i + 1, s)), [], acts);

test('startWatch counts the free tasks as released; observe frees each task once all its blockers are in Done, and ends on the last Done (#105)', () => {
  const start = startWatch(GRAPH);
  assert.deepEqual(start.released, ['local:1', 'local:4']);
  assert.deepEqual(observe(start, four(['Spec', 'Spec', 'Spec', 'Build']), AT).release, []);
  const first = observe(start, four(['Done', 'Spec', 'Spec', 'Build']), AT);
  assert.deepEqual([first.release, first.end], [['local:2'], undefined]);
  const again = observe(first.watch, four(['Done', 'Plan', 'Spec', 'Done']), AT);
  assert.deepEqual(again.release, [], 'released once');
  const third = observe(again.watch, four(['Done', 'Done', 'Spec', 'Done']), AT);
  assert.deepEqual(third.release, ['local:3']);
  assert.deepEqual(observe(third.watch, four(['Done', 'Done', 'Done', 'Done']), AT).end, { outcome: 'done' });
});

test('observe releases every task freed by the same read at once, in seed order (#105)', () => {
  const graph = [{ itemId: 'local:1', blockedBy: [] }, { itemId: 'local:2', blockedBy: [] }, { itemId: 'local:3', blockedBy: ['local:1'] }, { itemId: 'local:4', blockedBy: ['local:2'] }];
  assert.deepEqual(observe(startWatch(graph), four(['Done', 'Done', 'Spec', 'Spec']), AT).release, ['local:3', 'local:4']);
});

test('observe ends with an error on a task error, a run that ended without hive_done, and a task that left the Hive (#105)', () => {
  const start = startWatch(GRAPH);
  assert.deepEqual(observe(start, four(['Build', 'Spec', 'Spec', 'Spec'], [{ error: 'spawn failed' }]), AT).end, { outcome: 'error', reason: 'MON-1: spawn failed' });
  assert.deepEqual(observe(start, four(['Plan', 'Spec', 'Spec', 'Spec'], [{ stopped: true }]), AT).end, { outcome: 'error', reason: 'MON-1: its Plan run ended without hive_done' });
  assert.deepEqual(observe(start, snap([task(1, 'Spec'), task(2, 'Spec'), task(3, 'Spec')]), AT).end, { outcome: 'error', reason: 'local:4 left the Hive' });
});

test('observe records one stage entry per change, at the task enteredAt or when first seen, and the distinct Build runs (#105)', () => {
  let watch = startWatch([{ itemId: 'local:1', blockedBy: [] }, { itemId: 'local:2', blockedBy: ['local:1'] }]);
  const step = (tasks: Task[], workers: Worker[], at: Date): void => { watch = observe(watch, snap(tasks, workers), at).watch; };
  step([task(1, 'Spec'), task(2, 'Spec')], [worker(1, 'r0')], AT);
  step([task(1, 'Spec'), task(2, 'Spec')], [], new Date(AT.getTime() + 60_000));
  step([task(1, 'Build', { enteredAt: '2026-10-01T23:00:00.000Z' }), task(2, 'Spec')], [worker(1, 'r1')], new Date(AT.getTime() + 7_200_000));
  step([task(1, 'Build'), task(2, 'Spec')], [worker(1, 'r1'), worker(1, 'r9', { freeSession: true })], AT);
  step([task(1, 'Build'), task(2, 'Spec')], [worker(1, 'r2')], AT);
  assert.deepEqual(watch.entries['local:1'], [{ stage: 'Spec', at: AT.toISOString() }, { stage: 'Build', at: '2026-10-01T23:00:00.000Z' }]);
  assert.deepEqual(watch.buildRuns['local:1'], ['r1', 'r2']);
  assert.deepEqual(watch.entries['local:2'], [{ stage: 'Spec', at: AT.toISOString() }]);
});

function client(snapshots: (Snapshot | Error)[]): WatchClient & { released: string[] } {
  const released: string[] = [];
  let i = 0;
  return {
    released,
    state: async () => {
      const next = snapshots[Math.min(i, snapshots.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    setAuto: async (id) => { released.push(id); },
    setGreen: async () => { released.push('green'); },
  };
}
const depsOf = (c: WatchClient, time: ReturnType<typeof clock>, timeoutMs = 3_600_000) => ({ client: c, now: time.now, sleep: time.sleep, log: () => undefined, timeoutMs, pollMs: 1000 });

test('watchRun releases each task once its blockers are done and ends on the last Done (#105)', async () => {
  const c = client([four(['Spec', 'Spec', 'Spec', 'Spec']), four(['Done', 'Spec', 'Spec', 'Build']), four(['Done', 'Done', 'Spec', 'Done']), four(['Done', 'Done', 'Done', 'Done'])]);
  const time = clock(AT);
  assert.deepEqual((await watchRun(GRAPH, depsOf(c, time))).end, { outcome: 'done' });
  assert.deepEqual(c.released, ['green', 'local:2', 'local:3']);
  assert.deepEqual(time.slept, [1000, 1000, 1000]);
});

test('watchRun ends on the timeout and releases nothing when the tasks never reach Done (#105)', async () => {
  const c = client([four(['Build', 'Spec', 'Spec', 'Build'])]);
  assert.deepEqual((await watchRun(GRAPH, depsOf(c, clock(AT), 5000))).end, { outcome: 'timeout' });
  assert.deepEqual(c.released, ['green']); // green, and no task
});

test('watchRun goes on after a failed read and ends with an error after four in a row (#105)', async () => {
  const down = new Error('ECONNREFUSED');
  assert.deepEqual((await watchRun(GRAPH, depsOf(client([down, four(['Done', 'Done', 'Done', 'Done'])]), clock(AT)))).end, { outcome: 'done' });
  assert.deepEqual((await watchRun(GRAPH, depsOf(client([down]), clock(AT)))).end, { outcome: 'error', reason: 'the daemon stopped answering' });
});

test('watchRun ends with an error naming the task when its release is refused (#105)', async () => {
  const refusing: WatchClient = { state: async () => four(['Done', 'Spec', 'Spec', 'Build']), setAuto: async () => { throw new Error('POST /tasks/local:2/auto: HTTP 409'); }, setGreen: async () => undefined };
  assert.deepEqual((await watchRun(GRAPH, depsOf(refusing, clock(AT)))).end, { outcome: 'error', reason: 'could not release local:2: POST /tasks/local:2/auto: HTTP 409' });
});

test('watchRun turns the daemon green before it releases anything: the boot opens yellow, and yellow starts no task (#105)', async () => {
  const c = client([four(['Done', 'Spec', 'Spec', 'Build']), four(['Done', 'Done', 'Done', 'Done'])]);
  await watchRun(GRAPH, depsOf(c, clock(AT)));
  assert.equal(c.released[0], 'green');
});

test('watchRun ends with an error when the daemon refuses green, since no task would ever start (#105)', async () => {
  const yellow: WatchClient = { state: async () => four(['Spec', 'Spec', 'Spec', 'Spec']), setAuto: async () => undefined, setGreen: async () => { throw new Error('POST /signal: HTTP 503'); } };
  assert.deepEqual((await watchRun(GRAPH, depsOf(yellow, clock(AT)))).end, { outcome: 'error', reason: 'could not turn the daemon green: POST /signal: HTTP 503' });
});

test('watchRun tries green again while a daemon just booted beside another is too busy to answer, and goes on once it does (#105)', async () => {
  let refusals = 2;
  const greens: number[] = [];
  const slow: WatchClient = {
    state: async () => four(['Done', 'Done', 'Done', 'Done']),
    setAuto: async () => undefined,
    setGreen: async () => { greens.push(1); if (refusals-- > 0) throw new Error('The operation was aborted due to timeout'); },
  };
  const time = clock(AT);
  assert.deepEqual((await watchRun(GRAPH, depsOf(slow, time))).end, { outcome: 'done' });
  assert.equal(greens.length, 3);
  assert.deepEqual(time.slept.slice(0, 2), [1000, 1000], 'it waits a poll between tries');
});

test('observe ends the run with an error when a task reaches Done reporting merged false: its delivery never landed on the run branch (#105)', () => {
  const state = four(['Done', 'Spec', 'Spec', 'Spec']);
  const records = state.activityRecords.map((r, i) => (i === 0 ? { ...r, result: { merged: false, testsGreen: false, reason: 'the push was denied' } } : r));
  const step = observe(startWatch(GRAPH), { ...state, activityRecords: records }, AT);
  assert.deepEqual(step.end, { outcome: 'error', reason: 'MON-1: its Merge ended without merging: the push was denied' });
  const merged = state.activityRecords.map((r, i) => (i === 0 ? { ...r, result: { merged: true, testsGreen: true } } : r));
  assert.equal(observe(startWatch(GRAPH), { ...state, activityRecords: merged }, AT).end, undefined);
});

test('watchRun tries a release again while the daemon is too busy starting the last one to answer, and goes on once it does (#105)', async () => {
  let refusals = 2;
  const tries: string[] = [];
  const slow: WatchClient = {
    ...client([four(['Done', 'Spec', 'Spec', 'Build']), four(['Done', 'Done', 'Done', 'Done'])]),
    setAuto: async (id) => { tries.push(id); if (refusals-- > 0) throw new Error('The operation was aborted due to timeout'); },
  };
  assert.deepEqual((await watchRun(GRAPH, depsOf(slow, clock(AT)))).end, { outcome: 'done' });
  assert.deepEqual(tries.slice(0, 3), ['local:2', 'local:2', 'local:2']);
});
