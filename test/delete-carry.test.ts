import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/orchestrator.js';
import { activityOf, recordsOf, withActivity } from '../src/activities.js';
import { ensureActivity } from '../src/reducer-kit.js';
import { nothingToDelete, slugOwner } from '../src/tasks.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Activity, Item, Session, SourceItem, State } from '../src/types.js';
import { chained } from './fakes.js';
import { withKeptRecord } from './fixtures/work.js';

// What a delete carries over to the task's next activity (#629): everything main's forget kept on the task, the activity's run fields
// worktree, branch, sessionId, worktreeGone, deleting, setup and workerId excepted.

const ID = 'board:item1';
const WT = '/wt/hive-1-task-1';
const PAST = '2026-09-20T10:00:00.000Z';
const item = (n: number): Item => ({ itemId: `board:item${n}`, id: String(n), title: `Task ${n}`, body: '', url: `https://github.com/o/r/issues/${n}`, source: 'board' });
const listed = (n: number, column: string): SourceItem => ({ item: item(n), column });
const session = (id: string, stage: string, extra: Partial<Session> = {}): Session => ({ id, startedAt: PAST, stages: [stage], lastUsedAt: PAST, ...extra });
const GATE: LegacyStage[] = [
  { name: 'review', from: { board: ['Review'] }, approval: true },
  { name: 'dev', from: { board: ['Ready'] }, prompt: 'x' },
];
const DELETE_THEN_DEV: LegacyStage[] = [
  { name: 'done', from: { board: ['Done'] }, action: 'deleteActivity', after: '5d' },
  { name: 'dev', from: { board: ['Ready'] }, prompt: 'x' },
];
const DEV: LegacyStage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: 'x' }];

const polled = (stages: LegacyStage[], column: string, n = 1): State =>
  reduce({ ...initialState(1), signal: 'red', workspaces: ['hive'], syncs: { board: {} }, ...chained(stages) }, { type: 'poll', source: 'board', items: Array.from({ length: n }, (_, i) => listed(i + 1, column)) }).state;
const live = (s: State, id = ID): Activity | undefined => activityOf(s, id);
// The task's live activity with `extra` merged in, born first when it has none
function withLive(s: State, extra: Partial<Activity>): State {
  const born = ensureActivity(s, s.tasks.find((t) => t.item.itemId === ID)!);
  assert.ok(born, 'the fixture needs a live activity');
  return withActivity(born.state, { ...born.activity, ...extra });
}
const removed = (s: State): State => {
  const marked = reduce(s, { type: 'deletingActivity', activityId: live(s)!.id }).state;
  assert.equal(live(marked)?.deleting, true, 'the route marked it');
  return reduce(marked, { type: 'activityRemoved', activityId: live(marked)!.id }).state;
};
const fieldsOf = (a: Activity | undefined): Partial<Activity> | undefined => {
  if (!a) return undefined;
  const { id: _a, kind: _k, workspace: _w, slug: _s, ...rest } = a;
  return rest;
};

test('a delete outside a delete activity stage carries a pending approval, a queued handover, the local and base choices, the stage start to the fresh activity; only the run fields go (#629)', () => {
  const gated = polled(GATE, 'Review'); // review is a manual gate: its activity awaits approval from the entry
  const approval = live(gated)?.approval;
  assert.ok(approval, 'the gate task awaits approval');
  const given = withLive(gated, {
    worktree: WT, branch: 'hive/1-task-1', sessionId: 'old-session', worktreeGone: true, handover: { prompt: 'redo it' }, local: true,
    base: { ref: 'hive/41-parent', tellWorker: true }, stageStart: { stage: 'review', commit: 'abc123' },
  });
  const after = removed(given);
  assert.notEqual(live(after)?.id, live(given)?.id, 'a fresh activity');
  assert.deepEqual(fieldsOf(live(after)), {
    approval, handover: { prompt: 'redo it' }, local: true, base: { ref: 'hive/41-parent', tellWorker: true }, stageStart: { stage: 'review', commit: 'abc123' },
  });
  assert.equal(reduce(after, { type: 'approve', activityId: live(after)!.id }).state.tasks[0].stage, 'dev', 'approve still finds the task: it is not stuck in the gate');
});

test('a delete in a delete activity stage carries local and base into the next stage, whose spawn runs in the checkout from the chosen base; the entry still drops what it always dropped (#629)', () => {
  const given = withLive(polled(DELETE_THEN_DEV, 'Done'), { worktree: WT, local: true, base: { ref: 'hive/41-parent', tellWorker: false }, stopped: true, handover: { prompt: 'old' } });
  const marked = reduce(given, { type: 'deletingActivity', activityId: live(given)!.id }).state;
  const { state, effects } = reduce({ ...marked, signal: 'green' }, { type: 'activityRemoved', activityId: live(marked)!.id });
  assert.equal(state.tasks[0].stage, 'dev');
  const spawn = effects.find((e) => e.type === 'spawn');
  assert.ok(spawn?.type === 'spawn', 'the next stage spawns');
  assert.deepEqual([spawn.activity.local, spawn.activity.base], [true, { ref: 'hive/41-parent', tellWorker: false }]);
  assert.deepEqual([spawn.activity.stopped, spawn.activity.handover, spawn.activity.worktree], [undefined, undefined, undefined], 'the entry drops stopped and a handover, as main\'s enter did');
});

