import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSchedule, canStart, extractPrUrl, initialState, isBlocked, isChildSession, isFree, reduce, slugFor } from '../src/orchestrator.js';
import { HOUR_MS } from '../src/usage.js';
import type { BoardQuota, Budget, HookPayload, RateLimits, Signal, Slot, State, Task, UsageRule } from '../src/types.js';

const task = (n: number): Task => ({
  itemId: `item${n}`, id: String(n), title: `Task ${n}`, body: `body ${n}`,
  url: `https://github.com/o/r/issues/${n}`,
});
const tasks = (n: number) => Array.from({ length: n }, (_, i) => task(i + 1));
const filled = (max: number, n: number) => reduce(initialState(max), { type: 'poll', tasks: tasks(n) });
const hook = (state: State, workerId: string, payload: Partial<HookPayload> & { hook_event_name: string }) =>
  reduce(state, { type: 'hook', workerId, payload });
const occupied = (s: State) => s.slots.filter((x) => x.status !== 'empty');
const signaled = (state: State, signal: Signal) => reduce(state, { type: 'setSignal', signal });
const stopped = (state: State, workerId: string) => hook(state, workerId, { hook_event_name: 'Stop' }).state;
const counted = (state: State, workerId: string, tokens: number) =>
  reduce(state, { type: 'hook', workerId, payload: { hook_event_name: 'Stop' }, tokens }).state;
// One free slot, one usage sample of `tokens` aged `ageMs`, under `budget`.
const spent = (tokens: number, ageMs: number, budget: Budget): State => ({
  ...initialState(1), budget, usage: [{ at: new Date(Date.now() - ageMs).toISOString(), tokens }],
});
// Usage rules over a 1000-token hour: 55% → cap 1; 85% → yellow + cap 1; 95% → red + cap 1; 10% → nothing.
const RULES: UsageRule[] = [{ percent: 50, maxWorkers: 1 }, { percent: 80, signal: 'yellow' }, { percent: 90, signal: 'red' }];
const ruled = (state: State, tokens: number, ageMs = 0): State => ({
  ...state, budget: { maxTokensPerHour: 1000 }, usageRules: RULES,
  usage: [{ at: new Date(Date.now() - ageMs).toISOString(), tokens }],
});
const polled = (state: State, n: number) => reduce(state, { type: 'poll', tasks: tasks(n) });
const started = (state: State, itemId: string, raiseMax?: boolean) => reduce(state, { type: 'start', itemId, raiseMax });
const LIMITS: RateLimits = {
  at: '2026-09-16T12:00:00.000Z',
  windows: {
    five_hour: { usedPercent: 23, resetsAt: '2026-09-16T15:00:00.000Z' },
    seven_day: { usedPercent: 41, resetsAt: '2026-09-20T00:00:00.000Z' },
  },
};
const limited = (state: State, workerId: string, rateLimits: RateLimits = LIMITS) =>
  reduce(state, { type: 'rateLimits', workerId, rateLimits });
const QUOTA: BoardQuota = { limit: 5000, remaining: 4320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' };

test('poll fills slots in board order up to maxConcurrent and queues the rest', () => {
  const { state, effects } = filled(3, 5);
  assert.deepEqual(occupied(state).map((s) => s.task?.id), ['1', '2', '3']);
  assert.deepEqual(state.queue.map((t) => t.id), ['4', '5']);
  assert.equal(effects.filter((e) => e.type === 'spawn').length, 3);
  assert.deepEqual(
    effects.flatMap((e) => (e.type === 'setStatus' ? [e.key] : [])),
    ['working', 'working', 'working'],
  );
  assert.equal(state.slots[0].status, 'working');
  assert.equal(state.slots[0].slug, 'hive-1-task-1');
  assert.ok(state.slots[0].startedAt);
  assert.deepEqual(state.slots[0].lastEvent, { kind: 'starting' });
});

test('poll does not duplicate a task already in a slot', () => {
  const first = filled(1, 2).state;
  const { state, effects } = reduce(first, { type: 'poll', tasks: tasks(2) });
  assert.deepEqual(state.queue.map((t) => t.id), ['2']);
  assert.equal(effects.length, 0);
});

test('reducer never mutates its input', () => {
  const before = initialState(2);
  const snapshot = JSON.stringify(before);
  reduce(before, { type: 'poll', tasks: tasks(3) });
  reduce(before, { type: 'setSignal', signal: 'red' });
  reduce(before, { type: 'setUsageRules', usageRules: RULES });
  assert.equal(JSON.stringify(before), snapshot);
  const first = filled(1, 1).state;
  const paused = stopped(signaled(first, 'red').state, first.slots[0].workerId!);
  const pausedSnapshot = JSON.stringify(paused);
  reduce(paused, { type: 'setSignal', signal: 'green' });
  assert.equal(JSON.stringify(paused), pausedSnapshot);
  const id = first.slots[0].workerId!;
  const spentState = counted(first, id, 700);
  const spentSnapshot = JSON.stringify(spentState);
  reduce(spentState, { type: 'hook', workerId: id, payload: { hook_event_name: 'Stop' }, tokens: 900 });
  reduce(spentState, { type: 'setBudget', budget: { maxTokensPerHour: 1 } });
  assert.equal(JSON.stringify(spentState), spentSnapshot);
  const full = filled(1, 2).state; // no free slot: start with raiseMax goes through setMax and occupy
  const fullSnapshot = JSON.stringify(full);
  reduce(full, { type: 'start', itemId: 'item2', raiseMax: true });
  assert.equal(JSON.stringify(full), fullSnapshot);
});

test('setMax up adds empty slots and fills them from the queue', () => {
  const first = filled(1, 3).state;
  const { state, effects } = reduce(first, { type: 'setMax', max: 2 });
  assert.equal(state.maxConcurrent, 2);
  assert.equal(occupied(state).length, 2);
  assert.deepEqual(state.queue.map((t) => t.id), ['3']);
  assert.equal(effects.filter((e) => e.type === 'spawn').length, 1);
});

test('setMax down marks extra occupied slots as draining instead of killing them', () => {
  const first = filled(3, 3).state;
  const { state, effects } = reduce(first, { type: 'setMax', max: 1 });
  assert.equal(effects.length, 0);
  assert.equal(state.slots.length, 3);
  assert.ok(!state.slots[0].draining);
  assert.equal(state.slots[1].draining, true);
  assert.equal(state.slots[2].draining, true);
  assert.equal(state.slots[1].status, 'working');
});

test('a draining slot is removed when its worker exits and its task returns to the queue', () => {
  const drained = reduce(filled(3, 3).state, { type: 'setMax', max: 1 }).state;
  const { state, effects } = reduce(drained, { type: 'exit', workerId: drained.slots[1].workerId! });
  assert.equal(state.slots.length, 2);
  assert.deepEqual(state.queue.map((t) => t.id), ['2']);
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item2', key: 'queue' }]);
});

test('setMax down drops surplus empty slots', () => {
  const { state } = reduce(initialState(3), { type: 'setMax', max: 1 });
  assert.equal(state.slots.length, 1);
});

test('SessionStart records worktree, branch and the transcript path; a path that is not an absolute .jsonl is ignored', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const { state } = reduce(first, {
    type: 'hook', workerId: id, branch: 'hive-1-task-1',
    payload: { hook_event_name: 'SessionStart', cwd: '/repo/.claude/worktrees/hive-1-task-1', transcript_path: '/Users/x/.claude/projects/p/abc.jsonl' },
  });
  assert.equal(state.slots[0].worktree, '/repo/.claude/worktrees/hive-1-task-1');
  assert.equal(state.slots[0].branch, 'hive-1-task-1');
  assert.equal(state.slots[0].transcriptPath, '/Users/x/.claude/projects/p/abc.jsonl');
  const relative = hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w', transcript_path: 'abc.jsonl' }).state;
  assert.equal(relative.slots[0].transcriptPath, undefined);
  assert.equal(hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w' }).state.slots[0].transcriptPath, undefined);
});

test('SessionStart keeps a well-formed session_id, the first one wins, and a malformed or missing one is dropped without losing the rest of the hook', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const start = (state: State, session_id?: string): State => hook(state, id, { hook_event_name: 'SessionStart', cwd: '/w', session_id }).state;
  const uuid = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b'; // what Claude Code sends
  const started = start(first, uuid);
  assert.equal(started.slots[0].sessionId, uuid);
  assert.equal(started.slots[0].worktree, '/w');
  assert.equal(start(started, 'another-session-id-0001').slots[0].sessionId, uuid, 'a teammate SessionStart does not replace the main session (#24)');
  for (const bad of ['', 'short', 'has space-in-it', 'x'.repeat(65), '../../etc/passwd', '<b>x</b>abcdef']) {
    assert.equal(start(first, bad).slots[0].sessionId, undefined, JSON.stringify(bad));
  }
  const missing = start(first);
  assert.equal(missing.slots[0].sessionId, undefined);
  assert.equal(missing.slots[0].worktree, '/w', 'the rest of the hook still applies');
  assert.equal(JSON.stringify(first.slots[0].sessionId), undefined, 'the input state is untouched');
});

