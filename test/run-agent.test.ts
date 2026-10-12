import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, localActivityId, prsOf } from '../src/activities.js';
import { codexRunner } from '../src/agents/codex.js';
import { localSessionsOf } from '../src/local-sessions.js';
import { describeEvent } from '../src/log.js';
import { initialState, reduce, type Reduced } from '../src/orchestrator.js';
import { sessionsOf } from '../src/tasks.js';
import type { AgentId, Effect, HookPayload, Session, Stage, State, Worker } from '../src/types.js';
import { withLocal, withWork, workId } from './fixtures/work.js';
import { CODEX_SESSION, CODEX_TURN, codexHook, PR_URL, QUESTION, SUBAGENT } from './fixtures/codex-hooks.js';

// #925: every run records its agent; #927: the second agent is codex, which picks its own session id
const OTHER: AgentId = 'codex';
const S3 = '3f2504e0-4f89-11d3-9a0c-0305e82c3303';

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
  assert.equal(sessionsOf(own.state, ITEM.itemId).some((s) => s.agent === OTHER), false, 'codex picks its own id: its session is recorded at its SessionStart (#927)');
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

test('a continue stage whose activity holds another agent\'s session spawns a new session with the stage\'s agent (#925)', () => {
  const { state, effects } = start(onDev({ session: 'continue', agent: OTHER }));
  const spawn = spawnOf(effects);
  assert.deepEqual([spawn?.session, spawn?.worker.agent], ['new', OTHER]);
  assert.notEqual(activityOf(state, ITEM.itemId)?.sessionId, S1);
});

test('the same continue stage resumes a session of its own agent (#925)', () => {
  const spawn = spawnOf(start(onDev({ session: 'continue', agent: OTHER }, OTHER)).effects);
  assert.deepEqual([spawn?.session, spawn?.activity.sessionId], ['continue', S1]);
});

const hookStart = (state: State, ptyId: string, id: string): State =>
  reduce(state, { type: 'hook', ptyId, payload: { hook_event_name: 'SessionStart', session_id: id, cwd: '/wt', source: 'startup' } }).state;

test('a codex stage run starts with no session id: not on its worker, not on its activity, and no session is recorded (#927)', () => {
  const { state, effects } = start(onDev({ agent: OTHER }));
  const spawn = spawnOf(effects);
  assert.deepEqual([spawn?.session, spawn?.worker.sessionId, spawn?.activity.sessionId, activityOf(state, ITEM.itemId)?.sessionId], ['new', undefined, undefined, undefined]);
  assert.deepEqual(sessionsOf(state, ITEM.itemId).map((s) => s.id), [S1], 'only the activity\'s earlier claude session');
});

test('codex\'s first SessionStart records its id on the worker, the activity and a session of the running stage; a later one changes nothing (#927)', () => {
  const started = start(onDev({ agent: OTHER }));
  const worker = spawnOf(started.effects)?.worker;
  const ptyId = worker?.runId ?? '';
  const seen = hookStart(started.state, ptyId, S2);
  assert.equal(seen.workers.find((w) => w.runId === ptyId)?.sessionId, S2);
  assert.equal(activityOf(seen, ITEM.itemId)?.sessionId, S2);
  assert.deepEqual(sessionsOf(seen, ITEM.itemId).find((s) => s.id === S2), { id: S2, startedAt: worker?.startedAt, stages: ['dev'], lastUsedAt: worker?.startedAt, agent: OTHER });
  const again = hookStart(seen, ptyId, S3);
  assert.equal(again.workers.find((w) => w.runId === ptyId)?.sessionId, S2, 'the first id wins (#24)');
  assert.equal(activityOf(again, ITEM.itemId)?.sessionId, S2);
  assert.equal(sessionsOf(again, ITEM.itemId).some((s) => s.id === S3), false);
});

test('a continue stage after a codex run resumes the id codex reported (#927)', () => {
  const started = start(onDev({ agent: OTHER, session: 'continue' })); // S1 is claude's: the first run is new
  const ptyId = spawnOf(started.effects)?.worker.runId ?? '';
  const stopped = reduce(hookStart(started.state, ptyId, S2), { type: 'stop', ptyId, cause: 'manual' }).state;
  const spawn = spawnOf(start(reduce(stopped, { type: 'exit', ptyId }).state).effects);
  assert.deepEqual([spawn?.session, spawn?.activity.sessionId], ['continue', S2]);
});

