import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveLimits, initialState, reduce, type Reduced } from '../src/orchestrator.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Task, Worker, State, Item, UsageRule } from '../src/types.js';
import { activityOf, taskOfWorker } from '../src/activities.js';
import { move, chained } from './fakes.js';
import { activityIdOf, withWork, type WithWork, workId } from './fixtures/work.js';

// spec hands over to build, which goes on in the session: a spec end can continue in place into build (#475)
const STAGES: LegacyStage[] = [
  { name: 'spec', from: { board: ['Backlog'] }, onFinish: { board: [move('Ready')] }, prompt: '/hive-spec {url}' },
  { name: 'build', from: { board: ['Ready'] }, prompt: '/hive-build {url}', session: 'continue' },
  { name: 'review', from: { board: ['In review'] } },
];
const base = (max: number, stages: LegacyStage[]): State => ({ ...initialState(max), workspaces: ['hive'], syncs: { board: {} }, ...chained(stages) });
const capped = (cap: number, stages: LegacyStage[] = STAGES): LegacyStage[] => stages.map((s) => (s.name === 'build' ? { ...s, maxWorkers: cap } : s));
// With no reading the week window reads 0, so a percent 0 rule always fires
const ALWAYS = (rule: Pick<UsageRule, 'maxWorkers' | 'stage'>): UsageRule => ({ source: 'week', percent: 0, ...rule });
const WORKER = 'aaaaaaaa-0000-4000-8000-000000000009';
const item = (n: number): Item => ({ itemId: `board:item${n}`, id: String(n), title: `Task ${n}`, body: '', url: `https://github.com/o/r/issues/${n}`, source: 'board' });
const waiting = (n: number, stage: string): Task => ({ item: item(n), stage, boardColumn: stage, auto: true });
const withTasks = (max: number, stages: LegacyStage[], tasks: Task[]): State => ({ ...base(max, stages), tasks });
const green = (state: State): Reduced => reduce(state, { type: 'setSignal', signal: 'green' }); // any event that fills
const spawned = ({ effects }: Reduced): string[] => effects.flatMap((e) => (e.type === 'spawn' ? [e.task.item.id] : []));
const workerOf = (state: State, n: number): string => state.workers.find((s) => taskOfWorker(state, s)?.item.itemId === `board:item${n}`)!.runId!;
// hive_done, then the Stop: what ends a stage
const stageEnd = (state: State, ptyId: string): Reduced =>
  reduce(reduce(state, { type: 'done', ptyId }).state, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });

test('effectiveLimits reports each stage\'s cap and the fired stage rules at it, and keeps stage rules out of maxWorkers, the floor and capRules (#475)', () => {
  const now = Date.now();
  const own = effectiveLimits(base(2, capped(3)), now);
  assert.deepEqual([own.stageCaps, own.stageCapRules], [{ build: 3 }, {}], 'a cap from the stage alone: no rule behind it');
  const staged = ALWAYS({ maxWorkers: 1, stage: 'build' });
  assert.deepEqual(effectiveLimits({ ...base(2, capped(3)), usageRules: [staged] }, now), {
    signal: 'green', floor: { signal: 'green' }, signalRules: [], capRules: [], disabledRules: [], stageCaps: { build: 1 }, stageCapRules: { build: [staged] },
  }, 'the header\'s cap is untouched: WorkerCap reads capRules');
  const both = effectiveLimits({ ...base(3, STAGES), usageRules: [staged, ALWAYS({ maxWorkers: 1 })] }, now);
  assert.deepEqual([both.maxWorkers, both.capRules, both.stageCapRules], [1, [ALWAYS({ maxWorkers: 1 })], { build: [staged] }], 'the same cap on both sides: each rule on its own side');
});

test('a stage at its cap is skipped and the free worker goes to the next task of another stage; 0 pauses the stage (#475)', () => {
  const tasks = [waiting(1, 'build'), waiting(2, 'build'), waiting(3, 'spec')];
  assert.deepEqual(spawned(green(withTasks(2, STAGES, tasks))), ['1', '2'], 'no cap: build first, in the Hive\'s order (#316)');
  assert.deepEqual(spawned(green(withTasks(2, capped(1), tasks))), ['1', '3'], 'build full at 1: task 2 waits, spec takes the worker');
  const paused = green(withTasks(2, capped(0), tasks));
  assert.deepEqual(spawned(paused), ['3']);
  assert.equal(paused.state.workers.filter((s) => s.status === 'empty').length, 1, 'no other task to hand it to: the worker stays free');
});

test('the stage room is recounted after every spawn of one fill round (#475)', () => {
  const tasks = [waiting(1, 'build'), waiting(2, 'build'), waiting(3, 'build'), waiting(4, 'spec')];
  assert.deepEqual(spawned(green(withTasks(3, capped(2), tasks))), ['1', '2', '4']);
});

