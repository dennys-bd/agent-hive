import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/orchestrator.js';
import { activityOf, withActivity } from '../src/activities.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Checkpoint, Effect, Item, State } from '../src/types.js';
import { move, chained } from './fakes.js';
import { workId } from './fixtures/work.js';

// Stage checkpoints in the reducer (#619)
const SPEC: LegacyStage = { name: 'spec', from: { board: ['Backlog'] }, onFinish: { board: [move('Ready')] }, prompt: '/hive:new-spec {url}' };
const DEV: LegacyStage = { name: 'dev', from: { board: ['Ready'] }, prompt: '/hive:new-build {url}', session: 'continue' }; // goes on in place
const NEW_DEV: LegacyStage = { ...DEV, session: 'new' };
const ID = 'board:item1';
const WORKTREE = '/tmp/worktrees/hive-1-task-1';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const A1: Checkpoint = { n: 1, stage: 'spec', start: 'a1b2c3d', head: 'b2c3d4e', commit: 'c3d4e5f', branch: 'hive/1-task-1', at: '2026-10-10T10:00:00.000Z', ended: 'done' };
const types = (effects: Effect[]): string[] => effects.map((e) => e.type);
// Task 1 polled into spec and running in the only worker, green; with `seen` its SessionStart recorded the worktree, which a capture needs
function running(stages: LegacyStage[], seen = true): State {
  const polled = reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, ...chained(stages) }, { type: 'poll', source: 'board', items: [{ item, column: 'Backlog' }] }).state;
  const ptyId = polled.workers[0].runId!;
  return seen ? reduce(polled, { type: 'hook', ptyId, payload: { hook_event_name: 'SessionStart', cwd: WORKTREE }, branch: 'hive/1-task-1' }).state : polled;
}
// The run's exit under red: the task stopped in spec, nothing respawns
const stopped = (state: State): State => {
  const ptyId = state.workers[0].runId!;
  return reduce(reduce(state, { type: 'setSignal', signal: 'red' }).state, { type: 'exit', ptyId }).state;
};
// hive_done then the Stop: what ends a stage
const stageEnd = (state: State) => {
  const ptyId = state.workers[0].runId!;
  return reduce(reduce(state, { type: 'done', ptyId }).state, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });
};
const withCheckpoints = (state: State, checkpoints: Checkpoint[]): State => withActivity(state, { ...activityOf(state, ID)!, checkpoints });

test('deleting the activity forgets its checkpoints: the fresh activity that keeps the stopped mark holds none (#619)', () => {
  const idle = withCheckpoints(stopped(running([SPEC, NEW_DEV])), [A1]);
  const marked = reduce(idle, { type: 'deletingActivity', activityId: workId(idle, ID) }).state;
  const removed = reduce(marked, { type: 'activityRemoved', activityId: workId(marked, ID) }).state;
  assert.equal(activityOf(removed, ID)?.stopped, true, 'the mark is kept on a fresh activity (#629)');
  assert.equal(activityOf(removed, ID)?.checkpoints, undefined);
});

const capture = (effects: Effect[]) => (effects[0]?.type === 'captureCheckpoint' ? effects[0] : undefined);

test('a stage end that goes on in place captures its checkpoint before the continue, with the activity as it was in that stage (#619)', () => {
  const first = running([SPEC, DEV]);
  const frozen = structuredClone(first);
  const { effects } = stageEnd(first);
  assert.deepEqual(first, frozen, 'the input is never mutated');
  const effect = capture(effects);
  assert.ok(effect, JSON.stringify(types(effects)));
  assert.deepEqual([effect.stage, effect.ended, effect.activity.id, effect.task.item.itemId], ['spec', 'done', workId(first, ID), ID]);
  assert.ok(types(effects).indexOf('continue') > 0, 'the continue comes after the capture');
});

