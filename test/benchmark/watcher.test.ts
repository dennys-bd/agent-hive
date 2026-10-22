import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Activity, Intervention, SleptRun, Task, Worker } from '../../src/types.js';
import { observe, type Progress, type Snapshot, startWatch, type WatchClient, watchRun } from '../../src/benchmark/watcher.js';
import { clock, snap, task, watchTask, worker } from './fixtures.js';

// 1 and 4 free; 2 after 1; 3 after 1 and 2 (the shape of the seed's 4 after 3 and 2)
const GRAPH = [watchTask(1), watchTask(2, [1]), watchTask(3, [1, 2]), watchTask(4)];
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
  const graph = [watchTask(1), watchTask(2), watchTask(3, [1]), watchTask(4, [2])];
  assert.deepEqual(observe(startWatch(graph), four(['Done', 'Done', 'Spec', 'Spec']), AT).release, ['local:3', 'local:4']);
});

test('observe ends with an error on a task error, a run that ended without hive_done, and a task that left the Hive (#105)', () => {
  const start = startWatch(GRAPH);
  assert.deepEqual(observe(start, four(['Build', 'Spec', 'Spec', 'Spec'], [{ error: 'spawn failed' }]), AT).end, { outcome: 'error', reason: 'MON-1: spawn failed' });
  assert.deepEqual(observe(start, four(['Plan', 'Spec', 'Spec', 'Spec'], [{ stopped: true }]), AT).end, { outcome: 'error', reason: 'MON-1: its Plan run ended without hive_done' });
  assert.deepEqual(observe(start, snap([task(1, 'Spec'), task(2, 'Spec'), task(3, 'Spec')]), AT).end, { outcome: 'error', reason: 'local:4 left the Hive' });
});

test('observe records one stage entry per change, at the task enteredAt or when first seen, and the distinct runs of every stage (#105, #473)', () => {
  let watch = startWatch([watchTask(1), watchTask(2, [1])]);
  const step = (tasks: Task[], workers: Worker[], at: Date): void => { watch = observe(watch, snap(tasks, workers), at).watch; };
  step([task(1, 'Spec'), task(2, 'Spec')], [worker(1, 'r0')], AT);
  step([task(1, 'Spec'), task(2, 'Spec')], [worker(1, 'r5')], new Date(AT.getTime() + 60_000));
  step([task(1, 'Build', { enteredAt: '2026-10-01T23:00:00.000Z' }), task(2, 'Spec')], [worker(1, 'r1')], new Date(AT.getTime() + 7_200_000));
  step([task(1, 'Build'), task(2, 'Spec')], [worker(1, 'r1'), worker(1, 'r9', { freeSession: true })], AT);
  step([task(1, 'Build'), task(2, 'Spec')], [worker(1, 'r2')], AT);
  assert.deepEqual(watch.entries['local:1'], [{ stage: 'Spec', at: AT.toISOString() }, { stage: 'Build', at: '2026-10-01T23:00:00.000Z' }]);
  assert.deepEqual(watch.stageRuns, { 'local:1': { Spec: ['r0', 'r5'], Build: ['r1', 'r2'] }, 'local:2': {} });
  assert.deepEqual(watch.entries['local:2'], [{ stage: 'Spec', at: AT.toISOString() }]);
});