test('a delete activity stage\'s own deleteActivity answer carries local and base too (#629)', () => {
  const given = withLive(polled(DELETE_THEN_DEV, 'Done'), { worktree: WT, local: true, base: { ref: 'main', tellWorker: false }, deleting: true });
  const { state } = reduce(given, { type: 'activityDeleted', activityId: live(given)!.id });
  assert.deepEqual([state.tasks[0].stage, live(state)?.local, live(state)?.base], ['dev', true, { ref: 'main', tellWorker: false }]);
});

test('continue on a deleted activity\'s record resumes its session in a new activity (#629)', () => {
  const given = withLive(polled(DEV, 'Ready'), { worktree: WT, sessionId: 'kept-session-0001', stopped: true });
  const withSession = { ...given, activityRecords: given.activityRecords.map((r) => (r.id === live(given)!.id ? { ...r, sessions: [session('kept-session-0001', 'dev')] } : r)) };
  const { stopped: _stopped, ...unstopped } = live(withSession)!;
  const stripped = removed(withActivity(withSession, unstopped));
  assert.equal(live(stripped), undefined, 'no mark: no activity left');
  const recordId = recordsOf(stripped, ID).at(-1)!.id;
  const { state, effects } = reduce(stripped, { type: 'continue', activityId: recordId });
  const spawn = effects.find((e) => e.type === 'spawn');
  assert.ok(spawn?.type === 'spawn', 'continue spawns');
  assert.deepEqual([spawn.session, live(state)?.sessionId, live(state)?.id === recordId], ['continue', 'kept-session-0001', false]);
});

test('with scope.session on, a delete drops every record\'s sessions, and nothingToDelete counts them all (#629)', () => {
  const base = { ...polled(DEV, 'Ready'), deleteActivity: { session: true, transcripts: false, nonAutoTasks: false } };
  const kept = withKeptRecord(base, ID, 'old-record', { sessions: [session('old-session', 'dev', { repo: true })] });
  assert.equal(nothingToDelete(kept, kept.tasks[0], kept.deleteActivity), false, 'the kept record\'s session is something to delete');
  assert.equal(nothingToDelete(kept, kept.tasks[0], { ...kept.deleteActivity, session: false }), true, 'without the sessions in scope only a worktree counts');
  const after = removed(withLive(kept, { worktree: WT }));
  assert.deepEqual(recordsOf(after, ID).flatMap((r) => r.sessions), [], 'every record\'s sessions go');
});

test('a task whose deleted activity\'s record still holds sessions owns its slug (#180, #629)', () => {
  const two = polled(DEV, 'Ready', 2);
  // board:item2 takes item1's slug: two unqualified sources, same id and title
  const clash: State = { ...two, tasks: two.tasks.map((t) => (t.item.itemId === 'board:item2' ? { ...t, item: { ...t.item, id: '1', title: 'Task 1' } } : t)) };
  const kept = withKeptRecord(clash, ID, 'old-record', { slug: 'hive-1-task-1', sessions: [session('old-session', 'dev', { repo: true })] });
  const other = kept.tasks.find((t) => t.item.itemId === 'board:item2')!;
  assert.equal(slugOwner(kept, other, 'hive')?.item.itemId, ID);
  const empty = withKeptRecord(clash, ID, 'old-record', { slug: 'hive-1-task-1', sessions: [] });
  assert.equal(slugOwner(empty, other, 'hive'), undefined, 'a record with no session holds nothing');
});

test('a delete-activity stage forgets the kept sessions of a task with no activity, and its deleteActivity effect runs so the transcripts go (#629)', () => {
  const stages: LegacyStage[] = [{ name: 'done', from: { board: ['Done'] }, action: 'deleteActivity' }, ...DEV];
  const ready = { ...polled(stages, 'Ready'), deleteActivity: { session: true, transcripts: true, nonAutoTasks: true } };
  const kept = withKeptRecord(ready, ID, 'old-record', { sessions: [session('old-session', 'dev', { repo: true })] });
  assert.equal(live(kept), undefined, 'the task has no activity');
  const { state, effects } = reduce(kept, { type: 'poll', source: 'board', items: [listed(1, 'Done')] });
  const effect = effects.find((e) => e.type === 'deleteActivity');
  assert.ok(effect?.type === 'deleteActivity', 'the stage deletes instead of only moving on');
  assert.deepEqual(effect.scope, state.deleteActivity);
  assert.equal(live(state)?.deleting, true, 'the activity it deletes through is marked');
  const after = reduce(state, { type: 'activityDeleted', activityId: effect.activity.id }).state;
  assert.deepEqual(recordsOf(after, ID).flatMap((r) => r.sessions), [], 'every record\'s sessions go');
});