test('isChildSession: no slot id, no payload id, a malformed payload id and a matching id are all false; a different well-formed id is true (#24)', () => {
  const mainId = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const childId = 'another-child-session-0001';
  const slot: Slot = { id: 's1', status: 'working', sessionId: mainId };
  const bareSlot: Slot = { id: 's1', status: 'working' };
  assert.equal(isChildSession(undefined, { hook_event_name: 'Stop', session_id: childId }), false, 'no slot at all');
  assert.equal(isChildSession(bareSlot, { hook_event_name: 'Stop', session_id: childId }), false, 'slot never recorded a session id');
  assert.equal(isChildSession(slot, { hook_event_name: 'Stop' }), false, 'no payload id');
  assert.equal(isChildSession(slot, { hook_event_name: 'Stop', session_id: 'short' }), false, 'malformed payload id');
  assert.equal(isChildSession(slot, { hook_event_name: 'Stop', session_id: mainId }), false, 'same id');
  assert.equal(isChildSession(slot, { hook_event_name: 'Stop', session_id: childId }), true, 'different well-formed id');
});

test('Stop from a child session (a subagent or teammate) leaves status, lastEvent, the token sample and usage untouched (#24)', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const mainId = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const childId = 'another-child-session-0001';
  const started = hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w', session_id: mainId }).state;
  const { state, effects } = reduce(started, { type: 'hook', workerId: id, payload: { hook_event_name: 'Stop', session_id: childId }, tokens: 999 });
  assert.equal(state.slots[0].status, 'working', 'active status untouched');
  assert.deepEqual(state.slots[0].lastEvent, { kind: 'starting' }, 'unchanged from spawn, not a turn end');
  assert.equal(state.slots[0].tokens, undefined, 'the token sample is not recorded');
  assert.deepEqual(state.usage, []);
  assert.equal(effects.length, 0);
});

test('SessionEnd from a child session does not free the slot and emits no effects (#24)', () => {
  const first = filled(1, 2).state;
  const id = first.slots[0].workerId!;
  const mainId = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const childId = 'another-child-session-0001';
  const started = hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w', session_id: mainId }).state;
  const { state, effects } = hook(started, id, { hook_event_name: 'SessionEnd', session_id: childId });
  assert.equal(state.slots[0].workerId, id, 'slot not freed');
  assert.equal(state.slots[0].status, 'working');
  assert.deepEqual(state.queue.map((t) => t.id), ['2'], 'nothing requeued');
  assert.equal(effects.length, 0);
});

test('Stop still ends the turn from the main session id, with no session_id at all, or when the slot never recorded a sessionId (#24)', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const mainId = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const started = hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w', session_id: mainId }).state;
  assert.deepEqual(hook(started, id, { hook_event_name: 'Stop', session_id: mainId }).state.slots[0].lastEvent, { kind: 'turn' }, 'main session id');
  assert.deepEqual(hook(started, id, { hook_event_name: 'Stop' }).state.slots[0].lastEvent, { kind: 'turn' }, 'no session_id sent');
  assert.deepEqual(stopped(first, id).slots[0].lastEvent, { kind: 'turn' }, 'slot never recorded a sessionId');
});

