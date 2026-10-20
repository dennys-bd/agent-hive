import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, localActivityId } from '../src/activities.js';
import { localSessionsOf } from '../src/local-sessions.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { sessionsOf } from '../src/tasks.js';
import { capturedCwd } from '../src/terminal-runs.js';
import type { AgentId, HiveEvent, Session, State } from '../src/types.js';
import { withLocal, withWork, workId } from './fixtures/work.js';

test('capturedCwd keeps an absolute folder on one line inside the terminal\'s own, and nothing else (#932)', () => {
  assert.deepEqual(
    ['/r', '/r/src', '/r/..x', '/elsewhere', '/r/../x', 'src', '/r/a\nb', 42].map((value) => capturedCwd(value, '/r')),
    ['/r', '/r/src', '/r/..x', undefined, undefined, undefined, undefined, undefined],
  );
  assert.deepEqual([capturedCwd('/r', undefined), capturedCwd('/r', '')], [undefined, undefined]);
});

const ITEM = { itemId: 'board:I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
const AT = '2026-10-20T10:00:00.000Z';
const S1 = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'; // the task's session
const S2 = '3f2504e0-4f89-11d3-9a0c-0305e82c3302'; // the workspace's local session
const S3 = '3f2504e0-4f89-11d3-9a0c-0305e82c3303'; // a conversation no activity holds
const SHELL = 'bbbbbbbb-0000-4000-8000-000000000001';
const RUN = 'cccccccc-0000-4000-8000-000000000001';
const held = (id: string, tokens: number): Session => ({ id, startedAt: AT, stages: [], lastUsedAt: AT, agent: 'claude', tokens });
// A task on the workspace's checkout (#444) holding S1, the workspace's local activity holding S2, both in /repo, and a live terminal of `on`
// there. No worker can be filled (maxConcurrent 0, not auto)
function world(on: 'task' | 'local'): State {
  const base = withLocal(withWork({
    ...initialState(0), workspaces: ['hive'], stages: [{ name: 'dev', from: {}, prompt: '/build' }],
    tasks: [{ item: ITEM, stage: 'dev', boardColumn: 'Ready', auto: false, workspace: 'hive' }],
  }, ITEM.itemId, { slug: 'hive-1-t', worktree: '/repo', local: true }, { sessions: [held(S1, 900)] }), 'hive', [held(S2, 400)]);
  const activityId = on === 'task' ? workId(base, ITEM.itemId) : localActivityId('hive');
  return { ...base, terminals: [{ terminalId: SHELL, activityId, startedAt: AT, cwd: '/repo' }] };
}
type Resume = Extract<HiveEvent, { type: 'captureSession' }>['resume'];
const capture = (state: State, agent: AgentId, resume?: Resume): State =>
  reduce(state, { type: 'captureSession', terminalId: SHELL, runId: RUN, agent, ...(resume === undefined ? {} : { resume }) }).state;
const runOf = (state: State) => state.workers.find((w) => w.runId === RUN);

test('a resume of a session another activity holds runs in that activity under its id, its tokens the baseline, the session touched and not appended (#347)', () => {
  const state = world('local');
  const owner = workId(state, ITEM.itemId);
  const captured = capture(state, 'claude', { sessionId: S1, activityId: owner });
  const run = runOf(captured);
  assert.deepEqual([run?.activityId, run?.sessionId, run?.resumed, run?.tokens, run?.terminalId, run?.freeSession], [owner, S1, true, 900, SHELL, true]);
  assert.deepEqual(sessionsOf(captured, ITEM.itemId).map((s) => [s.id, s.lastUsedAt]), [[S1, run?.startedAt]]);
  assert.deepEqual(localSessionsOf(captured, 'hive'), localSessionsOf(state, 'hive'), 'the terminal\'s activity records nothing');
});

test('a local resume of a session the workspace holds touches it instead of listing it twice (#347)', () => {
  const captured = capture(world('local'), 'claude', { sessionId: S2, activityId: localActivityId('hive') });
  assert.deepEqual(localSessionsOf(captured, 'hive').map((s) => [s.id, s.lastUsedAt, s.tokens]), [[S2, runOf(captured)?.startedAt, 400]]);
  assert.equal(runOf(captured)?.tokens, 400);
});

test('a resume whose id is not known yet starts in the terminal\'s activity with no id, marked resumed, recording nothing (#347)', () => {
  const state = world('task');
  const captured = capture(state, 'codex', {});
  const run = runOf(captured);
  assert.deepEqual([run?.activityId, run?.sessionId, run?.resumed, run?.agent], [workId(state, ITEM.itemId), undefined, true, 'codex']);
  assert.deepEqual(sessionsOf(captured, ITEM.itemId), sessionsOf(state, ITEM.itemId));
  assert.equal(capture(state, 'claude')?.workers.find((w) => w.runId === RUN)?.resumed, undefined, 'a new conversation is no resume');
});

const started = (state: State, id: string, cwd: string): State =>
  reduce(state, { type: 'hook', ptyId: RUN, payload: { hook_event_name: 'SessionStart', session_id: id, cwd, source: 'resume' } }).state;

test('a resumed capture\'s first SessionStart naming a session another activity holds moves the worker there and touches the session (#347)', () => {
  const state = world('local');
  const captured = capture(state, 'codex', {}); // codex resume --last: the id comes with the SessionStart
  const seen = started(captured, S1, '/repo');
  const run = runOf(seen);
  assert.deepEqual([run?.activityId, run?.sessionId, run?.tokens], [workId(state, ITEM.itemId), S1, 900]);
  assert.deepEqual(sessionsOf(seen, ITEM.itemId).map((s) => [s.id, s.lastUsedAt]), [[S1, run?.startedAt]]);
  assert.deepEqual(localSessionsOf(seen, 'hive'), localSessionsOf(state, 'hive'));
});

test('a resumed capture\'s first SessionStart naming no held session records it in the terminal\'s activity; one its own activity holds is touched, never listed twice (#347)', () => {
  const captured = capture(world('local'), 'claude', {}); // claude -c
  const fresh = started(captured, S3, '/repo/src');
  assert.deepEqual([runOf(fresh)?.activityId, localSessionsOf(fresh, 'hive').map((s) => s.id)], [localActivityId('hive'), [S2, S3]]);
  const own = started(captured, S2, '/repo');
  assert.deepEqual(localSessionsOf(own, 'hive').map((s) => [s.id, s.lastUsedAt]), [[S2, runOf(own)?.startedAt]]);
  assert.equal(runOf(own)?.tokens, 400);
});

test('a resumed capture whose first SessionStart runs outside the terminal\'s folder is released with nothing recorded, and its later hooks find no worker (#347)', () => {
  const state = world('task');
  const captured = capture(state, 'codex', {}); // codex resume of a rollout from another checkout
  const released = started(captured, S3, '/elsewhere');
  assert.equal(runOf(released), undefined);
  assert.deepEqual(sessionsOf(released, ITEM.itemId), sessionsOf(state, ITEM.itemId));
  assert.equal(activityOf(released, ITEM.itemId)?.worktree, '/repo', 'its cwd is never written as the task\'s worktree');
  const stop = reduce(released, { type: 'hook', ptyId: RUN, payload: { hook_event_name: 'Stop', session_id: S3 } });
  assert.equal(stop.state, released);
});

test('a resumed capture whose first SessionStart names a session another live run holds is released, never a second worker on that id (#347)', () => {
  const state = world('local');
  const live = { id: 'w-live', runId: 'dddddddd-0000-4000-8000-000000000001', activityId: workId(state, ITEM.itemId), status: 'working' as const, sessionId: S1, freeSession: true as const };
  const captured = capture({ ...state, workers: [...state.workers, live] }, 'claude', {}); // claude -c picks the live run's conversation
  const released = started(captured, S1, '/repo');
  assert.equal(runOf(released), undefined);
  assert.deepEqual(released.workers.filter((w) => w.sessionId === S1).map((w) => w.runId), [live.runId]);
});
