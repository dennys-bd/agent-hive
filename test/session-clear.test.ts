import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/orchestrator.js';
import { activityOf, localActivityId, recordOf } from '../src/activities.js';
import { localSessionsOf } from '../src/local-sessions.js';
import { clearSession } from '../src/session-clear.js';
import type { Task, Session, Worker, State } from '../src/types.js';
import { activityIdOf, withKeptRecord, withLocal, withWork } from './fixtures/work.js';

// A /clear (#655): the run's conversation is replaced, so its entry takes the new id and forgets what described the old transcript. The
// entry sits in a record, the session id a continue resumes on the activity (#629).
const OLD = 'a1b2c3d4-0000-4000-8000-000000000001';
const NEW = 'a1b2c3d4-0000-4000-8000-000000000002';
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000003';
const T0 = '2026-09-29T10:00:00.000Z';
const T1 = '2026-09-30T09:00:00.000Z';
const ITEM = 'local:1';
const ACTIVITY = activityIdOf(ITEM);
const entry = (id: string, extra: Partial<Session> = {}): Session => ({ id, startedAt: T0, stages: ['spec', 'dev'], lastUsedAt: T1, tokens: 1200, name: 'review', ...extra });
const renamed: Session = { id: NEW, startedAt: T0, stages: ['spec', 'dev'], lastUsedAt: T1 }; // no tokens, no name
const task: Task = {
  item: { itemId: ITEM, id: 'HIVE-1', title: 'task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'dev', workspace: 'hive', created: true, auto: false,
};
const worker = (extra: Partial<Worker> = {}): Worker => ({ id: 'w1', runId: 'r1', status: 'working', sessionId: OLD, tokens: 1200, ...extra });
// The task's live activity with `sessionId`, its record holding `sessions`, and the workspace's local pair
const hive = (workers: Worker[], sessions: Session[], sessionId?: string): State =>
  withLocal(withWork({ ...initialState(0), workspaces: ['hive'], workers, tasks: [task] }, ITEM, sessionId === undefined ? {} : { sessionId }, { sessions }), 'hive');
const sessionsIn = (state: State, id: string): Session[] | undefined => recordOf(state, id)?.sessions;

test('clearSession renames a stage run\'s session to the new id, keeping startedAt, stages and lastUsedAt and dropping tokens and name; the activity\'s sessionId follows; the worker carries the new id and no baseline; the input is untouched (#655, #629)', () => {
  const run = worker({ activityId: ACTIVITY });
  const before = hive([run], [entry(OTHER), entry(OLD)], OLD);
  const frozen = structuredClone(before);
  const state = clearSession(before, run, NEW);
  assert.deepEqual(before, frozen, 'the input is not mutated');
  assert.deepEqual(state.workers, [{ id: 'w1', runId: 'r1', status: 'working', activityId: ACTIVITY, sessionId: NEW }]);
  assert.deepEqual(sessionsIn(state, ACTIVITY), [entry(OTHER), renamed], 'only the cleared conversation\'s entry changes, in place');
  assert.equal(activityOf(state, ITEM)?.sessionId, NEW);
});

test('clearSession on a free session renames only its own entry: the activity\'s sessionId stays the stage run\'s (#655)', () => {
  const run = worker({ activityId: ACTIVITY, freeSession: true });
  const state = clearSession(hive([run], [entry(OTHER), entry(OLD)], OTHER), run, NEW);
  assert.deepEqual(sessionsIn(state, ACTIVITY), [entry(OTHER), renamed]);
  assert.equal(activityOf(state, ITEM)?.sessionId, OTHER);
});

test('clearSession on an activity whose record has no entry for the run moves the activity\'s sessionId only (#655, #629)', () => {
  const run = worker({ activityId: ACTIVITY });
  const before = hive([run], [], OLD);
  const state = clearSession(before, run, NEW);
  assert.deepEqual([activityOf(state, ITEM)?.sessionId, sessionsIn(state, ACTIVITY)], [NEW, []]);
});

test('clearSession on a free session resumed from a deleted activity\'s record renames the entry in that record (#655, #208, #629)', () => {
  const kept = '00000000-0000-4000-8000-000000000009';
  const run = worker({ activityId: ACTIVITY, freeSession: true });
  const before = withKeptRecord(hive([run], [entry(OTHER)], OTHER), ITEM, kept, { sessions: [entry(OLD, { repo: true })] });
  const state = clearSession(before, run, NEW);
  assert.deepEqual(sessionsIn(state, kept), [{ ...renamed, repo: true }]);
  assert.deepEqual([sessionsIn(state, ACTIVITY), activityOf(state, ITEM)?.sessionId], [[entry(OTHER)], OTHER]);
});

test('clearSession on a local run renames the entry in its workspace\'s local record; the task\'s activity and record are not touched (#655, #629)', () => {
  const run = worker({ activityId: localActivityId('hive'), freeSession: true });
  const base = hive([run], [entry(OTHER)], OTHER);
  const before = withLocal(base, 'hive', [entry(OTHER, { stages: ['local'] }), entry(OLD)]);
  const state = clearSession(before, run, NEW);
  assert.deepEqual(localSessionsOf(state, 'hive'), [entry(OTHER, { stages: ['local'] }), renamed]);
  assert.deepEqual([sessionsIn(state, ACTIVITY), state.activities], [[entry(OTHER)], before.activities]);
  assert.equal(state.workers[0].sessionId, NEW);
});

test('clearSession on a run with no recorded session patches the worker only (#655)', () => {
  const run = worker({ activityId: ACTIVITY, sessionId: undefined });
  const before = hive([run], [entry(OLD)], OLD);
  const state = clearSession(before, run, NEW);
  assert.deepEqual([state.workers[0].sessionId, 'tokens' in state.workers[0]], [NEW, false]);
  assert.equal(state.activityRecords, before.activityRecords);
  assert.equal(state.activities, before.activities);
});