test('an approval hold and a handoff request capture first too; a task with no worktree recorded captures nothing (#619)', () => {
  const held = stageEnd(running([{ ...SPEC, approval: true }, DEV])).effects;
  assert.deepEqual([types(held)[0], types(held).includes('hold')], ['captureCheckpoint', true]);
  const asked = stageEnd(running([SPEC, { ...NEW_DEV, handoff: true }])).effects;
  assert.deepEqual([types(asked)[0], types(asked).includes('continue')], ['captureCheckpoint', true]);
  assert.equal(types(stageEnd(running([SPEC, NEW_DEV], false)).effects).includes('captureCheckpoint'), false);
});

test('a free session\'s hive_done captures the checkpoint first, as a stage end does (#619)', () => {
  const idle = stopped(running([SPEC, NEW_DEV]));
  const opened = reduce(idle, { type: 'openSession', activityId: workId(idle, ID) }).state;
  const session = opened.workers.find((w) => w.freeSession)!.runId!;
  const { effects } = reduce(opened, { type: 'done', ptyId: session });
  assert.deepEqual([capture(effects)?.stage, capture(effects)?.ended], ['spec', 'done']);
});

test('checkpointCaptured appends in capture order and ignores an n already there or an unknown activity (#619)', () => {
  const idle = stopped(running([SPEC, NEW_DEV]));
  const id = workId(idle, ID);
  const one = reduce(idle, { type: 'checkpointCaptured', activityId: id, checkpoint: A1 }).state;
  const two = reduce(one, { type: 'checkpointCaptured', activityId: id, checkpoint: { ...A1, n: 2, ended: 'restart' } }).state;
  assert.deepEqual(activityOf(two, ID)?.checkpoints?.map((a) => [a.n, a.ended]), [[1, 'done'], [2, 'restart']]);
  assert.equal(reduce(two, { type: 'checkpointCaptured', activityId: id, checkpoint: { ...A1, ended: 'restore' } }).state, two);
  assert.equal(reduce(two, { type: 'checkpointCaptured', activityId: 'none', checkpoint: { ...A1, n: 3 } }).state, two);
});

test('restoring marks a task in any stage, stage start or not, unless a run of any kind holds it or another git job does (#619)', () => {
  const idle = stopped(running([SPEC, NEW_DEV])); // no stageStart: a restore needs none
  const marked = reduce(idle, { type: 'restoring', itemId: ID }).state;
  assert.equal(activityOf(marked, ID)?.deleting, true);
  assert.equal(reduce(marked, { type: 'restoring', itemId: ID }).state, marked, 'one git job at a time');
  const opened = reduce(idle, { type: 'openTerminal', activityId: workId(idle, ID) }).state;
  assert.equal(reduce(opened, { type: 'restoring', itemId: ID }).state, opened, 'a terminal on the task');
  const live = running([SPEC, NEW_DEV]);
  assert.equal(reduce(live, { type: 'restoring', itemId: ID }).state, live, 'the stage run');
});

test('restored drops the mark and records a new branch, keeping the stage, the column, the start and the stop; restoreFailed only drops the mark (#619)', () => {
  const idle = stopped(running([SPEC, NEW_DEV]));
  const recorded = reduce(idle, { type: 'stageStarted', activityId: workId(idle, ID), stage: 'spec', commit: 'a1b2c3d' }).state;
  const marked = reduce(recorded, { type: 'restoring', itemId: ID }).state;
  const { state, effects } = reduce(marked, { type: 'restored', itemId: ID, branch: 'hive/1-task-1-r2' });
  const work = activityOf(state, ID)!;
  assert.deepEqual(
    [effects, work.deleting, work.branch, work.stageStart, work.stopped, state.tasks[0].stage, state.tasks[0].boardColumn],
    [[], undefined, 'hive/1-task-1-r2', { stage: 'spec', commit: 'a1b2c3d' }, true, 'spec', 'Backlog'],
  );
  assert.equal(activityOf(reduce(marked, { type: 'restored', itemId: ID }).state, ID)?.branch, 'hive/1-task-1', 'no branch: the task keeps its own');
  assert.equal(activityOf(reduce(marked, { type: 'restoreFailed', itemId: ID }).state, ID)?.deleting, undefined);
  assert.equal(reduce(recorded, { type: 'restored', itemId: ID }).state, recorded, 'unmarked: ignored');
});