test('Notification of a waiting type turns the slot yellow with the message', () => {
  const first = filled(1, 1).state;
  const { state } = hook(first, first.slots[0].workerId!, {
    hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?',
  });
  assert.equal(state.slots[0].status, 'waiting');
  assert.equal(state.slots[0].question, 'Allow Bash?');
  assert.deepEqual(state.slots[0].lastEvent, { kind: 'waiting', detail: 'permission_prompt' });
});

test('Notification of a non-waiting type is ignored', () => {
  const first = filled(1, 1).state;
  const { state } = hook(first, first.slots[0].workerId!, {
    hook_event_name: 'Notification', notification_type: 'auth_success', message: 'ok',
  });
  assert.equal(state.slots[0].status, 'working');
  assert.equal(state.slots[0].question, undefined);
});

test('UserPromptSubmit and PreToolUse bring a yellow slot back to working and clear the question', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const yellow = hook(first, id, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'idle' }).state;
  const green = hook(yellow, id, { hook_event_name: 'UserPromptSubmit' }).state;
  assert.equal(green.slots[0].status, 'working');
  assert.equal(green.slots[0].question, undefined);
  assert.deepEqual(green.slots[0].lastEvent, { kind: 'prompt' });
  const yellowAgain = hook(green, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }).state;
  const tool = hook(yellowAgain, id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' } }).state;
  assert.equal(tool.slots[0].status, 'working');
  assert.deepEqual(tool.slots[0].lastEvent, { kind: 'tool', detail: 'Bash: pnpm test' });
});

test('PostToolUse with gh pr create moves the slot to review and the board item to review', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const { state, effects } = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'gh pr create --fill' },
    tool_response: { stdout: 'Creating pull request\nhttps://github.com/o/r/pull/42\n', stderr: '' },
  });
  assert.equal(state.slots[0].status, 'review');
  assert.equal(state.slots[0].prUrl, 'https://github.com/o/r/pull/42');
  assert.deepEqual(state.slots[0].lastEvent, { kind: 'pr' });
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item1', key: 'review' }]);
});

test('after a PR, a permission prompt answered returns the slot to review, not working', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const reviewed = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/7',
  }).state;
  const yellow = hook(reviewed, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }).state;
  assert.equal(yellow.slots[0].status, 'waiting');
  const back = hook(yellow, id, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }).state;
  assert.equal(back.slots[0].status, 'review');
});

test('PostToolUse for other commands changes nothing', () => {
  const first = filled(1, 1).state;
  const { state, effects } = hook(first, first.slots[0].workerId!, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'git status' }, tool_response: 'clean',
  });
  assert.equal(state.slots[0].status, 'working');
  assert.equal(effects.length, 0);
});

test('Stop returns a yellow slot to its active status and clears the question', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const yellow = hook(first, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }).state;
  const { state, effects } = hook(yellow, id, { hook_event_name: 'Stop' });
  assert.equal(state.slots[0].status, 'working');
  assert.equal(state.slots[0].question, undefined);
  assert.deepEqual(state.slots[0].lastEvent, { kind: 'turn' });
  assert.equal(effects.length, 0);
  const reviewed = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/1',
  }).state;
  const yellowReviewed = hook(reviewed, id, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'y' }).state;
  assert.equal(hook(yellowReviewed, id, { hook_event_name: 'Stop' }).state.slots[0].status, 'review');
});

test('exit without PR empties the slot, requeues the task at the end and pulls the next one', () => {
  const first = filled(1, 2).state;
  const id = first.slots[0].id;
  const { state, effects } = reduce(first, { type: 'exit', workerId: first.slots[0].workerId! });
  assert.equal(state.slots[0].id, id, 'slot keeps its id');
  assert.equal(state.slots[0].task?.id, '2', 'next task pulled');
  assert.deepEqual(state.queue.map((t) => t.id), ['1']);
  assert.deepEqual(effects.map((e) => e.type), ['setStatus', 'setStatus', 'spawn']);
  assert.deepEqual(effects[0], { type: 'setStatus', itemId: 'item1', key: 'queue' });
});

test('exit with PR does not requeue the task', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const reviewed = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/1',
  }).state;
  const { state, effects } = reduce(reviewed, { type: 'exit', workerId: id });
  assert.equal(state.slots[0].status, 'empty');
  assert.equal(state.queue.length, 0);
  assert.equal(effects.length, 0);
});

test('SessionEnd behaves like exit', () => {
  const first = filled(1, 2).state;
  const id = first.slots[0].workerId!;
  const { state, effects } = hook(first, id, { hook_event_name: 'SessionEnd' });
  assert.equal(state.slots[0].task?.id, '2', 'next task pulled via fill');
  assert.deepEqual(state.queue.map((t) => t.id), ['1'], 'current task requeued');
  assert.deepEqual(effects.map((e) => e.type), ['setStatus', 'setStatus', 'spawn']);
});

test('exit is idempotent and ignores unknown workers', () => {
  // use a slot with a PR so exit does not requeue (and fill does not immediately respawn) the task
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const reviewed = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/1',
  }).state;
  const once = reduce(reviewed, { type: 'exit', workerId: id }).state;
  const twice = reduce(once, { type: 'exit', workerId: id });
  assert.deepEqual(twice.state, once);
  assert.equal(twice.effects.length, 0);
  const unknown = reduce(first, { type: 'exit', workerId: 'nope' });
  assert.deepEqual(unknown.state, first);
});

