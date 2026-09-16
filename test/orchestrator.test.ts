import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canStart, extractPrUrl, initialState, isBlocked, reduce, slugFor } from '../src/orchestrator.js';
import { HOUR_MS } from '../src/usage.js';
import type { Budget, HookPayload, Signal, State, Task, UsageRule } from '../src/types.js';

const task = (n: number): Task => ({
  itemId: `item${n}`, id: String(n), title: `Task ${n}`, body: `body ${n}`,
  url: `https://github.com/o/r/issues/${n}`,
});
const tasks = (n: number) => Array.from({ length: n }, (_, i) => task(i + 1));
const filled = (max: number, n: number) => reduce(initialState(max), { type: 'poll', tasks: tasks(n) });
const hook = (state: State, workerId: string, payload: Partial<HookPayload> & { hook_event_name: string }) =>
  reduce(state, { type: 'hook', workerId, payload });
const occupied = (s: State) => s.slots.filter((x) => x.status !== 'vazio');
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

test('poll fills slots in board order up to maxConcurrent and queues the rest', () => {
  const { state, effects } = filled(3, 5);
  assert.deepEqual(occupied(state).map((s) => s.task?.id), ['1', '2', '3']);
  assert.deepEqual(state.queue.map((t) => t.id), ['4', '5']);
  assert.equal(effects.filter((e) => e.type === 'spawn').length, 3);
  assert.deepEqual(
    effects.flatMap((e) => (e.type === 'setStatus' ? [e.key] : [])),
    ['working', 'working', 'working'],
  );
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(state.slots[0].slug, 'hive-1-task-1');
  assert.ok(state.slots[0].startedAt);
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
  assert.equal(state.slots[1].status, 'trabalhando');
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

test('SessionStart records worktree and branch', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const { state } = reduce(first, {
    type: 'hook', workerId: id, branch: 'hive-1-task-1',
    payload: { hook_event_name: 'SessionStart', cwd: '/repo/.claude/worktrees/hive-1-task-1' },
  });
  assert.equal(state.slots[0].worktree, '/repo/.claude/worktrees/hive-1-task-1');
  assert.equal(state.slots[0].branch, 'hive-1-task-1');
});

test('Notification of a waiting type turns the slot yellow with the message', () => {
  const first = filled(1, 1).state;
  const { state } = hook(first, first.slots[0].workerId!, {
    hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?',
  });
  assert.equal(state.slots[0].status, 'esperando_voce');
  assert.equal(state.slots[0].question, 'Allow Bash?');
});

test('Notification of a non-waiting type is ignored', () => {
  const first = filled(1, 1).state;
  const { state } = hook(first, first.slots[0].workerId!, {
    hook_event_name: 'Notification', notification_type: 'auth_success', message: 'ok',
  });
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(state.slots[0].question, undefined);
});

test('UserPromptSubmit and PreToolUse bring a yellow slot back to trabalhando and clear the question', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const yellow = hook(first, id, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'idle' }).state;
  const green = hook(yellow, id, { hook_event_name: 'UserPromptSubmit' }).state;
  assert.equal(green.slots[0].status, 'trabalhando');
  assert.equal(green.slots[0].question, undefined);
  const yellowAgain = hook(green, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }).state;
  const tool = hook(yellowAgain, id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' } }).state;
  assert.equal(tool.slots[0].status, 'trabalhando');
  assert.equal(tool.slots[0].lastEvent, 'Bash: pnpm test');
});

test('PostToolUse with gh pr create moves the slot to aguardando_review and the board item to review', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const { state, effects } = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'gh pr create --fill' },
    tool_response: { stdout: 'Creating pull request\nhttps://github.com/o/r/pull/42\n', stderr: '' },
  });
  assert.equal(state.slots[0].status, 'aguardando_review');
  assert.equal(state.slots[0].prUrl, 'https://github.com/o/r/pull/42');
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item1', key: 'review' }]);
});

test('after a PR, a permission prompt answered returns the slot to aguardando_review, not trabalhando', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const reviewed = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/7',
  }).state;
  const yellow = hook(reviewed, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }).state;
  assert.equal(yellow.slots[0].status, 'esperando_voce');
  const back = hook(yellow, id, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }).state;
  assert.equal(back.slots[0].status, 'aguardando_review');
});

