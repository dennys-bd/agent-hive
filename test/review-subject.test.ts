import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localActivityId } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import type { Deliver } from '../src/review-deliver.js';
import { createReviewStore } from '../src/review-store.js';
import { localSubject, taskSubject } from '../src/review-subject.js';
import type { Session, Task } from '../src/types.js';
import { withLocal, withWork } from './fixtures/work.js';
import { tempDir } from './temp-dir.js';

const AT = '2026-10-14T10:00:00.000Z';
const TASK_SESSION = 'aaaaaaaa-1111-4111-8111-111111111111';
const LOCAL_SESSION = 'eeeeeeee-5555-4555-8555-555555555555';
const session = (id: string, agent: Session['agent']): Session => ({ id, startedAt: AT, stages: [], agent, lastUsedAt: AT });
const TASK: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'T', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true };
const STATE = withLocal(withWork({ ...initialState(0), workspaces: ['hive'], tasks: [TASK] }, 'local:1', {}, { sessions: [session(TASK_SESSION, 'claude')] }), 'hive', [session(LOCAL_SESSION, 'codex')]);

// A delivery and an event that only record what they were called with
function recorder() {
  const calls: string[] = [];
  const deliver: Deliver = async (key, to) => { calls.push(`deliver ${key} ${to}`); return { ok: true, session: to }; };
  return { calls, deliver, notify: (key: string) => { calls.push(`notify ${key}`); } };
}

test('a local subject keys the store by workspace, guards by its local activity id, and takes only its local sessions or new (#344)', async (t) => {
  const store = createReviewStore(await tempDir(t, 'reviews-'), () => true);
  const r = recorder();
  const subject = localSubject({ localReviews: store, notifyLocalReview: r.notify, deliverLocal: r.deliver }, STATE, 'hive');
  assert.deepEqual([subject.key, subject.guard, subject.store === store], ['hive', localActivityId('hive'), true]);
  assert.deepEqual([LOCAL_SESSION, 'new', TASK_SESSION, 7].map((id) => subject.isSession(id)), [true, true, false, false]);
  assert.deepEqual([subject.agentOf(LOCAL_SESSION), subject.agentOf('new')], ['codex', 'claude'], 'its record\'s agent; a new session the default');
  await subject.deliver(LOCAL_SESSION, 'hi');
  subject.notify();
  assert.deepEqual(r.calls, [`deliver hive ${LOCAL_SESSION}`, 'notify hive']);
});

test('a task subject keeps its item id as key and guard, and never takes a local session (#591, #344)', async (t) => {
  const store = createReviewStore(await tempDir(t, 'reviews-'), () => true);
  const r = recorder();
  const subject = taskSubject({ reviews: store, notifyReview: r.notify, deliver: r.deliver }, STATE, TASK);
  assert.deepEqual([subject.key, subject.guard], ['local:1', 'local:1']);
  assert.deepEqual([TASK_SESSION, 'new', LOCAL_SESSION].map((id) => subject.isSession(id)), [true, true, false]);
  assert.equal(subject.agentOf(TASK_SESSION), 'claude');
  await subject.deliver(TASK_SESSION, 'hi');
  subject.notify();
  assert.deepEqual(r.calls, [`deliver local:1 ${TASK_SESSION}`, 'notify local:1']);
});
