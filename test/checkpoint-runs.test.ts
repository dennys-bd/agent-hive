import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/orchestrator.js';
import { activityOf, withActivity } from '../src/activities.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Checkpoint, Item, State } from '../src/types.js';
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
const withCheckpoints = (state: State, checkpoints: Checkpoint[]): State => withActivity(state, { ...activityOf(state, ID)!, checkpoints });

test('deleting the activity forgets its checkpoints: the fresh activity that keeps the stopped mark holds none (#619)', () => {
  const idle = withCheckpoints(stopped(running([SPEC, NEW_DEV])), [A1]);
  const marked = reduce(idle, { type: 'deletingActivity', activityId: workId(idle, ID) }).state;
  const removed = reduce(marked, { type: 'activityRemoved', activityId: workId(marked, ID) }).state;
  assert.equal(activityOf(removed, ID)?.stopped, true, 'the mark is kept on a fresh activity (#629)');
  assert.equal(activityOf(removed, ID)?.checkpoints, undefined);
});
