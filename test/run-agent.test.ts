import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localActivityId } from '../src/activities.js';
import { localSessionsOf } from '../src/local-sessions.js';
import { describeEvent } from '../src/log.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { sessionsOf } from '../src/tasks.js';
import type { AgentId, Effect, Session, Stage, State } from '../src/types.js';
import { withLocal, withWork, workId } from './fixtures/work.js';

// #925: every run records its agent. AGENT_IDS holds only claude until 3.1; the reducer only compares and copies ids, so a second agent
// is a cast
const OTHER = 'other' as AgentId;

const ITEM = { itemId: 'board:I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
const AT = '2026-10-11T10:00:00.000Z';
const S1 = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const S2 = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';
const SHELL = 'bbbbbbbb-0000-4000-8000-000000000001';
const RUN = 'cccccccc-0000-4000-8000-000000000001';
const kept = (agent: AgentId): Session => ({ id: S1, startedAt: AT, stages: ['spec'], lastUsedAt: AT, agent });
// One task in `dev`, its activity holding S1 (recorded as `agent`'s) with its worktree, the workspace's local activity beside it
const onDev = (dev: Partial<Stage>, agent: AgentId = 'claude', extra: Partial<State> = {}): State => withLocal(withWork({
  ...initialState(1), workspaces: ['hive'], ...extra,
  stages: [{ name: 'dev', from: {}, prompt: '/build', ...dev }],
  tasks: [{ item: ITEM, stage: 'dev', boardColumn: 'Ready', auto: true, workspace: 'hive' }],
}, ITEM.itemId, { slug: 'hive-1-t', worktree: '/wt', sessionId: S1 }, { sessions: [kept(agent)] }), 'hive');
const spawnOf = (effects: Effect[]) => effects.find((e): e is Extract<Effect, { type: 'spawn' }> => e.type === 'spawn');
const start = (state: State) => reduce(state, { type: 'start', itemId: ITEM.itemId });
const localWorker = (state: State) => state.workers.find((w) => w.activityId === localActivityId('hive'));

test('setDefaultAgent puts the config\'s default agent on the live state with no effect, and the log names it (#925)', () => {
  const { state, effects } = reduce(initialState(1), { type: 'setDefaultAgent', agent: OTHER });
  assert.deepEqual([state.defaultAgent, effects], [OTHER, []]);
  assert.equal(describeEvent({ type: 'setDefaultAgent', agent: 'claude' }), 'setDefaultAgent claude');
});

test('a stage run\'s worker and the session it records carry the stage\'s agent, else the live default (#925)', () => {
  const own = start(onDev({ agent: OTHER }));
  assert.equal(spawnOf(own.effects)?.worker.agent, OTHER);
  assert.equal(sessionsOf(own.state, ITEM.itemId).at(-1)?.agent, OTHER);
  assert.equal(spawnOf(start(onDev({}, 'claude', { defaultAgent: OTHER })).effects)?.worker.agent, OTHER);
});

test('openSession records the agent asked for on a new session; a resumed session runs its own agent, whatever was asked (#925)', () => {
  const state = onDev({});
  const activityId = workId(state, ITEM.itemId);
  const opened = reduce(state, { type: 'openSession', activityId, agent: OTHER }).state;
  const fresh = opened.workers.find((w) => w.freeSession);
  assert.equal(fresh?.agent, OTHER);
  assert.equal(sessionsOf(opened, ITEM.itemId).find((s) => s.id === fresh?.sessionId)?.agent, OTHER);
  const resumed = reduce(state, { type: 'openSession', activityId, continueId: S1, agent: OTHER }).state;
  assert.equal(resumed.workers.find((w) => w.freeSession)?.agent, 'claude', 'S1 is claude\'s');
});

test('a copy runs and records its source\'s agent; a new local session the one asked for; the shim\'s capture is claude\'s (#925)', () => {
  const source = onDev({}, OTHER);
  const copied = reduce(source, { type: 'copySession', from: { activityId: workId(source, ITEM.itemId), sessionId: S1 }, to: { activityId: localActivityId('hive') } }).state;
  assert.deepEqual([localSessionsOf(copied, 'hive').at(-1)?.agent, localWorker(copied)?.agent], [OTHER, OTHER]);
  const fresh = reduce(onDev({}), { type: 'newLocalSession', activityId: localActivityId('hive'), agent: OTHER }).state;
  assert.deepEqual([localSessionsOf(fresh, 'hive').at(-1)?.agent, localWorker(fresh)?.agent], [OTHER, OTHER]);
  const shell = { ...onDev({}, 'claude', { defaultAgent: OTHER }), terminals: [{ terminalId: SHELL, activityId: localActivityId('hive'), startedAt: AT, cwd: '/repo' }] };
  const captured = reduce(shell, { type: 'captureSession', terminalId: SHELL, runId: RUN, sessionId: S2 }).state;
  assert.deepEqual([localSessionsOf(captured, 'hive').at(-1)?.agent, localWorker(captured)?.agent], ['claude', 'claude'], 'the shim wraps claude only');
});

test('a run that sleeps records its worker\'s agent (#925)', () => {
  const started = start(onDev({ agent: OTHER }));
  const ptyId = spawnOf(started.effects)?.worker.runId ?? '';
  const seen = reduce(started.state, { type: 'hook', ptyId, payload: { hook_event_name: 'SessionStart', session_id: S2, cwd: '/wt' } }).state;
  const stopped = reduce(seen, { type: 'stop', ptyId, cause: 'manual' }).state;
  assert.equal(reduce(stopped, { type: 'exit', ptyId }).state.slept?.[0]?.agent, OTHER);
});
