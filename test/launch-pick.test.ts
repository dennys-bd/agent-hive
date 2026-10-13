import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localActivityId } from '../src/activities.js';
import { codexRunner } from '../src/agents/codex.js';
import { savedLaunch } from '../src/launch-pick.js';
import { localSessionsOf } from '../src/local-sessions.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { savedSession } from '../src/state-guards.js';
import { sessionsOf } from '../src/tasks.js';
import type { Effect, LaunchPick, Session, State } from '../src/types.js';
import { CODEX_SESSION, CODEX_TURN } from './fixtures/codex-hooks.js';
import { withLocal, withWork, workId } from './fixtures/work.js';

// #257: a free session keeps what it was opened with (model, specialized agent, args) on its worker and its record; a resume runs with the record's
const ITEM = { itemId: 'board:I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
const AT = '2026-10-13T10:00:00.000Z';
const S1 = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const L1 = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';
const PICK: LaunchPick = { model: 'opus', specializedAgent: 'hive:designer', args: ['--verbose'] };
const KEPT_PICK: LaunchPick = { model: 'sonnet' };
const KEPT: Session = { id: S1, startedAt: AT, stages: ['dev'], lastUsedAt: AT, agent: 'claude', launch: KEPT_PICK };
const LOCAL: Session = { id: L1, startedAt: AT, stages: [], lastUsedAt: AT, agent: 'claude', launch: KEPT_PICK };
// One task in dev with its worktree and claude's S1, the workspace's local activity holding L1
const onDev = (kept: Session = KEPT): State => withLocal(withWork({
  ...initialState(1), workspaces: ['hive'],
  stages: [{ name: 'dev', from: {}, prompt: '/build' }],
  tasks: [{ item: ITEM, stage: 'dev', boardColumn: 'Ready', auto: false, workspace: 'hive' }],
}, ITEM.itemId, { slug: 'hive-1-t', worktree: '/wt', sessionId: S1 }, { sessions: [kept] }), 'hive', [LOCAL]);
type SessionSpawn = Extract<Effect, { type: 'spawnSession' }>;
const spawnOf = (effects: Effect[]) => effects.find((e): e is SessionSpawn => e.type === 'spawnSession');
// What the hook route does with a Codex run's first SessionStart (#928)
const started = (state: State, ptyId: string): State => {
  const payload = codexRunner.hookPayload(CODEX_TURN.SessionStart);
  return payload === undefined ? state : reduce(state, { type: 'hook', ptyId, payload }).state;
};

test('openSession with a launch puts it on the worker and on the new free session (#257)', () => {
  const state = onDev();
  const { state: next, effects } = reduce(state, { type: 'openSession', activityId: workId(state, ITEM.itemId), agent: 'claude', launch: PICK });
  const spawn = spawnOf(effects);
  assert.deepEqual(spawn?.worker.launch, PICK);
  assert.deepEqual(sessionsOf(next, ITEM.itemId).find((s) => s.id === spawn?.sessionId)?.launch, PICK);
});

test('a resume runs with its record\'s launch, never the event\'s, and leaves the record\'s as it was; a record with none runs with none (#257)', () => {
  const state = onDev();
  const activityId = workId(state, ITEM.itemId);
  const resumed = reduce(state, { type: 'openSession', activityId, continueId: S1, launch: PICK });
  assert.deepEqual(spawnOf(resumed.effects)?.worker.launch, KEPT_PICK);
  assert.deepEqual(sessionsOf(resumed.state, ITEM.itemId).find((s) => s.id === S1)?.launch, KEPT_PICK);
  const { launch: _kept, ...bare } = KEPT;
  const plain = onDev(bare);
  const worker = spawnOf(reduce(plain, { type: 'openSession', activityId: workId(plain, ITEM.itemId), continueId: S1, launch: PICK }).effects)?.worker;
  assert.equal(worker !== undefined && 'launch' in worker, false);
});

test('newLocalSession puts its launch on the worker and the entry; openLocalSession runs with the entry\'s (#257)', () => {
  const state = onDev();
  const fresh = reduce(state, { type: 'newLocalSession', activityId: localActivityId('hive'), agent: 'claude', launch: PICK });
  const spawn = spawnOf(fresh.effects);
  assert.deepEqual(spawn?.worker.launch, PICK);
  assert.deepEqual(localSessionsOf(fresh.state, 'hive').find((s) => s.id === spawn?.sessionId)?.launch, PICK);
  const continued = spawnOf(reduce(state, { type: 'openLocalSession', activityId: localActivityId('hive'), sessionId: L1 }).effects);
  assert.deepEqual(continued?.worker.launch, KEPT_PICK);
});

test('a codex session opened with a launch records it at its first SessionStart, on a task and in a workspace (#257)', () => {
  const state = onDev();
  const onTask = reduce(state, { type: 'openSession', activityId: workId(state, ITEM.itemId), agent: 'codex', launch: PICK });
  const taskRun = spawnOf(onTask.effects)?.worker.runId ?? '';
  assert.deepEqual(sessionsOf(started(onTask.state, taskRun), ITEM.itemId).find((s) => s.id === CODEX_SESSION)?.launch, PICK);
  const local = reduce(state, { type: 'newLocalSession', activityId: localActivityId('hive'), agent: 'codex', launch: PICK });
  const localRun = spawnOf(local.effects)?.worker.runId ?? '';
  assert.deepEqual(localSessionsOf(started(local.state, localRun), 'hive').find((s) => s.id === CODEX_SESSION)?.launch, PICK);
});

test('a saved session keeps its launch only in the shape the open routes admit, field by field (#257)', () => {
  const base = { id: S1, startedAt: AT, stages: [], lastUsedAt: AT, agent: 'claude' };
  assert.deepEqual(savedSession({ ...base, launch: PICK })[0]?.launch, PICK);
  assert.deepEqual(savedSession({ ...base, launch: { model: '--settings', specializedAgent: 'other:x', args: ['--verbose'] } })[0]?.launch, { args: ['--verbose'] });
  assert.equal('launch' in (savedSession({ ...base, launch: { model: 7, args: ['a\u0000b'] } })[0] ?? {}), false);
  assert.deepEqual(savedLaunch({ args: Array.from({ length: 33 }, () => '-v') }), {});
  assert.deepEqual(savedLaunch({ model: 'm'.repeat(101) }), {});
  assert.deepEqual(savedLaunch({ args: [] }), {});
});