test('PostToolUse for other commands changes nothing', () => {
  const first = filled(1, 1).state;
  const { state, effects } = hook(first, first.slots[0].workerId!, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'git status' }, tool_response: 'clean',
  });
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(effects.length, 0);
});

test('Stop returns a yellow slot to its active status and clears the question', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const yellow = hook(first, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }).state;
  const { state, effects } = hook(yellow, id, { hook_event_name: 'Stop' });
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(state.slots[0].question, undefined);
  assert.equal(state.slots[0].lastEvent, 'turno encerrado');
  assert.equal(effects.length, 0);
  const reviewed = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/1',
  }).state;
  const yellowReviewed = hook(reviewed, id, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'y' }).state;
  assert.equal(hook(yellowReviewed, id, { hook_event_name: 'Stop' }).state.slots[0].status, 'aguardando_review');
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
  assert.equal(state.slots[0].status, 'vazio');
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
  assert.equal(staleHook.state.slots[0].status, 'trabalhando');
});

test('hook for an empty or unknown slot is ignored', () => {
  const s = initialState(1);
  const { state, effects } = hook(s, s.slots[0].workerId!, { hook_event_name: 'Stop' });
  assert.deepEqual(state, s);
  assert.equal(effects.length, 0);
});

test('boot empties slots whose worker is dead and requeues their tasks; alive ones stay', () => {
  const first = filled(2, 2).state;
  const { state, effects } = reduce(first, { type: 'boot', aliveSlugs: ['hive-2-task-2'] });
  assert.equal(state.slots[0].status, 'vazio');
  assert.equal(state.slots[1].task?.id, '2');
  assert.deepEqual(state.queue.map((t) => t.id), ['1']);
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item1', key: 'queue' }]);
});

test('kill emits a kill effect for the slot slug', () => {
  const first = filled(1, 1).state;
  const { effects } = reduce(first, { type: 'kill', slotId: first.slots[0].id });
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-task-1', workerId: first.slots[0].workerId }]);
});

test('spawned stores the iTerm session id', () => {
  const first = filled(1, 1).state;
  const { state } = reduce(first, { type: 'spawned', workerId: first.slots[0].workerId!, itermSessionId: 'w0t1p0' });
  assert.equal(state.slots[0].itermSessionId, 'w0t1p0');
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
  assert.equal(canStart('green', [{ id: 'x', status: 'vazio', draining: true }]), false, 'draining does not count as free');
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
  assert.equal(state.slots[0].status, 'vazio');
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
  assert.equal(one.slots[0].status, 'trabalhando');
  assert.equal(one.slots[0].lastEvent, 'pausado: sinal red');
  const two = stopped(one, reviewing);
  assert.equal(two.slots[1].paused, true);
  assert.equal(two.slots[1].status, 'aguardando_review');
  const green = stopped(reviewed, working);
  assert.equal(green.slots[0].paused, undefined);
  assert.equal(green.slots[0].lastEvent, 'turno encerrado');
});

test('UserPromptSubmit and PreToolUse clear paused', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const paused = stopped(signaled(first, 'red').state, id);
  assert.equal(paused.slots[0].paused, true);
  assert.equal(hook(paused, id, { hook_event_name: 'UserPromptSubmit' }).state.slots[0].paused, undefined);
  const tool = hook(paused, id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).state;
  assert.equal(tool.slots[0].paused, undefined);
  assert.equal(tool.slots[0].status, 'trabalhando');
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
  assert.equal(one.slots[0].lastEvent, 'turno encerrado');
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
  assert.equal(queued.slots[0].status, 'vazio');
  const lower = reduce(queued, { type: 'setBudget', budget: { maxTokensPerHour: 500, maxTokensPerDay: 500 } });
  assert.deepEqual(lower.state.budget, { maxTokensPerHour: 500, maxTokensPerDay: 500 });
  assert.equal(lower.state.slots[0].status, 'vazio');
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
  assert.equal(freed.state.slots[0].status, 'vazio');
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
  assert.equal(paused.slots[0].status, 'trabalhando');
  assert.equal(paused.slots[0].lastEvent, 'pausado: sinal red');
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
  assert.equal(first.state.slots[0].status, 'vazio');
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