test('observe reports the progress: tasks in Done, and a task waiting on an approval or on a waiting or approval worker (#473)', () => {
  const tasks = [task(1, 'Done'), task(2, 'Build'), task(3, 'Spec'), task(4, 'Spec')];
  const held = snap(tasks, [worker(2, 'r2', { status: 'waiting' })], [{}, {}, { approval: { since: AT.toISOString() } }]);
  assert.deepEqual(observe(startWatch(GRAPH), held, AT).progress, {
    delivered: 1, total: 4, waiting: true,
    tasks: [{ key: 'T1', state: 'done' }, { key: 'T2', state: 'waiting' }, { key: 'T3', state: 'waiting' }, { key: 'T4', state: 'open' }],
  });
  assert.equal(observe(startWatch(GRAPH), snap(tasks, [worker(2, 'r2')]), AT).progress.waiting, false, 'a working worker waits on no one');
  assert.equal(observe(startWatch(GRAPH), snap(tasks, [worker(4, 'r4', { status: 'approval' })]), AT).progress.tasks[3].state, 'waiting');
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
    interventions: async () => [], setGreen: async () => { released.push('green'); },
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
  const refusing: WatchClient = { state: async () => four(['Done', 'Spec', 'Spec', 'Build']), setAuto: async () => { throw new Error('POST /tasks/local:2/auto: HTTP 409'); }, interventions: async () => [], setGreen: async () => undefined };
  assert.deepEqual((await watchRun(GRAPH, depsOf(refusing, clock(AT)))).end, { outcome: 'error', reason: 'could not release local:2: POST /tasks/local:2/auto: HTTP 409' });
});

test('watchRun turns the daemon green before it releases anything: the boot opens yellow, and yellow starts no task (#105)', async () => {
  const c = client([four(['Done', 'Spec', 'Spec', 'Build']), four(['Done', 'Done', 'Done', 'Done'])]);
  await watchRun(GRAPH, depsOf(c, clock(AT)));
  assert.equal(c.released[0], 'green');
});

test('watchRun ends with an error when the daemon refuses green, since no task would ever start (#105)', async () => {
  const yellow: WatchClient = { state: async () => four(['Spec', 'Spec', 'Spec', 'Spec']), setAuto: async () => undefined, interventions: async () => [], setGreen: async () => { throw new Error('POST /signal: HTTP 503'); } };
  assert.deepEqual((await watchRun(GRAPH, depsOf(yellow, clock(AT)))).end, { outcome: 'error', reason: 'could not turn the daemon green: POST /signal: HTTP 503' });
});

