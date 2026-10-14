import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localActivityId } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import { type DeliverDeps, deliver, deliverLocal } from '../src/review-deliver.js';
import type { Task, Effect, HiveEvent, Worker, State } from '../src/types.js';
import { activityIdOf, withLocal, withWork } from './fixtures/work.js';

const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const AT = '2026-09-29T10:00:00.000Z';
const TASK: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'T', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true };
const PASTE = (text: string): string => `\x1b[200~${text}\x1b[201~\r`;

// A state holder whose dispatch answers an openSession with a spawnSession and a worker that sees its first hook `hookAfterMs` later (never when undefined)
function fake(workers: Worker[], hookAfterMs?: number, isPty = true) {
  let state: State = withWork({ ...initialState(0), tasks: [TASK], workers }, 'local:1', { worktree: '/wt' }, { sessions: [{ id: S1, startedAt: AT, stages: ['fila'], agent: 'claude', lastUsedAt: AT }] });
  const events: HiveEvent[] = [];
  const written: [string, string][] = [];
  const deps: DeliverDeps = {
    state: () => state,
    dispatch: async (event) => {
      events.push(event);
      if (event.type !== 'openSession') return [];
      const worker: Worker = { id: 'X', runId: 'W9', activityId: activityIdOf('local:1'), status: 'working', freeSession: true, sessionId: event.continueId ?? 'fresh-session-0001' };
      state = { ...state, workers: [...state.workers, worker] };
      if (hookAfterMs !== undefined) setTimeout(() => { state = { ...state, workers: state.workers.map((s) => (s.runId === 'W9' ? { ...s, seenAt: AT } : s)) }; }, hookAfterMs);
      return [{ type: 'spawnSession', worker, task: TASK, sessionId: worker.sessionId, continues: event.continueId !== undefined } as Effect];
    },
    started: async () => undefined,
    write: (ptyId, data) => { written.push([ptyId, data]); return isPty; },
    waitMs: 200, pollMs: 5,
  };
  return { deps, events, written };
}

test('a live session gets the text as a bracketed paste then Enter, with nothing opened; a gone pty is a failure (#591)', async () => {
  const live: Worker = { id: 'A', runId: 'W1', activityId: activityIdOf('local:1'), status: 'working', sessionId: S1 };
  const f = fake([live]);
  assert.deepEqual(await deliver(f.deps, 'local:1', S1, 'hi'), { ok: true, session: S1 });
  assert.deepEqual([f.written, f.events], [[['W1', PASTE('hi')]], []]);
  const gone = fake([live], undefined, false);
  assert.equal((await deliver(gone.deps, 'local:1', S1, 'hi')).ok, false);
});

test('the delivered text loses its controls, so an excerpt holding ESC [201~ cannot close the paste (#591)', async () => {
  const live: Worker = { id: 'A', runId: 'W1', activityId: activityIdOf('local:1'), status: 'working', sessionId: S1 };
  const f = fake([live]);
  await deliver(f.deps, 'local:1', S1, 'x\x1b[201~rm -rf .\r\ny');
  assert.deepEqual(f.written, [['W1', PASTE('x[201~rm -rf .\ny')]]);
});

test('a stopped session is resumed and written once its run saw its first hook; a new one is opened (#591)', async () => {
  const f = fake([], 20);
  assert.deepEqual(await deliver(f.deps, 'local:1', S1, 'hi'), { ok: true, session: S1 });
  assert.deepEqual(f.events, [{ type: 'openSession', activityId: activityIdOf('local:1'), continueId: S1 }]); // #629: the session's record
  assert.deepEqual(f.written, [['W9', PASTE('hi')]]);
  const fresh = fake([], 20);
  assert.deepEqual(await deliver(fresh.deps, 'local:1', 'new', 'hi'), { ok: true, session: 'fresh-session-0001' });
  assert.deepEqual(fresh.events, [{ type: 'openSession', activityId: activityIdOf('local:1') }]); // the live activity
});

test('no first hook within the wait, or a session the task cannot resume, is a failure with nothing written (#591)', async () => {
  const slow = fake([]);
  assert.equal((await deliver(slow.deps, 'local:1', S1, 'hi')).ok, false);
  assert.deepEqual(slow.written, []);
  const unknown = fake([]);
  assert.equal((await deliver(unknown.deps, 'local:1', 'other-session-0001', 'hi')).ok, false);
  assert.deepEqual(unknown.events, [], 'never dispatched');
});

