import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSchedule, initialState, reduce } from '../src/orchestrator.js';
import { releaseWorker, hasRoom, workerCount } from '../src/reducer-kit.js';
import { activityOf, taskOfWorker, withActivity } from '../src/activities.js';
import { slugFor } from '../src/tasks.js';
import { withWork, workId } from './fixtures/work.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { SourceItem, Signal, Worker, State, Item } from '../src/types.js';
import { move, chained } from './fakes.js';

// The user's own sessions (#459): only automation counts as a worker; a session runs in a worker of its own, outside the cap.
const STAGES: LegacyStage[] = [
  { name: 'spec', from: { board: ['Backlog'] }, onFinish: { board: [move('Ready')] }, prompt: '/hive-spec {url}', session: 'new' },
  { name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}', session: 'new' },
];
const WORKTREE = '/tmp/worktrees/hive-1-task-1';
const item = (n: number): Item => ({ itemId: `board:item${n}`, id: String(n), title: `Task ${n}`, body: '', url: `https://github.com/o/r/issues/${n}`, source: 'board' });
const listed = (n: number): SourceItem => ({ item: item(n), column: 'Backlog' });
// n tasks polled into spec under `signal` (up to max start under green), each given a worktree afterwards so a session may open on any
const hive = (max: number, n: number, signal: Signal = 'green'): State => {
  const start: State = { ...initialState(max), signal, workspaces: ['hive'], syncs: { board: {} }, ...chained(STAGES) };
  const polled = reduce(start, { type: 'poll', source: 'board', items: Array.from({ length: n }, (_, i) => listed(i + 1)) }).state;
  // #629: the worktree is each task's activity's: the spawn's own, else a fixture pair
  return polled.tasks.reduce((acc, c) => {
    const live = activityOf(acc, c.item.itemId);
    return live ? withActivity(acc, { ...live, worktree: WORKTREE }) : withWork(acc, c.item.itemId, { slug: slugFor(c.item), worktree: WORKTREE });
  }, polled);
};
const session = (state: State, n = 1) => reduce(state, { type: 'openSession', activityId: workId(state, `board:item${n}`) });
const sessionOf = (s: State): Worker => s.workers.find((x) => x.freeSession)!;
const workers = (s: State): Worker[] => s.workers.filter((x) => x.status !== 'empty' && !x.freeSession);
// The task a worker runs on (#629): its activity's first task
const ownerOf = (s: State, w: Worker): string | undefined => taskOfWorker(s, w)?.item.itemId;
const ownerAt = (s: State, i: number): string | undefined => ownerOf(s, s.workers[i]);

test('workerCount counts occupied workers without free sessions; hasRoom reads it; releaseWorker drops a free session as it drops a draining one and empties a worker (#459)', () => {
  const worker: Worker = { id: 'w', status: 'working', runId: 'w1', activityId: 'a-board:item1' };
  const own: Worker = { id: 's', status: 'waiting', runId: 's1', activityId: 'a-board:item1', freeSession: true };
  const empty: Worker = { id: 'e', status: 'empty' };
  assert.equal(workerCount([worker, own, empty]), 1);
  assert.equal(hasRoom([worker, own, empty], 2), true, 'the session is not a worker');
  assert.equal(hasRoom([worker, own, empty], 1), false, 'the worker alone fills a cap of 1');
  assert.equal(hasRoom([worker, own], 2), false, 'no free worker');
  assert.deepEqual(releaseWorker([worker, own, empty], own), [worker, empty]);
  assert.deepEqual(releaseWorker([worker, own, empty], worker), [{ id: 'w', status: 'empty' }, own, empty]);
});

test('a session opened with every worker free is appended past them, not draining, and the fill then starts as many tasks as there are workers (#459)', () => {
  const yellow = hive(2, 3, 'yellow'); // nothing in flight: nothing starts under yellow
  const { state, effects } = session(yellow, 1);
  assert.deepEqual(state.workers.slice(0, 2), yellow.workers, 'both workers stay the fill\'s, free');
  assert.deepEqual([state.workers.length, sessionOf(state).freeSession, sessionOf(state).draining], [3, true, undefined]);
  assert.deepEqual(effects.map((e) => e.type), ['spawnSession']);
  const green = reduce(state, { type: 'setSignal', signal: 'green' }).state;
  assert.deepEqual(workers(green).map((s) => ownerOf(green, s)), ['board:item2', 'board:item3'], 'two workers; task 1 is held by its session');
});