test('exit and hooks carrying a replaced worker id are ignored after the slot was refilled', () => {
  const first = filled(1, 2).state;
  const w1 = first.slots[0].workerId!;
  const once = reduce(first, { type: 'exit', workerId: w1 });
  assert.equal(once.state.slots[0].task?.id, '2');
  const w2 = once.state.slots[0].workerId!;
  assert.ok(w2 && w2 !== w1, 'refill assigns a fresh worker id');
  const stale = reduce(once.state, { type: 'exit', workerId: w1 });
  assert.deepEqual(stale.state, once.state);
  assert.equal(stale.effects.length, 0);
  const staleHook = hook(once.state, w1, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' });
  assert.equal(staleHook.state.slots[0].status, 'working');
});

test('hook for an empty or unknown slot is ignored', () => {
  const s = initialState(1);
  const { state, effects } = hook(s, s.slots[0].workerId!, { hook_event_name: 'Stop' });
  assert.deepEqual(state, s);
  assert.equal(effects.length, 0);
});

test('boot gives every occupied slot as dead: tasks without a PR go back to the queue, tasks with a PR just free the slot', () => {
  const first = filled(2, 2).state;
  const all = reduce(first, { type: 'boot' });
  assert.deepEqual(all.state.slots.map((s) => s.status), ['empty', 'empty']);
  assert.deepEqual(all.state.queue.map((t) => t.id), ['1', '2']);
  assert.deepEqual(all.effects, [
    { type: 'setStatus', itemId: 'item1', key: 'queue' },
    { type: 'setStatus', itemId: 'item2', key: 'queue' },
  ]);
  const withPr = hook(first, first.slots[1].workerId!, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/9',
  }).state;
  const { state, effects } = reduce(withPr, { type: 'boot' });
  assert.deepEqual(state.slots.map((s) => s.status), ['empty', 'empty']);
  assert.deepEqual(state.queue.map((t) => t.id), ['1'], 'a task with a PR is not requeued');
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item1', key: 'queue' }]);
});

test('boot opens under yellow unless the saved signal is red', () => {
  assert.equal(reduce(initialState(1), { type: 'boot' }).state.signal, 'yellow', 'green becomes yellow');
  const yellow = signaled(initialState(1), 'yellow').state;
  assert.equal(reduce(yellow, { type: 'boot' }).state.signal, 'yellow', 'yellow stays yellow');
  const red = signaled(initialState(1), 'red').state;
  assert.equal(reduce(red, { type: 'boot' }).state.signal, 'red', 'a saved red survives the boot');
  // a queued task waits for the user to look: boot never spawns, even with a free slot and green on the way in
  const queued = filled(2, 3).state;
  const { effects } = reduce(queued, { type: 'boot' });
  assert.equal(effects.some((e) => e.type === 'spawn'), false, 'no spawn on boot');
});

test('kill emits a kill effect for the slot slug', () => {
  const first = filled(1, 1).state;
  const { effects } = reduce(first, { type: 'kill', slotId: first.slots[0].id });
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-task-1', workerId: first.slots[0].workerId }]);
});

test('error sets and poll clears state.error', () => {
  const withError = reduce(initialState(1), { type: 'error', message: 'gh: boom' }).state;
  assert.equal(withError.error, 'gh: boom');
  const cleared = reduce(withError, { type: 'poll', tasks: [] }).state;
  assert.equal(cleared.error, undefined);
  assert.ok(cleared.lastPolledAt);
});

test('initialState starts green and canStart is true only under green with a free, non-draining slot', () => {
  const idle = initialState(2);
  assert.equal(idle.signal, 'green');
  assert.equal(canStart('green', idle.slots), true);
  assert.equal(canStart('green', filled(2, 2).state.slots), false, 'all occupied');
  assert.equal(canStart('green', [{ id: 'x', status: 'empty', draining: true }]), false, 'draining does not count as free');
  assert.equal(canStart('green', []), false, 'no slots');
  assert.equal(canStart('yellow', idle.slots), false);
  assert.equal(canStart('red', idle.slots), false);
});

test('poll under yellow queues every task and spawns nothing', () => {
  const yellow = signaled(initialState(2), 'yellow').state;
  const { state, effects } = reduce(yellow, { type: 'poll', tasks: tasks(3) });
  assert.deepEqual(state.queue.map((t) => t.id), ['1', '2', '3']);
  assert.equal(occupied(state).length, 0);
  assert.equal(effects.length, 0);
});

test('setMax up under red adds empty slots without spawning', () => {
  const red = signaled(filled(1, 3).state, 'red').state;
  const { state, effects } = reduce(red, { type: 'setMax', max: 3 });
  assert.equal(state.maxConcurrent, 3);
  assert.equal(state.slots.length, 3);
  assert.equal(occupied(state).length, 1);
  assert.deepEqual(state.queue.map((t) => t.id), ['2', '3']);
  assert.equal(effects.length, 0);
});

test('exit under yellow returns the task to the queue without pulling the next one', () => {
  const yellow = signaled(filled(1, 2).state, 'yellow').state;
  const { state, effects } = reduce(yellow, { type: 'exit', workerId: yellow.slots[0].workerId! });
  assert.equal(state.slots[0].status, 'empty');
  assert.deepEqual(state.queue.map((t) => t.id), ['2', '1']);
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item1', key: 'queue' }]);
});

test('setSignal green fills a free slot from the queue; yellow to red emits nothing', () => {
  const yellow = signaled(initialState(1), 'yellow').state;
  const queued = reduce(yellow, { type: 'poll', tasks: tasks(2) }).state;
  const red = signaled(queued, 'red');
  assert.equal(red.state.signal, 'red');
  assert.equal(occupied(red.state).length, 0);
  assert.equal(red.effects.length, 0);
  const green = signaled(red.state, 'green');
  assert.equal(green.state.signal, 'green');
  assert.equal(green.state.slots[0].task?.id, '1');
  assert.deepEqual(green.state.queue.map((t) => t.id), ['2']);
  assert.deepEqual(green.effects.map((e) => e.type), ['setStatus', 'spawn']);
});

test('Stop under red marks the slot paused and keeps its status; under green it does not', () => {
  const first = filled(2, 2).state;
  const [working, reviewing] = first.slots.map((s) => s.workerId!);
  const reviewed = hook(first, reviewing, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/1',
  }).state;
  const red = signaled(reviewed, 'red').state;
  const one = stopped(red, working);
  assert.equal(one.slots[0].paused, true);
  assert.equal(one.slots[0].status, 'working');
  assert.deepEqual(one.slots[0].lastEvent, { kind: 'paused' });
  const two = stopped(one, reviewing);
  assert.equal(two.slots[1].paused, true);
  assert.equal(two.slots[1].status, 'review');
  const green = stopped(reviewed, working);
  assert.equal(green.slots[0].paused, undefined);
  assert.deepEqual(green.slots[0].lastEvent, { kind: 'turn' });
});