test('watchRun tries green again while a daemon just booted beside another is too busy to answer, and goes on once it does (#105)', async () => {
  let refusals = 2;
  const greens: number[] = [];
  const slow: WatchClient = {
    state: async () => four(['Done', 'Done', 'Done', 'Done']),
    setAuto: async () => undefined,
    interventions: async () => [], setGreen: async () => { greens.push(1); if (refusals-- > 0) throw new Error('The operation was aborted due to timeout'); },
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

test('watchRun calls onProgress after each read whose progress changed, never twice for the same one (#473)', async () => {
  const idle = four(['Spec', 'Spec', 'Spec', 'Spec']);
  const c = client([idle, idle, four(['Done', 'Spec', 'Spec', 'Build']), four(['Done', 'Done', 'Done', 'Done'])]);
  const seen: Progress[] = [];
  await watchRun(GRAPH, { ...depsOf(c, clock(AT)), onProgress: (progress) => { seen.push(progress); } });
  assert.deepEqual(seen.map((p) => p.delivered), [0, 1, 4]);
});

test('watchRun keeps slept time off the timeout: with 3 s asleep, a 5 s timeout reads for 8 s (#473)', async () => {
  const stuck = (): WatchClient => client([four(['Build', 'Spec', 'Spec', 'Build'])]);
  const awake = clock(AT);
  await watchRun(GRAPH, depsOf(stuck(), awake, 5000));
  const asleep = clock(AT);
  const result = await watchRun(GRAPH, { ...depsOf(stuck(), asleep, 5000), sleptMs: () => 3000 });
  assert.deepEqual([awake.slept.length, asleep.slept.length, result.end], [5, 8, { outcome: 'timeout' }]);
});

test('watchRun ends aborted once its signal aborts, and reads nothing after (#473)', async () => {
  const controller = new AbortController();
  let reads = 0;
  const c: WatchClient = {
    state: async () => { reads += 1; if (reads === 2) controller.abort(); return four(['Spec', 'Spec', 'Spec', 'Spec']); },
    setAuto: async () => undefined, interventions: async () => [], setGreen: async () => undefined,
  };
  const result = await watchRun(GRAPH, { ...depsOf(c, clock(AT)), signal: controller.signal });
  assert.deepEqual([result.end, reads], [{ outcome: 'aborted' }, 2]);
});

test('watchRun ends aborted while it sleeps between reads, without waiting out the poll (#473)', async () => {
  const controller = new AbortController();
  const c: WatchClient = { state: async () => four(['Spec', 'Spec', 'Spec', 'Spec']), setAuto: async () => undefined, interventions: async () => [], setGreen: async () => undefined };
  // A sleep that never ends: only the abort can end the watch
  const deps = { ...depsOf(c, clock(AT)), sleep: () => new Promise<void>(() => undefined), signal: controller.signal };
  const watching = watchRun(GRAPH, deps);
  setImmediate(() => controller.abort());
  assert.deepEqual((await watching).end, { outcome: 'aborted' });
});

// The wake (#472): a run that slept with the sleep all is continued, so the run after it takes its place in the stage
function stageRunsAfter(slept: SleptRun[] | undefined): string[] | undefined {
  let watch = startWatch([watchTask(1)]);
  const read = (workers: Worker[], extra: Partial<Snapshot> = {}): void => { watch = observe(watch, { ...snap([task(1, 'Build')], workers), ...extra }, AT).watch; };
  read([worker(1, 'r1')]);
  read([], slept === undefined ? {} : { slept });
  read([worker(1, 'r2')]);
  return watch.stageRuns['local:1']?.Build;
}
const sleptRun = (cause: SleptRun['cause']): SleptRun => ({ ptyId: 'r1', agent: 'claude', kind: 'stage', stage: 'Build', taskId: 'local:1', cause, at: 1 });

test('observe counts no restart for the run a wake continues: the run it follows slept with cause all (#472)', () => {
  assert.deepEqual(stageRunsAfter([sleptRun('all')]), ['r2']);
});

test('observe still counts a restart when the run before slept for another cause, or did not sleep (#472)', () => {
  assert.deepEqual(stageRunsAfter([sleptRun('manual')]), ['r1', 'r2']);
  assert.deepEqual(stageRunsAfter(undefined), ['r1', 'r2']);
});

test('watchRun calls onInterventions after a read whose count changed and once more at the end, never for an unchanged count; without it nothing is read (#475)', async () => {
  const A: Intervention = { at: AT.toISOString(), action: 'POST /signal', detail: '/signal', by: 'user' };
  const B: Intervention = { ...A, action: 'POST /tasks/:id/auto', detail: '/tasks/local:1/auto' };
  const answers = [[], [A], [A], [A, B], [A, B, B]];
  let reads = 0;
  const counted = (c: WatchClient): WatchClient => ({ ...c, interventions: async () => answers[Math.min(reads++, answers.length - 1)] });
  const idle = four(['Spec', 'Spec', 'Spec', 'Spec']);
  const seen: number[] = [];
  await watchRun(GRAPH, { ...depsOf(counted(client([idle, idle, idle, four(['Done', 'Done', 'Done', 'Done'])])), clock(AT)), onInterventions: (list) => { seen.push(list.length); } });
  assert.deepEqual([seen, reads], [[1, 2, 3], 5], 'four polls and the read at the end; the late one is caught there');

  reads = 0;
  await watchRun(GRAPH, depsOf(counted(client([four(['Done', 'Done', 'Done', 'Done'])])), clock(AT)));
  assert.equal(reads, 0, 'no listener, no read: the harness is unchanged');

  const failing: WatchClient = { ...client([four(['Done', 'Done', 'Done', 'Done'])]), interventions: async () => { throw new Error('GET /benchmark-run: HTTP 404'); } };
  const lines: string[] = [];
  const result = await watchRun(GRAPH, { ...depsOf(failing, clock(AT)), log: (line: string) => { lines.push(line); }, onInterventions: () => assert.fail('nothing to report') });
  assert.deepEqual(result.end, { outcome: 'done' }, 'a failed read never ends the run');
  assert.ok(lines.includes('interventions read failed: GET /benchmark-run: HTTP 404'));
});
