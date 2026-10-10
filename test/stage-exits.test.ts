import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, type Reduced } from '../src/orchestrator.js';
import { dropWorker, sourceWrites } from '../src/reducer-kit.js';
import { advance } from '../src/transit.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { SourceAction, SourceItem, Task, Effect, State, Item } from '../src/types.js';
import { activityOf, taskOfWorker } from '../src/activities.js';
import { withWork, workId } from './fixtures/work.js';
import { move, chained } from './fakes.js';

// #515: one stage fed by two sources, hive and core, each with its own start and finish list; build hands over to review.
const CLOSE: SourceAction = { type: 'close' };
const BUILD: LegacyStage = {
  name: 'build', from: { hive: ['Ready'], core: ['To Do'] },
  onStart: { hive: [move('In progress'), CLOSE] },
  onFinish: { hive: [move('Review')], core: [move('Done'), { type: 'archive' }] },
  prompt: 'x', maxWorkers: 1,
};
const REVIEW: LegacyStage = { name: 'review', from: { hive: ['Review'] } };
const STAGES = [BUILD, REVIEW];

const item = (source: string, n: number): Item => ({ itemId: `${source}:item${n}`, id: String(n), title: `Task ${n}`, body: '', url: `https://github.com/o/r/issues/${n}`, source });
const listed = (board: string, n: number, column: string): SourceItem => ({ item: item(board, n), column });
const base = (max: number, stages: LegacyStage[] = STAGES): State => ({ ...initialState(max), workspaces: ['hive'], syncs: { hive: {}, core: {} }, ...chained(stages) });
const green = (state: State): Reduced => reduce(state, { type: 'setSignal', signal: 'green' });
const HIVE_TASK = listed('hive', 1, 'Ready');
const CORE_TASK = listed('core', 2, 'To Do');

// The source writes and runs of a reduction, in order, as short words: what these tests compare.
const shown = (effects: Effect[]): string[] => effects.flatMap((e) => {
  if (e.type === 'setColumn') return [`setColumn ${e.column}`];
  if (e.type === 'sourceAction') return [`sourceAction ${e.action.type}`];
  if (e.type === 'spawn') return [`spawn ${e.task.item.itemId}`];
  if (e.type === 'kill' || e.type === 'continue' || e.type === 'deleteActivity') return [e.type];
  return [];
});
const taskOf = (state: State, itemId: string): Task | undefined => state.tasks.find((c) => c.item.itemId === itemId);
const workerOf = (state: State, itemId: string): string => state.workers.find((s) => taskOfWorker(state, s)?.item.itemId === itemId)!.runId!;
// hive_done, then the Stop: what ends a stage
const stageEnd = (state: State, itemId: string): Reduced => {
  const ptyId = workerOf(state, itemId);
  return reduce(reduce(state, { type: 'done', ptyId }).state, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });
};
// Each task polled from its source, in order: the signal starts green, so every poll fills; the effects of every poll, in order.
const running = (stages: LegacyStage[], ...tasks: SourceItem[]): Reduced =>
  tasks.reduce<Reduced>((r, c) => {
    const next = reduce(r.state, { type: 'poll', source: c.item.source!, items: [c] });
    return { state: next.state, effects: [...r.effects, ...next.effects] };
  }, { state: base(2, stages), effects: [] });

test('each source gets its own start list, in order (#515)', () => {
  const hive = running(STAGES, HIVE_TASK);
  assert.deepEqual(shown(hive.effects), ['setColumn In progress', 'sourceAction close', 'spawn hive:item1']);
  assert.equal(taskOf(hive.state, 'hive:item1')?.boardColumn, 'In progress');
  const core = running(STAGES, CORE_TASK);
  assert.deepEqual(shown(core.effects), ['spawn core:item2'], 'core has no start list');
});

test('a stage fed by two sources never runs more than its máx. de workers (#475 reused, #515)', () => {
  const first = running(STAGES, HIVE_TASK, CORE_TASK);
  const spawned = shown(first.effects).filter((e) => e.startsWith('spawn'));
  assert.equal(spawned.length, 1, 'two workers free, cap 1: one run');
  const [ran, other] = spawned[0] === 'spawn hive:item1' ? ['hive:item1', 'core:item2'] : ['core:item2', 'hive:item1'];
  const ended = shown(stageEnd(first.state, ran).effects);
  assert.equal(ended[0], 'kill');
  assert.equal(ended.at(-1), `spawn ${other}`, 'the finish writes first, then the waiting task starts in the same reduction');
});

