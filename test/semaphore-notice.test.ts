import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/orchestrator.js';
import { noticeText } from '../src/semaphore-notice.js';
import type { Effect, HookPayload, Item, SemaphoreWaiter, State, Worker } from '../src/types.js';
import { APPROVAL_HOLD_MAX_MIN } from '../src/types.js';
import { chained, STAGES } from './fakes.js';
import { workId } from './fixtures/work.js';

const NOW = Date.parse('2026-11-13T10:00:00.000Z');
const MINUTE = 60_000;
const ID = 'board:item1';
const ITEM: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const TEST = ['pnpm', 'test'];
const UNTIL = new Date(2026, 10, 13, 10, 32).toISOString(); // 10:32 in the machine's own zone, whatever it is
const NOTICE = noticeText('memory', TEST, UNTIL);
const HOLD_END = new Date(NOW + APPROVAL_HOLD_MAX_MIN * MINUTE).toISOString();

// #799, decision 13: the hold's end is the only clock the rules read; the tests fix it
const fixed = (t: TestContext): void => { t.mock.timers.enable({ apis: ['Date'], now: NOW }); };
// Task 1 running fila (fakes' one stage) in the only worker
const running = (): State =>
  reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, ...chained(STAGES) }, { type: 'poll', source: 'board', items: [{ item: ITEM, column: 'Ready' }] }).state;