test('UserPromptSubmit and PreToolUse clear paused', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const paused = stopped(signaled(first, 'red').state, id);
  assert.equal(paused.slots[0].paused, true);
  assert.equal(hook(paused, id, { hook_event_name: 'UserPromptSubmit' }).state.slots[0].paused, undefined);
  const tool = hook(paused, id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).state;
  assert.equal(tool.slots[0].paused, undefined);
  assert.equal(tool.slots[0].status, 'working');
});

test('setSignal to green or yellow clears paused on every slot; red again keeps it', () => {
  const first = filled(2, 2).state;
  const paused = first.slots.reduce((s, slot) => stopped(s, slot.workerId!), signaled(first, 'red').state);
  assert.deepEqual(paused.slots.map((s) => s.paused), [true, true]);
  assert.deepEqual(signaled(paused, 'red').state.slots.map((s) => s.paused), [true, true]);
  assert.deepEqual(signaled(paused, 'yellow').state.slots.map((s) => s.paused), [undefined, undefined]);
  assert.deepEqual(signaled(paused, 'green').state.slots.map((s) => s.paused), [undefined, undefined]);
});

test('initialState starts with no usage and no budget', () => {
  const idle = initialState(1);
  assert.deepEqual(idle.usage, []);
  assert.deepEqual(idle.budget, {});
});

test('Stop with tokens records the slot total and one sample per turn with the delta', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const one = counted(first, id, 1200);
  assert.equal(one.slots[0].tokens, 1200);
  assert.deepEqual(one.slots[0].lastEvent, { kind: 'turn' });
  assert.deepEqual(one.usage.map((s) => s.tokens), [1200]);
  assert.ok(Number.isFinite(Date.parse(one.usage[0].at)), 'sample time is ISO');
  const two = counted(one, id, 1500);
  assert.equal(two.slots[0].tokens, 1500);
  assert.deepEqual(two.usage.map((s) => s.tokens), [1200, 300]);
});

test('Stop with a total below the previous one records the whole total; an equal total adds no sample', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const one = counted(first, id, 1000);
  const replaced = counted(one, id, 400); // transcript swapped: the new file starts from zero
  assert.equal(replaced.slots[0].tokens, 400);
  assert.deepEqual(replaced.usage.map((s) => s.tokens), [1000, 400]);
  const same = counted(replaced, id, 400);
  assert.equal(same.slots[0].tokens, 400);
  assert.deepEqual(same.usage.map((s) => s.tokens), [1000, 400]);
});

test('Stop without tokens and a counted hook for an unknown worker leave usage untouched', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const one = counted(first, id, 500);
  const plain = stopped(one, id);
  assert.deepEqual(plain.usage, one.usage);
  assert.equal(plain.slots[0].tokens, 500);
  const unknown = reduce(one, { type: 'hook', workerId: 'nope', payload: { hook_event_name: 'Stop' }, tokens: 999 });
  assert.deepEqual(unknown.state, one);
  assert.equal(unknown.effects.length, 0);
});

test('SessionEnd with tokens records the last turn before the slot is freed', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const one = counted(first, id, 800);
  const { state } = reduce(one, { type: 'hook', workerId: id, payload: { hook_event_name: 'SessionEnd' }, tokens: 1000 });
  assert.deepEqual(state.usage.map((s) => s.tokens), [800, 200]);
  // exit reset the slot (and fill refilled it fresh from the requeued task): no leftover total
  assert.notEqual(state.slots[0].workerId, id);
  assert.equal(state.slots[0].tokens, undefined);
});

test('poll under an exhausted hour budget queues everything; a sample outside the hour does not count', () => {
  const blocked = reduce(spent(1000, 0, { maxTokensPerHour: 1000 }), { type: 'poll', tasks: tasks(2) });
  assert.equal(occupied(blocked.state).length, 0);
  assert.deepEqual(blocked.state.queue.map((t) => t.id), ['1', '2']);
  assert.equal(blocked.effects.length, 0);
  const reopened = reduce(spent(1000, 2 * HOUR_MS, { maxTokensPerHour: 1000 }), { type: 'poll', tasks: tasks(2) });
  assert.equal(reopened.state.slots[0].task?.id, '1');
  assert.deepEqual(reopened.effects.map((e) => e.type), ['setStatus', 'spawn']);
  const dayBlocked = reduce(spent(1000, 2 * HOUR_MS, { maxTokensPerDay: 1000 }), { type: 'poll', tasks: tasks(1) });
  assert.equal(occupied(dayBlocked.state).length, 0);
});

test('setBudget stores the budget and fills a free slot only when the new limit is above the usage', () => {
  const queued = reduce(spent(1000, 0, { maxTokensPerHour: 1000 }), { type: 'poll', tasks: tasks(1) }).state;
  assert.equal(queued.slots[0].status, 'empty');
  const lower = reduce(queued, { type: 'setBudget', budget: { maxTokensPerHour: 500, maxTokensPerDay: 500 } });
  assert.deepEqual(lower.state.budget, { maxTokensPerHour: 500, maxTokensPerDay: 500 });
  assert.equal(lower.state.slots[0].status, 'empty');
  assert.equal(lower.effects.length, 0);
  const raised = reduce(lower.state, { type: 'setBudget', budget: { maxTokensPerHour: 5000 } });
  assert.deepEqual(raised.state.budget, { maxTokensPerHour: 5000 });
  assert.equal(raised.state.slots[0].task?.id, '1');
  assert.deepEqual(raised.effects.map((e) => e.type), ['setStatus', 'spawn']);
  const unlimited = reduce(lower.state, { type: 'setBudget', budget: {} });
  assert.equal(unlimited.state.slots[0].task?.id, '1');
});

test('canStart with a limit needs the occupied count below it; without one it is as before', () => {
  const one = filled(2, 1).state.slots; // 1 occupied, 1 free
  assert.equal(canStart('green', one), true);
  assert.equal(canStart('green', one, 2), true, 'occupied 1 < limit 2');
  assert.equal(canStart('green', one, 1), false, 'occupied 1 = limit 1');
  assert.equal(canStart('green', one, 0), false);
  assert.equal(canStart('yellow', one, 2), false, 'a limit never overrides the signal');
});