test('each source gets its own finish list; a list ending in a leaving action holds the task until closeTask (#515)', () => {
  const hive = running(STAGES, HIVE_TASK);
  const hiveEnd = stageEnd(hive.state, 'hive:item1');
  assert.deepEqual(shown(hiveEnd.effects), ['kill', 'setColumn Review']);
  assert.equal(taskOf(hiveEnd.state, 'hive:item1')?.stage, 'review');
  const core = running(STAGES, CORE_TASK);
  const coreEnd = stageEnd(core.state, 'core:item2');
  assert.deepEqual(shown(coreEnd.effects), ['kill', 'setColumn Done', 'sourceAction archive']);
  const leaving = taskOf(coreEnd.state, 'core:item2');
  assert.deepEqual([leaving?.stage, leaving?.leaving], ['build', true]);
  assert.deepEqual(shown(green(coreEnd.state).effects), [], 'a leaving task is out of the fill');
  assert.equal(taskOf(reduce(coreEnd.state, { type: 'closeTask', taskId: 'core:item2' }).state, 'core:item2'), undefined);
});

test('a list runs in its order, and a move to the column the source already shows is skipped (#515)', () => {
  const stages = [{ ...BUILD, onFinish: { hive: [CLOSE, move('In progress')] } }, REVIEW];
  const started = running(stages, HIVE_TASK);
  assert.deepEqual(shown(stageEnd(started.state, 'hive:item1').effects), ['kill', 'sourceAction close']);
});

test('a task the source does not have gets no write from either list (#515)', () => {
  const list: SourceAction[] = [move('Done'), CLOSE, { type: 'archive' }];
  const task: Task = { item: item('hive', 1), stage: 'build', boardColumn: 'Ready', auto: true };
  for (const mark of [{ orphan: true }, { missing: true }, { created: true }] as const) {
    const unwritable = { ...task, ...mark };
    assert.deepEqual(sourceWrites(unwritable, list), { task: unwritable, effects: [] }, JSON.stringify(mark));
  }
  assert.deepEqual(sourceWrites(task, undefined), { task, effects: [] });
});

test('a move from sourceWrites marks the write: the column before is stale, a second move adds the previous target once and never the new one, an empty column marks nothing (#889)', () => {
  const before = Date.now();
  const task: Task = { item: item('hive', 1), stage: 'build', boardColumn: 'Ready', auto: true };
  const one = sourceWrites(task, [move('Review'), CLOSE]).task;
  assert.deepEqual([one.boardColumn, one.columnWrite?.column, one.columnWrite?.stale], ['Review', 'Review', ['Ready']]);
  assert.ok(Date.parse(one.columnWrite!.at) >= before, 'stamped when the write is emitted');
  const two = sourceWrites(one, [move('Done')]).task;
  assert.deepEqual(two.columnWrite?.stale, ['Ready', 'Review'], 'both columns a stale poll may still show');
  assert.deepEqual(sourceWrites(task, [move('Review'), move('Done')]).task.columnWrite?.stale, ['Ready', 'Review'], 'two moves in one list');
  assert.deepEqual(sourceWrites(two, [move('Ready')]).task.columnWrite?.stale, ['Review', 'Done'], 'no duplicates, not the column written');
  assert.deepEqual(sourceWrites({ ...task, boardColumn: '' }, [move('Ready')]).task.columnWrite?.stale, []);
  assert.equal(sourceWrites(one, [move('Review')]).task, one, 'a move the source already shows writes nothing and marks nothing');
});

test('an in-place continuation writes the finish list, then the next stage\'s start list, in order (#515)', () => {
  const next: LegacyStage = { name: 'polish', from: { hive: ['Review'] }, prompt: 'y', session: 'continue', onStart: { hive: [move('Doing'), CLOSE] } };
  const started = running([{ ...BUILD, onStart: undefined }, next], HIVE_TASK);
  const ended = stageEnd(started.state, 'hive:item1');
  assert.deepEqual(shown(ended.effects), ['setColumn Review', 'setColumn Doing', 'sourceAction close', 'continue']);
  assert.equal(taskOf(ended.state, 'hive:item1')?.boardColumn, 'Doing');
});