test('a live session showing a prompt, a question or a held Stop is refused with nothing written; one idle after its turn takes the paste (#591)', async () => {
  const at = (status: Worker['status'], kind?: 'waiting' | 'ask' | 'turn'): Worker => ({ id: 'A', runId: 'W1', activityId: activityIdOf('local:1'), status, sessionId: S1, ...(kind ? { lastEvent: { kind } } : {}) });
  for (const worker of [at('waiting', 'waiting'), at('waiting', 'ask'), at('waiting'), at('approval')]) {
    const f = fake([worker]);
    const delivery = await deliver(f.deps, 'local:1', S1, 'hi');
    assert.equal(delivery.ok, false, JSON.stringify(worker));
    assert.deepEqual([f.written, f.events], [[], []]);
  }
  const idle = fake([at('waiting', 'turn')]);
  assert.deepEqual(await deliver(idle.deps, 'local:1', S1, 'hi'), { ok: true, session: S1 });
});

const L1 = 'eeeeeeee-5555-4555-8555-555555555555';
const LOCAL = localActivityId('hive');

// Workspace hive with task 1 (session S1) and a local session L1. Its dispatch answers openLocalSession or newLocalSession with a spawnSession
// and a local worker that sees its first hook `hookAfterMs` later (never when undefined)
function fakeLocal(workers: Worker[], hookAfterMs?: number) {
  const base = withWork({ ...initialState(0), workspaces: ['hive'], tasks: [TASK], workers }, 'local:1', { worktree: '/wt' }, { sessions: [{ id: S1, startedAt: AT, stages: ['fila'], agent: 'claude', lastUsedAt: AT }] });
  let state: State = withLocal(base, 'hive', [{ id: L1, startedAt: AT, stages: [], agent: 'claude', lastUsedAt: AT }]);
  const events: HiveEvent[] = [];
  const written: [string, string][] = [];
  const deps: DeliverDeps = {
    state: () => state,
    dispatch: async (event) => {
      events.push(event);
      if (event.type !== 'openLocalSession' && event.type !== 'newLocalSession') return [];
      const sessionId = event.type === 'openLocalSession' ? event.sessionId : 'fresh-session-0001';
      const worker: Worker = { id: 'X', runId: 'W9', activityId: LOCAL, status: 'working', freeSession: true, sessionId };
      state = { ...state, workers: [...state.workers, worker] };
      if (hookAfterMs !== undefined) setTimeout(() => { state = { ...state, workers: state.workers.map((s) => (s.runId === 'W9' ? { ...s, seenAt: AT } : s)) }; }, hookAfterMs);
      return [{ type: 'spawnSession', worker, activity: { id: LOCAL, kind: 'local', workspace: 'hive' }, sessionId, continues: event.type === 'openLocalSession' } as Effect];
    },
    started: async () => undefined,
    write: (ptyId, data) => { written.push([ptyId, data]); return true; },
    waitMs: 200, pollMs: 5,
  };
  return { deps, events, written };
}

test('deliverLocal pastes into the live local run holding the session, with nothing opened (#344)', async () => {
  const live: Worker = { id: 'A', runId: 'W1', activityId: LOCAL, status: 'working', sessionId: L1 };
  const f = fakeLocal([live]);
  assert.deepEqual(await deliverLocal(f.deps, 'hive', L1, 'hi'), { ok: true, session: L1 });
  assert.deepEqual([f.written, f.events], [[['W1', PASTE('hi')]], []]);
});

test('deliverLocal resumes a stopped local session in the main checkout, or opens a new one, and pastes once its first hook lands (#344)', async () => {
  const f = fakeLocal([], 20);
  assert.deepEqual(await deliverLocal(f.deps, 'hive', L1, 'hi'), { ok: true, session: L1 });
  assert.deepEqual(f.events, [{ type: 'openLocalSession', activityId: LOCAL, sessionId: L1 }]);
  assert.deepEqual(f.written, [['W9', PASTE('hi')]]);
  const fresh = fakeLocal([], 20);
  assert.deepEqual(await deliverLocal(fresh.deps, 'hive', 'new', 'hi'), { ok: true, session: 'fresh-session-0001' });
  assert.deepEqual(fresh.events, [{ type: 'newLocalSession', activityId: LOCAL }]);
});

test('deliverLocal never reaches a task\'s session or an unknown workspace, and refuses a local run showing a prompt (#344)', async () => {
  const taskRun: Worker = { id: 'A', runId: 'W1', activityId: activityIdOf('local:1'), status: 'working', sessionId: S1 };
  const f = fakeLocal([taskRun]);
  assert.equal((await deliverLocal(f.deps, 'hive', S1, 'hi')).ok, false);
  assert.equal((await deliverLocal(f.deps, 'site', 'new', 'hi')).ok, false);
  assert.deepEqual([f.written, f.events], [[], []], 'nothing pasted, nothing opened');
  const prompting = fakeLocal([{ id: 'B', runId: 'W2', activityId: LOCAL, status: 'approval', sessionId: L1 }]);
  assert.equal((await deliverLocal(prompting.deps, 'hive', L1, 'hi')).ok, false);
  assert.deepEqual(prompting.written, []);
});