test('with the cap full of workers a session still opens, appended and not draining; when the worker ends, the fill starts the next task in its worker (#459)', () => {
  const full = hive(1, 2); // task 1 runs in the only worker, task 2 waits
  const worker = full.workers[0].runId!;
  const opened = session(full, 1).state;
  assert.deepEqual([opened.workers.length, opened.workers[0].runId, sessionOf(opened).draining, opened.maxConcurrent], [2, worker, undefined, 1]);
  const next = reduce(opened, { type: 'exit', ptyId: worker }).state;
  assert.deepEqual([next.workers.length, ownerAt(next, 0)], [2, 'board:item2'], 'the session costs the automation no worker');
});

test('canSchedule is true with maxConcurrent 1, one free worker and one open session (#459)', () => {
  const opened = session(hive(1, 1, 'yellow'), 1).state;
  assert.equal(canSchedule({ ...opened, signal: 'green' }, Date.now()), true);
});

test('a session\'s worker leaves state.workers when it ends, by exit or by stop and its exit; the other workers are untouched (#459)', () => {
  const opened = session(hive(2, 1), 1).state; // task 1 runs in worker 1, worker 2 is free, the session is worker 3
  const own = sessionOf(opened).runId!;
  assert.deepEqual(reduce(opened, { type: 'exit', ptyId: own }).state.workers, opened.workers.slice(0, 2));
  const stopped = reduce(opened, { type: 'stop', ptyId: own });
  assert.equal(stopped.state, opened, 'stop only kills: the worker leaves on the exit');
  assert.deepEqual(reduce(stopped.state, { type: 'exit', ptyId: own }).state.workers, opened.workers.slice(0, 2));
});

test('setMax with a session open counts and drains only stage workers and keeps the session as it is; up, it adds max minus workers empty ones (#459)', () => {
  const opened = session(hive(2, 2), 1).state; // tasks 1 and 2 run; the session on task 1 is the third worker
  const own = sessionOf(opened);
  const down = reduce(opened, { type: 'setMax', max: 1 }).state;
  assert.deepEqual(down.workers.map((s) => [ownerOf(down, s), s.draining, s.freeSession]), [
    ['board:item1', undefined, undefined], ['board:item2', true, undefined], ['board:item1', undefined, true],
  ]);
  assert.deepEqual(down.workers[2], own, 'the session worker is kept as it was');
  const up = reduce(down, { type: 'setMax', max: 3 }).state;
  assert.deepEqual(up.workers.map((s) => [s.status === 'empty', s.draining, s.freeSession]), [
    [false, undefined, undefined], [false, undefined, undefined], [false, undefined, true], [true, undefined, undefined],
  ], 'two workers under 3: one empty worker; the session is not counted');
});

test('hive_done in a session still advances its task, and its tokens still land in state.usage, which the budget reads (#459)', () => {
  const opened = session(hive(1, 1, 'yellow'), 1).state;
  const own = sessionOf(opened).runId!;
  const advanced = reduce(opened, { type: 'done', ptyId: own }).state;
  assert.equal(advanced.tasks[0].stage, 'dev');
  const counted = reduce(advanced, { type: 'hook', ptyId: own, payload: { hook_event_name: 'Stop' }, tokens: 500 }).state;
  assert.deepEqual(counted.usage.map((u) => u.tokens), [500]);
  assert.equal(canSchedule({ ...counted, signal: 'green', budget: { maxTokensPerHour: 400 } }, Date.now()), false, 'the budget still counts the session');
});

test('shutdown when done waits for a live session: armed with only a session open, the shutdown comes with its exit (#459)', () => {
  const opened = session(hive(1, 1, 'red'), 1).state; // red (#727): the session's activity makes the task started, which yellow would resume
  const armed = reduce(opened, { type: 'setShutdown', armed: true });
  assert.deepEqual(armed.effects, []);
  assert.deepEqual(reduce(armed.state, { type: 'exit', ptyId: sessionOf(opened).runId! }).effects, [{ type: 'shutdown' }, { type: 'forgetScrollback', ptyId: sessionOf(opened).runId }]);
});

test('openSession carries the open route\'s prompt onto its spawnSession effect; without one the effect has none (#758)', () => {
  const state = hive(1, 1, 'red'); // nothing starts under red; a session still opens
  const [withPrompt] = reduce(state, { type: 'openSession', activityId: workId(state, 'board:item1'), prompt: 'merge main' }).effects;
  const [without] = session(state).effects;
  assert.ok(withPrompt?.type === 'spawnSession' && without?.type === 'spawnSession');
  assert.deepEqual([withPrompt.prompt, 'prompt' in without], ['merge main', false]);
});