test('a claude stage run keeps the id the Hive chose on its activity, whatever its first SessionStart names: no session is recorded for it (#927)', () => {
  const started = start(onDev({}));
  const ptyId = spawnOf(started.effects)?.worker.runId ?? '';
  const chosen = activityOf(started.state, ITEM.itemId)?.sessionId;
  const seen = hookStart(started.state, ptyId, S3);
  assert.equal(activityOf(seen, ITEM.itemId)?.sessionId, chosen);
  assert.equal(sessionsOf(seen, ITEM.itemId).some((s) => s.id === S3), false);
});

// What the hook route does for a Codex worker (#928): its runner's payload goes to the reducer; a dropped one goes nowhere
const codexHooked = (state: State, ptyId: string, body: HookPayload): Reduced => {
  const payload = codexRunner.hookPayload(body);
  return payload === undefined ? { state, effects: [] } : reduce(state, { type: 'hook', ptyId, payload });
};
const runOf = (state: State, ptyId: string): Worker | undefined => state.workers.find((w) => w.runId === ptyId);
// A codex stage run past its first SessionStart
function codexRun(): { state: State; ptyId: string } {
  const started = start(onDev({ agent: OTHER }));
  const ptyId = spawnOf(started.effects)?.worker.runId ?? '';
  return { state: codexHooked(started.state, ptyId, CODEX_TURN.SessionStart).state, ptyId };
}

test('a codex turn through its runner and the reducer: working on the prompt and the tool, waiting with the approval\'s question, the PR marked, waiting at its Stop (#928)', () => {
  const { state: opened, ptyId } = codexRun();
  assert.equal(runOf(opened, ptyId)?.sessionId, CODEX_SESSION);
  const prompted = codexHooked(opened, ptyId, CODEX_TURN.UserPromptSubmit).state;
  assert.equal(runOf(prompted, ptyId)?.status, 'working');
  const tooled = codexHooked(prompted, ptyId, CODEX_TURN.PreToolUse).state;
  assert.equal(runOf(tooled, ptyId)?.status, 'working');
  const asked = runOf(codexHooked(tooled, ptyId, CODEX_TURN.PermissionRequest).state, ptyId);
  assert.deepEqual([asked?.status, asked?.question, asked?.lastEvent], ['waiting', QUESTION, { kind: 'waiting', detail: 'permission_prompt' }]);
  const approved = codexHooked(codexHooked(tooled, ptyId, CODEX_TURN.PermissionRequest).state, ptyId, CODEX_TURN.PostToolUse).state;
  assert.deepEqual(prsOf(approved, ITEM.itemId).map((pr) => pr.url), [PR_URL], 'the safety net under hive_pr reads Codex\'s Bash call');
  assert.equal(runOf(approved, ptyId)?.status, 'waiting', 'the approval fires no hook: the next PreToolUse or Stop moves the worker (spec)');
  const ended = runOf(codexHooked(approved, ptyId, CODEX_TURN.Stop).state, ptyId);
  assert.deepEqual([ended?.status, ended?.lastEvent], ['waiting', { kind: 'turn' }], 'no background_tasks on a Codex Stop: nothing in flight');
});

test('a codex Stop after hive_done ends its stage: the run is killed (#928)', () => {
  const { state: opened, ptyId } = codexRun();
  const { effects } = codexHooked(reduce(opened, { type: 'done', ptyId }).state, ptyId, CODEX_TURN.Stop);
  assert.ok(effects.some((e) => e.type === 'kill' && e.ptyId === ptyId), JSON.stringify(effects));
});

test('a codex Stop after hive_ask keeps the worker\'s own question with the worker waiting; an approval meanwhile does not replace it (#928)', () => {
  const { state: opened, ptyId } = codexRun();
  const asked = reduce(codexHooked(opened, ptyId, CODEX_TURN.UserPromptSubmit).state, { type: 'ask', ptyId, question: 'Which base?' }).state;
  const approval = codexHooked(asked, ptyId, CODEX_TURN.PermissionRequest).state;
  const parked = runOf(codexHooked(approval, ptyId, CODEX_TURN.Stop).state, ptyId);
  assert.deepEqual([parked?.status, parked?.question, parked?.lastEvent], ['waiting', 'Which base?', { kind: 'ask' }]);
});

test('a codex subagent\'s prompt while the worker waits changes nothing; the same body straight to the reducer would turn it working (#928, finding §11)', () => {
  const { state: opened, ptyId } = codexRun();
  const waiting = codexHooked(opened, ptyId, CODEX_TURN.Stop).state;
  const subagent = codexHook('UserPromptSubmit', { ...SUBAGENT, prompt: 'say hello' }); // the parent's session_id
  assert.equal(codexHooked(waiting, ptyId, subagent).state, waiting);
  assert.equal(runOf(reduce(waiting, { type: 'hook', ptyId, payload: subagent }).state, ptyId)?.status, 'working', 'isChildSession cannot tell it: the same session_id');
});