test('poll under a usage cap opens up to the cap, queues the rest and drains nothing', () => {
  const { state, effects } = polled(ruled(initialState(3), 550), 3); // 55%: cap 1
  assert.equal(state.maxConcurrent, 3, 'the configured max is untouched');
  assert.equal(occupied(state).length, 1);
  assert.equal(state.slots.length, 3);
  assert.deepEqual(state.queue.map((t) => t.id), ['2', '3']);
  assert.deepEqual(effects.map((e) => e.type), ['setStatus', 'spawn']);
  assert.ok(state.slots.every((s) => !s.draining));
});

test('a usage cap below the occupied count emits no kill, drains nothing, and a freed slot stays empty', () => {
  const three = ruled(filled(3, 4).state, 550); // 3 working, 1 queued, cap 1
  const { state, effects } = polled(three, 4);
  assert.equal(effects.length, 0);
  assert.equal(occupied(state).length, 3);
  assert.ok(state.slots.every((s) => !s.draining));
  assert.deepEqual(state.queue.map((t) => t.id), ['4']);
  const freed = reduce(state, { type: 'exit', workerId: state.slots[0].workerId! });
  assert.equal(occupied(freed.state).length, 2, 'the freed slot stays empty while occupied >= cap');
  assert.equal(freed.state.slots[0].status, 'empty');
  assert.deepEqual(freed.state.queue.map((t) => t.id), ['4', '1']);
  assert.deepEqual(freed.effects, [{ type: 'setStatus', itemId: 'item1', key: 'queue' }]);
});

test('usage past the yellow rule stops fill without touching the manual signal; a sample out of the window reopens', () => {
  const queued = polled(ruled(initialState(1), 850), 1); // 85%: yellow
  assert.equal(queued.state.signal, 'green', 'the manual signal is untouched');
  assert.equal(occupied(queued.state).length, 0);
  assert.deepEqual(queued.state.queue.map((t) => t.id), ['1']);
  assert.equal(queued.effects.length, 0);
  const aged = polled(ruled(queued.state, 850, 2 * HOUR_MS), 1); // same sample, older than the hour window
  assert.equal(aged.state.slots[0].task?.id, '1');
  assert.deepEqual(aged.effects.map((e) => e.type), ['setStatus', 'spawn']);
});

test('Stop under a dynamic red pauses; manual green cannot lift it; usage aging out clears it on poll; usage never lifts a manual red', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const paused = stopped(ruled(first, 950), id); // 95%: red
  assert.equal(paused.slots[0].paused, true);
  assert.equal(paused.slots[0].status, 'working');
  assert.deepEqual(paused.slots[0].lastEvent, { kind: 'paused' });
  const stillRed = signaled(paused, 'green').state;
  assert.equal(stillRed.signal, 'green');
  assert.equal(stillRed.slots[0].paused, true, 'manual green does not beat a dynamic red');
  const aged = polled(ruled(stillRed, 950, 2 * HOUR_MS), 0).state;
  assert.equal(aged.slots[0].paused, undefined, 'the sample left the hour window: poll releases the mark');
  const byHand = stopped(signaled(ruled(first, 100), 'red').state, id);
  assert.equal(byHand.slots[0].paused, true);
  assert.equal(polled(ruled(byHand, 0), 0).state.slots[0].paused, true, 'usage never clears a manual red');
});

test('Stop counts this turn\'s sample before reading the signal, so the turn that crosses the red line pauses', () => {
  const first = ruled(filled(1, 1).state, 0);
  const crossed = counted({ ...first, usage: [] }, first.slots[0].workerId!, 950); // 95% in one turn
  assert.equal(crossed.slots[0].paused, true);
});

test('setUsageRules copies the rules into the state and fills; a state without rules behaves as before', () => {
  const capped = polled(ruled(initialState(2), 550), 2).state; // cap 1: one working, one queued
  assert.equal(occupied(capped).length, 1);
  const loosened = reduce(capped, { type: 'setUsageRules', usageRules: [] });
  assert.deepEqual(loosened.state.usageRules, []);
  assert.deepEqual(loosened.effects.map((e) => e.type), ['setStatus', 'spawn'], 'lifting the cap pulls the queue right away');
  const { state, effects } = polled(loosened.state, 3);
  assert.equal(occupied(state).length, 2, 'no rules: the manual max is the only cap');
  assert.deepEqual(state.queue.map((t) => t.id), ['3']);
  assert.equal(effects.length, 0);
  const queued = polled({ ...ruled(initialState(1), 850), usageRules: [] }, 1).state; // 85% but no rules
  assert.equal(queued.slots[0].task?.id, '1');
  const back = reduce(queued, { type: 'setUsageRules', usageRules: RULES });
  assert.deepEqual(back.state.usageRules, RULES);
  assert.equal(back.effects.length, 0, 'rules that tighten never kill or drain');
  assert.equal(back.state.slots[0].task?.id, '1');
});

test('rateLimits from an occupied slot stores the reading, emits no effect and starts nothing', () => {
  const first = filled(1, 2).state; // one working, task 2 queued
  const id = first.slots[0].workerId!;
  // A free slot next to a non-empty queue: any fill would spawn task 2 here
  const roomy: State = { ...first, maxConcurrent: 2, slots: [...first.slots, { id: 'free', status: 'empty' }] };
  const { state, effects } = limited(roomy, id);
  assert.deepEqual(state.rateLimits, LIMITS);
  assert.equal(effects.length, 0, 'display only: no fill, no spawn');
  assert.equal(state.slots[1].status, 'empty');
  assert.deepEqual({ ...state, rateLimits: undefined }, { ...roomy, rateLimits: undefined }, 'nothing else changes');
  const newer: RateLimits = { ...LIMITS, at: '2026-09-16T12:05:00.000Z' };
  assert.deepEqual(limited(state, id, newer).state.rateLimits, newer, 'the latest reading replaces the previous one');
});

test('rateLimits from an unknown worker or one that already exited leaves the state as is', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const ghost = limited(first, 'ghost');
  assert.equal(ghost.state, first, 'same object: nothing to persist or broadcast differently');
  assert.equal(ghost.state.rateLimits, undefined);
  assert.equal(ghost.effects.length, 0);
  const gone = reduce(first, { type: 'exit', workerId: id }).state; // the slot is refilled under a new workerId
  assert.notEqual(gone.slots[0].workerId, id);
  assert.equal(limited(gone, id).state.rateLimits, undefined, 'a worker that exited no longer feeds');
});

