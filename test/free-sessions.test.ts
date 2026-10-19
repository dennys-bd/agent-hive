import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSchedule, initialState, reduce } from '../src/orchestrator.js';
import { releaseWorker, hasRoom, workerCount } from '../src/reducer-kit.js';
import { activityOf, resultOf, taskOfWorker, withActivity } from '../src/activities.js';
import { freeEndRefused } from '../src/runs.js';
import { transitionKey } from '../src/transitions.js';
import { slugFor } from '../src/tasks.js';
import { withWork, workId } from './fixtures/work.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { SourceItem, Signal, Stage, Transition, Worker, State, Item } from '../src/types.js';
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
const hive = (max: number, n: number, signal: Signal = 'green', graph: Pick<State, 'stages' | 'transitions'> = chained(STAGES)): State => {
  const start: State = { ...initialState(max), signal, workspaces: ['hive'], syncs: { board: {} }, ...graph };
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

// #339 (#72): Dev's done enters CI, a wait for CI whose only exit is passed, into Gate, an approval stage with no exit of its own
const LATE_STAGES: Stage[] = [
  { name: 'Dev', from: { board: ['Backlog'] }, prompt: '/hive-build {url}' },
  { name: 'CI', from: {}, action: 'waitForCi' },
  { name: 'Gate', from: {}, prompt: '/review {url}', approval: true },
];
const LATE_FLOW: Transition[] = [{ from: 'Dev', to: 'CI', when: 'done' }, { from: 'CI', to: 'Gate', when: 'verdict', verdict: 'passed' }];
const DOCS_PR = 'https://github.com/o/d/pull/2';
// Task 1 in CI under red, so no stage run starts: its free session's done moved it from Dev, and a late one may follow
const inCi = (): { state: State; own: string } => {
  const opened = session(hive(1, 1, 'red', { stages: LATE_STAGES, transitions: LATE_FLOW }), 1).state;
  const own = sessionOf(opened).runId!;
  return { state: reduce(opened, { type: 'done', ptyId: own }).state, own };
};

test('a free session\'s late hive_done in a stage with no done exit ends nothing: the task stays in CI, not stopped, its result merged with no verdict (#339)', () => {
  const { state, own } = inCi();
  assert.equal(state.tasks[0].stage, 'CI', 'Dev has the exit: the first done still advanced the task');
  const after = reduce(state, { type: 'done', ptyId: own, result: { docsPr: DOCS_PR } }).state;
  const live = activityOf(after, 'board:item1');
  assert.deepEqual([after.tasks[0].stage, live?.stopped, live?.error, live?.ci], ['CI', undefined, undefined, activityOf(state, 'board:item1')?.ci], 'the wait for CI goes on');
  assert.deepEqual([resultOf(after, 'board:item1')?.docsPr, resultOf(after, 'board:item1')?.verdict], [DOCS_PR, undefined]);
  assert.deepEqual(reduce(state, { type: 'done', ptyId: own }).state, state, 'with no result nothing changes');
});

test('a free session\'s verdict with no transition and no done fallback, in an action stage, ends nothing and records no verdict (#339)', () => {
  const { state, own } = inCi();
  const after = reduce(state, { type: 'done', ptyId: own, verdict: 'failed', evidence: 'x' }).state;
  const live = activityOf(after, 'board:item1');
  assert.deepEqual([after.tasks[0].stage, live?.stopped, live?.error, resultOf(after, 'board:item1')?.verdict], ['CI', undefined, undefined, undefined]);
});

test('freeEndRefused names the free session\'s exit the stage lacks, and nothing for a stage run, an exit that exists, a pending handoff or an approval stage (#339)', () => {
  const { state, own } = inCi();
  const worker = state.workers.find((w) => w.runId === own)!;
  const task = state.tasks[0];
  assert.deepEqual([freeEndRefused(state, worker, task), freeEndRefused(state, worker, task, 'failed'), freeEndRefused(state, worker, task, 'passed')], ['done', 'verdict:failed', undefined]);
  const { freeSession: _free, ...run } = worker;
  assert.equal(freeEndRefused(state, run, task), undefined, 'a stage run halts as #134 has it');
  assert.equal(freeEndRefused(state, worker, { ...task, stage: 'Gate' }), undefined, 'an approval stage waits for the user');
  const pending = withActivity(state, { ...activityOf(state, 'board:item1')!, handoffPending: transitionKey(LATE_FLOW[1]) });
  assert.equal(freeEndRefused(pending, worker, task), undefined, 'a pending handoff takes its transition');
});

test('a free session\'s done with a handoff pending still takes the pending transition, and in an approval stage still waits for the user (#339)', () => {
  const { state, own } = inCi();
  const pending = withActivity(state, { ...activityOf(state, 'board:item1')!, handoffPending: transitionKey(LATE_FLOW[1]) });
  const inGate = reduce(pending, { type: 'done', ptyId: own }).state;
  assert.equal(inGate.tasks[0].stage, 'Gate');
  const waits = reduce(inGate, { type: 'done', ptyId: own }).state;
  const live = activityOf(waits, 'board:item1');
  assert.deepEqual([waits.tasks[0].stage, live?.stopped, live?.error, live?.approval !== undefined], ['Gate', undefined, undefined, true]);
});
