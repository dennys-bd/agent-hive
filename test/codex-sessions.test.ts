import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, localActivityId } from '../src/activities.js';
import { codexRunner } from '../src/agents/codex.js';
import { localSessionsOf } from '../src/local-sessions.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { sessionsOf } from '../src/tasks.js';
import type { Effect, HookPayload, Session, State, Worker } from '../src/types.js';
import { withLocal, withWork, workId } from './fixtures/work.js';
import { CODEX_SESSION, CODEX_TURN } from './fixtures/codex-hooks.js';

// #931: Codex's free and local sessions open with no id and take Codex's own from their first SessionStart; then they sleep and wake
const ITEM = { itemId: 'board:I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
const AT = '2026-10-11T10:00:00.000Z';
const S1 = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const LATER = '3f2504e0-4f89-11d3-9a0c-0305e82c3303';
const KEPT: Session = { id: S1, startedAt: AT, stages: ['dev'], lastUsedAt: AT, agent: 'claude' };
// One task in dev, by hand (no fill starts it), its activity holding claude's S1 and its worktree; the workspace's local activity beside it
const onDev = (): State => withLocal(withWork({
  ...initialState(1), workspaces: ['hive'],
  stages: [{ name: 'dev', from: {}, prompt: '/build' }],
  tasks: [{ item: ITEM, stage: 'dev', boardColumn: 'Ready', auto: false, workspace: 'hive' }],
}, ITEM.itemId, { slug: 'hive-1-t', worktree: '/wt', sessionId: S1 }, { sessions: [KEPT] }), 'hive');
type SessionSpawn = Extract<Effect, { type: 'spawnSession' }>;
const spawnOf = (effects: Effect[]) => effects.find((e): e is SessionSpawn => e.type === 'spawnSession');
const runOf = (state: State, ptyId: string): Worker | undefined => state.workers.find((w) => w.runId === ptyId);
// What the hook route does for a Codex run (#928): its runner's payload goes to the reducer, a dropped one nowhere
const hooked = (state: State, ptyId: string, body: HookPayload): State => {
  const payload = codexRunner.hookPayload(body);
  return payload === undefined ? state : reduce(state, { type: 'hook', ptyId, payload }).state;
};
// A new codex session, on the task or in the workspace's local activity, before its first prompt
function opened(where: 'task' | 'local' = 'task'): { state: State; ptyId: string; spawn: SessionSpawn } {
  const state = onDev();
  const event = where === 'task'
    ? { type: 'openSession' as const, activityId: workId(state, ITEM.itemId), agent: 'codex' as const }
    : { type: 'newLocalSession' as const, activityId: localActivityId('hive'), agent: 'codex' as const };
  const { state: next, effects } = reduce(state, event);
  const spawn = spawnOf(effects);
  assert.ok(spawn, 'a spawnSession');
  return { state: next, ptyId: spawn.worker.runId ?? '', spawn };
}

test('a new codex session on a task opens with no id: none on its worker or its spawn, no session recorded, its stage marked (#931)', () => {
  const { state, spawn } = opened();
  assert.deepEqual([spawn.worker.agent, 'sessionId' in spawn.worker, 'sessionId' in spawn, spawn.continues], ['codex', false, false, false]);
  assert.deepEqual(sessionsOf(state, ITEM.itemId).map((s) => s.id), [S1]);
  assert.equal(activityOf(state, ITEM.itemId)?.freeSessionStage, 'dev', 'no continue on dev while it runs (#812)');
  assert.equal(activityOf(state, ITEM.itemId)?.sessionId, S1, 'the stage run\'s session stays the activity\'s');
});

test('a new claude session still opens under the id the Hive chose (#931)', () => {
  const state = onDev();
  const spawn = spawnOf(reduce(state, { type: 'openSession', activityId: workId(state, ITEM.itemId), agent: 'claude' }).effects);
  assert.ok(spawn?.sessionId);
  assert.equal(spawn.worker.sessionId, spawn.sessionId);
});

test('its first SessionStart records Codex\'s id on the worker and appends a free session of codex; a later one changes nothing (#931)', () => {
  const { state, ptyId, spawn } = opened();
  const seen = hooked(state, ptyId, CODEX_TURN.SessionStart);
  const at = spawn.worker.startedAt;
  assert.equal(runOf(seen, ptyId)?.sessionId, CODEX_SESSION);
  assert.deepEqual(sessionsOf(seen, ITEM.itemId).find((s) => s.id === CODEX_SESSION), { id: CODEX_SESSION, startedAt: at, stages: [], lastUsedAt: at, free: true, agent: 'codex' });
  assert.equal(activityOf(seen, ITEM.itemId)?.sessionId, S1, 'a free session never takes the activity\'s id');
  const again = reduce(seen, { type: 'hook', ptyId, payload: { hook_event_name: 'SessionStart', session_id: LATER, cwd: '/wt', source: 'startup' } }).state;
  assert.equal(runOf(again, ptyId)?.sessionId, CODEX_SESSION, 'the first id wins (#24)');
  assert.equal(sessionsOf(again, ITEM.itemId).some((s) => s.id === LATER), false);
});

test('a free codex session goes waiting at its turn\'s end and working on a prompt, through Codex\'s runner (#931)', () => {
  const { state, ptyId } = opened();
  const waiting = hooked(hooked(state, ptyId, CODEX_TURN.SessionStart), ptyId, CODEX_TURN.Stop);
  assert.deepEqual([runOf(waiting, ptyId)?.status, runOf(waiting, ptyId)?.lastEvent], ['waiting', { kind: 'turn' }]);
  assert.equal(runOf(hooked(waiting, ptyId, CODEX_TURN.UserPromptSubmit), ptyId)?.status, 'working');
});

test('a codex session that fails to spawn drops its stage mark and leaves the task\'s sessions as they were (#931)', () => {
  const { state, ptyId } = opened();
  const failed = reduce(state, { type: 'spawnFailed', ptyId, message: 'pty: boom' }).state;
  assert.equal(activityOf(failed, ITEM.itemId)?.freeSessionStage, undefined);
  assert.deepEqual(sessionsOf(failed, ITEM.itemId).map((s) => s.id), [S1]);
});

test('a new local codex session has no entry until its first SessionStart, then one of codex under Codex\'s id (#931)', () => {
  const { state, ptyId, spawn } = opened('local');
  assert.deepEqual(['sessionId' in spawn, 'sessionId' in spawn.worker, localSessionsOf(state, 'hive')], [false, false, []]);
  const at = spawn.worker.startedAt;
  assert.deepEqual(localSessionsOf(hooked(state, ptyId, CODEX_TURN.SessionStart), 'hive'), [{ id: CODEX_SESSION, startedAt: at, stages: [], lastUsedAt: at, agent: 'codex' }]);
});