test('rateLimits never mutates its input and the reading survives poll, setMax and boot', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const snapshot = JSON.stringify(first);
  const { state } = limited(first, id);
  assert.equal(JSON.stringify(first), snapshot);
  assert.equal(first.rateLimits, undefined);
  const later = reduce(reduce(state, { type: 'poll', tasks: tasks(1) }).state, { type: 'setMax', max: 2 }).state;
  assert.deepEqual(later.rateLimits, LIMITS, 'the last reading stays until a newer one arrives');
  assert.deepEqual(reduce(later, { type: 'boot' }).state.rateLimits, LIMITS, 'a reopened Hive shows the last value');
});

test('rateLimits without a workerId is the Hive own reading: stored with no slot occupied, no effects, input untouched', () => {
  const idle = initialState(1); // one free slot, empty queue: no worker anywhere
  const snapshot = JSON.stringify(idle);
  const { state, effects } = reduce(idle, { type: 'rateLimits', rateLimits: LIMITS });
  assert.deepEqual(state.rateLimits, LIMITS);
  assert.equal(effects.length, 0, 'display only');
  assert.deepEqual({ ...state, rateLimits: undefined }, { ...idle, rateLimits: undefined }, 'nothing else changes');
  assert.equal(JSON.stringify(idle), snapshot);
  assert.equal(idle.rateLimits, undefined);
  const newer: RateLimits = { ...LIMITS, at: '2026-09-17T12:05:00.000Z' };
  assert.deepEqual(reduce(state, { type: 'rateLimits', rateLimits: newer }).state.rateLimits, newer, 'the latest reading wins');
  assert.equal(limited(state, 'ghost').state.rateLimits, LIMITS, 'with a workerId the slot rule still holds');
});

test('canSchedule is the fill gate: green with a free slot and budget; not under yellow, a reached cap or an exhausted budget', () => {
  const now = Date.now();
  assert.equal(canSchedule(initialState(1), now), true);
  assert.equal(canSchedule(filled(1, 1).state, now), false, 'all occupied');
  assert.equal(canSchedule(signaled(initialState(1), 'yellow').state, now), false);
  assert.equal(canSchedule(signaled(initialState(1), 'red').state, now), false);
  assert.equal(canSchedule(spent(1000, 0, { maxTokensPerHour: 1000 }), now), false, 'budget exhausted');
  assert.equal(canSchedule(spent(1000, 2 * HOUR_MS, { maxTokensPerHour: 1000 }), now), true, 'the sample left the hour');
  assert.equal(canSchedule(ruled(filled(2, 1).state, 550), now), false, '55%: cap 1 with one occupied');
  assert.equal(canSchedule(ruled(initialState(1), 850), now), false, '85%: dynamic yellow');
  assert.equal(canSchedule(ruled(initialState(1), 100), now), true, '10%: no rule applies');
});

test('boardQuota stores the reading, emits no effect and never fills, even with a free slot next to a queue', () => {
  const first = filled(1, 2).state; // one working, task 2 queued
  const roomy: State = { ...first, maxConcurrent: 2, slots: [...first.slots, { id: 'free', status: 'empty' }] };
  const snapshot = JSON.stringify(roomy);
  const { state, effects } = reduce(roomy, { type: 'boardQuota', quota: QUOTA });
  assert.deepEqual(state.boardQuota, QUOTA);
  assert.equal(effects.length, 0, 'display and backoff only: no fill, no spawn');
  assert.equal(state.slots[1].status, 'empty');
  assert.deepEqual(state.queue.map((t) => t.id), ['2']);
  assert.deepEqual({ ...state, boardQuota: undefined }, { ...roomy, boardQuota: undefined }, 'nothing else changes');
  assert.equal(JSON.stringify(roomy), snapshot, 'no mutation');
  const drained: BoardQuota = { ...QUOTA, remaining: 12, at: '2026-09-16T12:05:00.000Z' };
  assert.deepEqual(reduce(state, { type: 'boardQuota', quota: drained }).state.boardQuota, drained, 'the latest reading replaces the previous one');
  assert.deepEqual(reduce(state, { type: 'poll', tasks: tasks(2) }).state.boardQuota, QUOTA, 'a poll keeps the last reading');
});

test('slugFor strips accents, lowercases, and caps the title at 30 chars', () => {
  assert.equal(slugFor({ ...task(12), title: 'Adicionar Autenticação OAuth no backend da API v2' }), 'hive-12-adicionar-autenticacao-oauth-n');
  assert.equal(slugFor({ ...task(3), title: '  --weird__title!!  ' }), 'hive-3-weird-title');
});

test('slugFor kebab-izes the id too, so markdown ids like T-12 work', () => {
  assert.equal(slugFor({ ...task(1), id: 'T-12', title: 'Exemplo' }), 'hive-t-12-exemplo');
  assert.equal(slugFor({ ...task(1), id: 'Épico #3', title: 'x' }), 'hive-epico-3-x');
});

test('fill skips a blocked task, takes the next free one and leaves the blocked one in its queue position', () => {
  const blocked = { ...task(1), blockedBy: ['3'] };
  const { state, effects } = reduce(initialState(1), { type: 'poll', tasks: [blocked, task(2), task(3)] });
  assert.equal(state.slots[0].task?.id, '2');
  assert.deepEqual(state.queue.map((t) => t.id), ['1', '3']);
  assert.deepEqual(state.queue[0].blockedBy, ['3'], 'blocked task kept as the board delivered it');
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item2', key: 'working' }, { type: 'spawn', slot: state.slots[0] }]);
});

test('blockedBy: [] counts as free', () => {
  const { state } = reduce(initialState(1), { type: 'poll', tasks: [{ ...task(1), blockedBy: [] }] });
  assert.equal(state.slots[0].task?.id, '1');
  assert.deepEqual(state.queue, []);
});

test('a slot stays empty while every queued task is blocked, and a later poll without blockedBy starts it', () => {
  const first = reduce(initialState(1), { type: 'poll', tasks: [{ ...task(1), blockedBy: ['2'] }] });
  assert.equal(first.state.slots[0].status, 'empty');
  assert.deepEqual(first.state.queue.map((t) => t.id), ['1']);
  assert.equal(first.effects.length, 0);
  const { state, effects } = reduce(first.state, { type: 'poll', tasks: [task(1)] });
  assert.equal(state.slots[0].task?.id, '1');
  assert.equal(state.slots[0].task?.blockedBy, undefined);
  assert.deepEqual(state.queue, []);
  assert.deepEqual(effects.map((e) => e.type), ['setStatus', 'spawn']);
});