test('a delete activity stage writes its start list in order, then cleans (#515)', () => {
  const clean: LegacyStage = { name: 'clean', from: { hive: ['Done'] }, action: 'deleteActivity', onStart: { hive: [move('Cleaning'), CLOSE] } };
  const task: Task = { item: item('hive', 1), stage: 'clean', boardColumn: 'Done', auto: true };
  const held = withWork({ ...base(1, [clean]), tasks: [task] }, 'hive:item1', { worktree: '/tmp/worktrees/hive-1-task-1' }); // #629: on its activity
  const cleaned = reduce(held, { type: 'setStages', ...chained([clean]) });
  assert.deepEqual(shown(cleaned.effects), ['setColumn Cleaning', 'sourceAction close', 'deleteActivity']);
  assert.equal(activityOf(cleaned.state, 'hive:item1')?.deleting, true);
});

test('a start action the source refuses while the worker runs only marks the task (#515)', () => {
  const started = running(STAGES, HIVE_TASK);
  const failed = reduce(started.state, { type: 'sourceActionFailed', taskId: 'hive:item1', message: 'drafts cannot be closed', leaving: false });
  const work = activityOf(failed.state, 'hive:item1'); // #629: the run and the error are the activity's
  assert.ok(work?.workerId !== undefined, 'the run goes on');
  assert.equal(work?.error, 'drafts cannot be closed');
  assert.deepEqual(failed.effects, []);
});

test('a failed close ahead of an archive keeps the task leaving, so the archive\'s closeTask still removes it (#515)', () => {
  const stages = [{ ...BUILD, onStart: undefined, onFinish: { hive: [CLOSE, { type: 'archive' } as SourceAction] } }, REVIEW];
  const ended = stageEnd(running(stages, HIVE_TASK).state, 'hive:item1');
  assert.deepEqual(shown(ended.effects), ['kill', 'sourceAction close', 'sourceAction archive']);
  const failed = reduce(ended.state, { type: 'sourceActionFailed', taskId: 'hive:item1', message: 'drafts cannot be closed', leaving: false });
  const task = taskOf(failed.state, 'hive:item1');
  assert.deepEqual([task?.leaving, activityOf(failed.state, 'hive:item1')?.error], [true, 'drafts cannot be closed'], 'still leaving: the archive is in flight');
  assert.equal(taskOf(reduce(failed.state, { type: 'closeTask', taskId: 'hive:item1' }).state, 'hive:item1'), undefined);
});

test('feedback in the same stage re-writes no start action but a move the source does not show (#515)', () => {
  const spec: LegacyStage = { name: 'spec', from: { hive: ['Ready'] }, prompt: 'x', approval: true, onStart: { hive: [move('In progress'), CLOSE] } };
  const next: LegacyStage = { name: 'dev', from: { hive: ['Review'] }, prompt: 'y', session: 'continue' };
  const started = running([spec, next], HIVE_TASK);
  assert.deepEqual(shown(started.effects), ['setColumn In progress', 'sourceAction close', 'spawn hive:item1']);
  const held = stageEnd(started.state, 'hive:item1').state;
  const answered = reduce(held, { type: 'feedback', activityId: workId(held, 'hive:item1'), text: 'again', start: false });
  assert.deepEqual(shown(answered.effects), ['continue'], 'no second close');
});

test('a stage end on a task already leaving writes nothing and keeps the task as it is (#515)', () => {
  const task: Task = { item: item('core', 2), stage: 'build', boardColumn: 'Done', auto: true, leaving: true };
  const state: State = { ...base(1), tasks: [task] };
  const ended = advance(state, task, { trigger: 'done' });
  assert.deepEqual(ended.effects, []);
  assert.deepEqual(ended.state, state);
});

test('a stage end on a task already leaving keeps the caller\'s changes to it, so a Stop still drops its worker (#515)', () => {
  const held: Task = { item: item('core', 2), stage: 'build', boardColumn: 'Done', auto: true, leaving: true };
  const state: State = withWork({ ...base(1), tasks: [held] }, held.item.itemId, { workerId: 's0' }); // #629: the run is the activity's
  const ended = advance(dropWorker(state, held), held, { trigger: 'done' });
  assert.deepEqual(ended.effects, []);
  assert.equal(activityOf(ended.state, held.item.itemId)?.workerId, undefined);
  assert.equal(ended.state.tasks[0]?.leaving, true);
});