// The user's own session on task 1, appended beside the stage run (#459); the stage run's SessionStart records the worktree it needs (#208)
const withFree = (s: State): { state: State; free: string } => {
  const seen = reduce(s, { type: 'hook', ptyId: ptyOf(s), payload: { hook_event_name: 'SessionStart', cwd: '/tmp/worktrees/hive-1-task-1' } }).state;
  const opened = reduce(seen, { type: 'openSession', activityId: workId(seen, ID) }).state;
  return { state: opened, free: opened.workers.find((w) => w.freeSession === true)?.runId ?? '' };
};
const ptyOf = (s: State): string => s.workers[0]?.runId ?? '';
const workerOf = (s: State, ptyId: string): Worker | undefined => s.workers.find((w) => w.runId === ptyId);
const lineOf = (s: State, waiter: SemaphoreWaiter) => reduce(s, { type: 'setSemaphores', semaphores: { memory: { runs: ['other'], line: [waiter] } } });
const inLine = (s: State, ptyId: string): State => lineOf(s, { ptyId, place: 1 }).state;
const inTurn = (s: State, ptyId: string): State => lineOf(s, { ptyId, place: 0, turnUntil: UNTIL }).state;
const stop = (s: State, ptyId: string, payload: Partial<HookPayload> = {}) => reduce(s, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop', ...payload } });
const turn = (s: State, ptyId: string) => reduce(s, { type: 'semaphoreTurn', ptyId, semaphore: 'memory', argv: TEST, until: UNTIL });
const answers = (effects: Effect[]) => effects.map((e) => (e.type === 'continue' ? [e.type, e.ptyId, e.stage.name, e.prompt] : [e.type, 'ptyId' in e ? e.ptyId : undefined])); // not every effect names a pty

test('noticeText: both sentences with the local HH:MM; without until, the first only; a word sh would split is quoted (#799)', () => {
  assert.equal(NOTICE, 'Your turn on the semaphore `memory` came: run `pnpm test` now. Its permit is held for you until 10:32.');
  assert.equal(noticeText('memory', ['vitest', 'run', 'a b.test.ts', '--reporter=dot']), 'Your turn on the semaphore `memory` came: run `vitest run \'a b.test.ts\' --reporter=dot` now.');
  assert.equal(noticeText('disk', ['echo', 'a\x1b[201~b']), 'Your turn on the semaphore `disk` came: run `echo \'a[201~b\'` now.', 'no control reaches the paste (#483)');
});

test('a stage run that stops with a place in memory holds its Stop, green, its last event kept; the turn answers it with a continue naming memory and pnpm test (#799)', (t) => {
  fixed(t);
  const first = running();
  const ptyId = ptyOf(first);
  const lastEvent = workerOf(first, ptyId)?.lastEvent;
  const stopped = stop(inLine(first, ptyId), ptyId);
  assert.deepEqual(stopped.effects, [{ type: 'hold', ptyId, until: HOLD_END }]);
  const held = workerOf(stopped.state, ptyId);
  assert.deepEqual([held?.status, held?.lastEvent, held?.semaphoreHold], ['working', lastEvent, HOLD_END]);
  const came = turn(stopped.state, ptyId);
  assert.deepEqual(answers(came.effects), [['continue', ptyId, 'fila', NOTICE]]);
  assert.match(NOTICE, /`memory`.*`pnpm test`/);
  assert.equal(workerOf(came.state, ptyId)?.semaphoreHold, undefined, 'the hold is gone');
});

test('a run working, or a session idle at its prompt, gets the notice typed into its pty and keeps it (#799)', (t) => {
  fixed(t);
  const first = running();
  const ptyId = ptyOf(first);
  assert.equal(workerOf(first, ptyId)?.status, 'working');
  const typed = turn(first, ptyId);
  assert.deepEqual(typed.effects, [{ type: 'input', ptyId, text: NOTICE }], 'Claude Code and Codex queue a paste typed mid-turn');
  assert.deepEqual(workerOf(typed.state, ptyId)?.semaphoreNotice, { semaphore: 'memory', text: NOTICE }, 'kept for a Stop that beats the queued paste');
  const atStop = stop(inTurn(typed.state, ptyId), ptyId);
  assert.deepEqual(answers(atStop.effects), [['continue', ptyId, 'fila', NOTICE]], 'a Stop in its turn is answered, never held past the reservation');
  const { state, free } = withFree(first);
  const idle = stop(state, free).state;
  assert.deepEqual([workerOf(idle, free)?.status, workerOf(idle, free)?.lastEvent], ['waiting', { kind: 'turn' }]);
  assert.deepEqual(turn(idle, free).effects, [{ type: 'input', ptyId: free, text: NOTICE }]);
});

test('a run at a permission prompt keeps the notice; its next Stop in its turn gets it; past its turn it is dropped and the Stop held again (#799)', (t) => {
  fixed(t);
  const first = running();
  const ptyId = ptyOf(first);
  const asking = reduce(first, { type: 'hook', ptyId, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' } }).state;
  const kept = turn(asking, ptyId);
  assert.deepEqual(kept.effects, [], 'its Enter would answer the prompt');
  assert.deepEqual(workerOf(kept.state, ptyId)?.semaphoreNotice, { semaphore: 'memory', text: NOTICE });
  const delivered = stop(inTurn(kept.state, ptyId), ptyId);
  assert.deepEqual(answers(delivered.effects), [['continue', ptyId, 'fila', NOTICE]]);
  assert.deepEqual([workerOf(delivered.state, ptyId)?.status, workerOf(delivered.state, ptyId)?.semaphoreNotice], ['working', undefined]);
  const missed = stop(inLine(kept.state, ptyId), ptyId); // the reservation ran out: back in line
  assert.deepEqual(missed.effects, [{ type: 'hold', ptyId, until: HOLD_END }]);
  assert.equal(workerOf(missed.state, ptyId)?.semaphoreNotice, undefined, 'a late notice would send it to someone else\'s permit');
});

test('a free session\'s Stop with a place is never held; a notice it kept reaches it at its Stop as input (#799)', (t) => {
  fixed(t);
  const { state, free } = withFree(running());
  const stopped = stop(inLine(state, free), free);
  assert.deepEqual(stopped.effects, []);
  const idle = workerOf(stopped.state, free);
  assert.deepEqual([idle?.status, idle?.lastEvent, idle?.semaphoreHold], ['waiting', { kind: 'turn' }, undefined], 'the user\'s own prompt is never frozen');
  const asking = reduce(state, { type: 'hook', ptyId: free, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' } }).state;
  const atStop = stop(inTurn(turn(asking, free).state, free), free);
  assert.deepEqual(atStop.effects, [{ type: 'input', ptyId: free, text: NOTICE }]);
  assert.deepEqual([workerOf(atStop.state, free)?.status, workerOf(atStop.state, free)?.semaphoreNotice], ['waiting', undefined]);
});

test('a Stop after hive_done, after hive_ask, or with background work in flight is never held (#799)', (t) => {
  fixed(t);
  const first = running();
  const ptyId = ptyOf(first);
  const lined = inLine(first, ptyId);
  const isHold = (effects: Effect[]): boolean => effects.some((e) => e.type === 'hold');
  assert.equal(isHold(stop(reduce(lined, { type: 'done', ptyId }).state, ptyId).effects), false, 'the stage ends');
  const asked = stop(reduce(lined, { type: 'ask', ptyId, question: 'Which one?' }).state, ptyId);
  assert.deepEqual([isHold(asked.effects), workerOf(asked.state, ptyId)?.status], [false, 'waiting']);
  const busy = stop(lined, ptyId, { background_tasks: [{ id: 'b1' }] });
  assert.deepEqual([isHold(busy.effects), workerOf(busy.state, ptyId)?.lastEvent], [false, { kind: 'background', detail: '1' }]);
});

// Task 1's stage run, its Stop held for a place in memory
const heldRun = (): { state: State; ptyId: string } => {
  const first = running();
  const ptyId = ptyOf(first);
  return { state: stop(inLine(first, ptyId), ptyId).state, ptyId };
};

test('exit of a held worker gives a release; a snapshot that leaves it no place releases it idle; one where it still has a place keeps the hold (#799)', (t) => {
  fixed(t);
  const { state, ptyId } = heldRun();
  const isRelease = (e: Effect): boolean => e.type === 'release' && e.ptyId === ptyId;
  assert.ok(reduce(state, { type: 'exit', ptyId }).effects.some(isRelease));
  assert.equal(reduce(running(), { type: 'exit', ptyId: ptyOf(running()) }).effects.some((e) => e.type === 'release'), false, 'no hold, no release');
  const left = reduce(state, { type: 'setSemaphores', semaphores: { memory: { runs: [], line: [] } } });
  assert.deepEqual(left.effects, [{ type: 'release', ptyId }], 'three missed turns: nobody holds a Stop for a line it left');
  const idle = workerOf(left.state, ptyId);
  assert.deepEqual([idle?.status, idle?.lastEvent, idle?.semaphoreHold], ['waiting', { kind: 'turn' }, undefined]);
  const still = reduce(state, { type: 'setSemaphores', semaphores: { memory: { runs: ['other'], line: [{ ptyId: 'x', place: 1 }, { ptyId, place: 2 }] } } });
  assert.deepEqual([still.effects, workerOf(still.state, ptyId)?.semaphoreHold], [[], HOLD_END], 'a missed turn never releases it by itself');
});

test('approvalExpired before the hold\'s end changes nothing; past it the hold is released and the worker idle (#799)', (t) => {
  fixed(t);
  const { state, ptyId } = heldRun();
  const early = reduce(state, { type: 'approvalExpired', ptyId });
  assert.deepEqual([early.effects, workerOf(early.state, ptyId)?.semaphoreHold], [[], HOLD_END]);
  t.mock.timers.tick(APPROVAL_HOLD_MAX_MIN * MINUTE);
  const expired = reduce(state, { type: 'approvalExpired', ptyId });
  assert.deepEqual(expired.effects, [{ type: 'release', ptyId }]);
  const idle = workerOf(expired.state, ptyId);
  assert.deepEqual([idle?.status, idle?.lastEvent, idle?.semaphoreHold], ['waiting', { kind: 'turn' }, undefined], 'its turn, when it comes, arrives as input');
});

test('with the clock fixed, the same state and event give deep-equal state and effects twice, and the input state is unchanged (#799)', (t) => {
  fixed(t);
  const first = running();
  const ptyId = ptyOf(first);
  const lined = inLine(first, ptyId);
  const { state } = heldRun();
  for (const [s, event] of [
    [lined, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } }],
    [state, { type: 'semaphoreTurn', ptyId, semaphore: 'memory', argv: TEST, until: UNTIL }],
    [state, { type: 'setSemaphores', semaphores: {} }],
  ] as const) {
    const before = structuredClone(s);
    assert.deepEqual(reduce(s, event), reduce(s, event), event.type);
    assert.deepEqual(s, before, `${event.type}: never mutated`);
  }
});