test('isBlocked is true only for a non-empty blockedBy', () => {
  assert.equal(isBlocked(task(1)), false);
  assert.equal(isBlocked({ ...task(1), blockedBy: [] }), false);
  assert.equal(isBlocked({ ...task(1), blockedBy: ['T-1'] }), true);
});

test('extractPrUrl finds the PR url only for gh pr create', () => {
  assert.equal(extractPrUrl('gh pr create --fill', 'https://github.com/a/b/pull/9\n'), 'https://github.com/a/b/pull/9');
  assert.equal(extractPrUrl('gh pr create', { stdout: 'x https://github.com/a/b-c/pull/10 y' }), 'https://github.com/a/b-c/pull/10');
  assert.equal(extractPrUrl('gh pr view', 'https://github.com/a/b/pull/9'), undefined);
  assert.equal(extractPrUrl('gh pr create', 'error: not logged in'), undefined);
});

test('isFree is true only for an empty slot that is not draining', () => {
  assert.equal(isFree({ id: 'x', status: 'empty' }), true);
  assert.equal(isFree({ id: 'x', status: 'empty', draining: true }), false);
  assert.equal(isFree(filled(1, 1).state.slots[0]), false, 'occupied');
});

test('start under yellow or red opens the task in the first free slot exactly like fill, marked manualStart, and leaves the rest queued', () => {
  const yellow = polled(signaled(initialState(2), 'yellow').state, 3).state; // 2 free slots, 3 queued, nothing spawned
  const { state, effects } = started(yellow, 'item2');
  assert.equal(state.signal, 'yellow', 'the signal is untouched');
  assert.equal(state.slots[0].task?.id, '2');
  assert.equal(state.slots[0].status, 'working');
  assert.equal(state.slots[0].slug, 'hive-2-task-2');
  assert.deepEqual(state.slots[0].lastEvent, { kind: 'manualStart' });
  assert.ok(state.slots[0].workerId && state.slots[0].startedAt);
  assert.equal(state.slots[1].status, 'empty', 'only the task asked for opens');
  assert.deepEqual(state.queue.map((t) => t.id), ['1', '3']);
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item2', key: 'working' }, { type: 'spawn', slot: state.slots[0] }]);
  const red = started(signaled(yellow, 'red').state, 'item3');
  assert.equal(red.state.slots[0].task?.id, '3');
  assert.deepEqual(red.effects.map((e) => e.type), ['setStatus', 'spawn']);
});

test('start ignores the dynamic cap and the budget, and never calls fill: only the task asked for opens', () => {
  const capped = polled(ruled(initialState(3), 550), 3).state; // 55%: cap 1 → one working, two queued, two free slots
  assert.equal(occupied(capped).length, 1);
  const { state, effects } = started(capped, 'item3');
  assert.deepEqual(occupied(state).map((s) => s.task?.id), ['1', '3']);
  assert.deepEqual(state.queue.map((t) => t.id), ['2'], 'task 2 stays queued: no fill after a manual start');
  assert.deepEqual(effects.map((e) => e.type), ['setStatus', 'spawn']);
  const broke = polled(spent(1000, 0, { maxTokensPerHour: 1000 }), 1).state; // budget exhausted: the free slot stayed empty
  assert.equal(broke.slots[0].status, 'empty');
  assert.equal(started(broke, 'item1').state.slots[0].task?.id, '1');
});

test('start leaves the state as is, with no effects, for an unknown or blocked task and for no free slot without raiseMax', () => {
  const blocked = { ...task(1), blockedBy: ['3'] };
  const queued = reduce(signaled(initialState(1), 'yellow').state, { type: 'poll', tasks: [blocked, task(2)] }).state;
  for (const [itemId, why] of [['nope', 'unknown'], ['item1', 'blocked']] as const) {
    const { state, effects } = started(queued, itemId, true);
    assert.equal(state, queued, `${why}: same object, even with raiseMax`);
    assert.equal(effects.length, 0, why);
  }
  const full = filled(1, 2).state; // one working, task 2 queued, no free slot
  const { state, effects } = started(full, 'item2');
  assert.equal(state, full, 'no free slot and no raiseMax: same object');
  assert.equal(effects.length, 0);
  assert.equal(state.maxConcurrent, 1);
});

test('start with raiseMax and no free slot sets maxConcurrent to occupied + 1 and opens the task in the new slot; a free slot ignores raiseMax', () => {
  const full = filled(2, 3).state; // 2 working, task 3 queued
  const { state, effects } = started(full, 'item3', true);
  assert.equal(state.maxConcurrent, 3);
  assert.equal(state.slots.length, 3);
  assert.deepEqual(state.slots.map((s) => s.task?.id), ['1', '2', '3']);
  assert.deepEqual(state.slots[2].lastEvent, { kind: 'manualStart' });
  assert.deepEqual(state.queue, []);
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item3', key: 'working' }, { type: 'spawn', slot: state.slots[2] }]);
  // 3 working under a max of 1: two draining, the cap below the occupied count. +1 on the max would open nothing; occupied + 1 opens one.
  const draining = reduce(filled(3, 4).state, { type: 'setMax', max: 1 }).state;
  assert.deepEqual(draining.slots.map((s) => s.draining), [undefined, true, true]);
  const raised = started(draining, 'item4', true).state;
  assert.equal(raised.maxConcurrent, 4);
  assert.ok(raised.slots.every((s) => !s.draining), 'nothing drains any more');
  assert.deepEqual(raised.slots.map((s) => s.task?.id), ['1', '2', '3', '4']);
  const roomy = polled(signaled(initialState(2), 'yellow').state, 1).state; // a free slot: the slot appeared between the render and the click
  const kept = started(roomy, 'item1', true).state;
  assert.equal(kept.maxConcurrent, 2);
  assert.equal(kept.slots.length, 2);
  assert.equal(kept.slots[0].task?.id, '1');
});