test('a worker held for approval counts against its stage cap as well as the global one (#268, #475, #727)', () => {
  const held: Worker = { id: 'held', status: 'approval', runId: WORKER, activityId: activityIdOf('board:item9') };
  const parked: WithWork = { ...waiting(9, 'build'), workerId: 'held', approval: { since: new Date().toISOString() } };
  const state: State = withWork({ ...withTasks(2, capped(1), [parked, waiting(1, 'build')]), workers: [held, { id: 'free', status: 'empty' }] }, 'board:item9');
  assert.deepEqual(spawned(green(state)), [], 'build\'s one place is the held worker\'s');
  const roomy: State = { ...state, ...chained(capped(2)) };
  assert.deepEqual(spawned(green(roomy)), ['1'], 'with room for two the waiting task starts');
  assert.deepEqual(spawned(green({ ...roomy, usageRules: [ALWAYS({ maxWorkers: 1 })] })), [], 'a global cap of 1 is met by the held worker');
});

test('a free session in a stage at maxWorkers 2 takes neither place: the fill takes a second worker (#459, #475, #727)', () => {
  const session: Worker = { id: 'mine', status: 'working', runId: WORKER, activityId: activityIdOf('board:item9'), freeSession: true };
  const state: State = withWork({
    ...withTasks(2, capped(2), [waiting(9, 'build'), waiting(1, 'build'), waiting(2, 'build')]),
    workers: [{ id: 'a', status: 'empty' }, { id: 'b', status: 'empty' }, session],
  }, 'board:item9');
  assert.deepEqual(spawned(green(state)), ['1', '2']);
});

test('a stage rule that fires over the running workers kills and drains nothing; the stage takes no task until it is under its cap (#475)', () => {
  const two = green(withTasks(2, STAGES, [waiting(1, 'build'), waiting(2, 'build'), waiting(3, 'build')])).state;
  const fired = reduce(two, { type: 'setUsageRules', usageRules: [ALWAYS({ maxWorkers: 1, stage: 'build' })] });
  assert.deepEqual(fired.effects, []);
  assert.deepEqual(fired.state.workers.map((s) => [s.status, s.draining]), [['working', undefined], ['working', undefined]]);
  const one = reduce(fired.state, { type: 'exit', ptyId: workerOf(fired.state, 1) });
  assert.deepEqual(spawned(one), [], 'build still runs 1, its cap');
  const zero = reduce(one.state, { type: 'exit', ptyId: workerOf(one.state, 2) });
  assert.deepEqual(spawned(zero), ['3']);
});

test('an in-place continuation needs room under the next stage\'s cap: without it the run ends and the task waits in that stage\'s queue (#475)', () => {
  const tasks = [waiting(1, 'build'), waiting(2, 'spec')];
  const open = green(withTasks(2, STAGES, tasks)).state;
  assert.deepEqual(stageEnd(open, workerOf(open, 2)).effects.map((e) => e.type), ['setColumn', 'continue'], 'no cap: spec goes on into build in place');
  const full = green(withTasks(2, capped(1), tasks)).state;
  const { state, effects } = stageEnd(full, workerOf(full, 2));
  assert.deepEqual(effects.map((e) => e.type), ['kill', 'setColumn', 'forgetScrollback'], 'build is at its cap of 1: the run ends and the freed worker takes nothing');
  const moved = state.tasks.find((c) => c.item.itemId === 'board:item2')!;
  assert.deepEqual([moved.stage, activityOf(state, 'board:item2')?.workerId], ['build', undefined]); // #629: the activity's
});

test('Aprovar on a held worker whose next stage is at its cap ends the held run and leaves the task in that stage\'s queue (#268, #475)', () => {
  const gated = capped(1).map((s) => (s.name === 'spec' ? { ...s, approval: true as const } : s));
  const running = green(withTasks(2, gated, [waiting(1, 'build'), waiting(2, 'spec')])).state;
  const ptyId = workerOf(running, 2);
  const held = stageEnd(running, ptyId).state;
  assert.equal(held.workers.find((s) => s.runId === ptyId)?.status, 'approval');
  const { state, effects } = reduce(held, { type: 'approve', activityId: workId(held, 'board:item2') });
  assert.deepEqual(effects.map((e) => e.type), ['setColumn', 'release', 'kill'], 'no continue, and no spawn: build is full');
  const moved = state.tasks.find((c) => c.item.itemId === 'board:item2')!;
  const work = activityOf(state, 'board:item2'); // #629: the run fields are the activity's
  assert.deepEqual([moved.stage, work?.workerId, work !== undefined && 'approval' in work], ['build', undefined, false]);
});

test('a manual start ignores the stage cap, as it ignores the global one (#116, #475)', () => {
  const paused = green(withTasks(1, capped(0), [waiting(1, 'build')]));
  assert.deepEqual(spawned(paused), []);
  assert.deepEqual(spawned(reduce(paused.state, { type: 'start', itemId: 'board:item1' })), ['1']);
});
