import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPrUrl, initialState, reduce, slugFor } from '../src/orchestrator.js';
import type { HookPayload, State, Task } from '../src/types.js';

const task = (n: number): Task => ({
  itemId: `item${n}`, number: n, title: `Task ${n}`, body: `body ${n}`,
  url: `https://github.com/o/r/issues/${n}`,
});
const tasks = (n: number) => Array.from({ length: n }, (_, i) => task(i + 1));
const filled = (max: number, n: number) => reduce(initialState(max), { type: 'poll', tasks: tasks(n) });
const hook = (state: State, workerId: string, payload: Partial<HookPayload> & { hook_event_name: string }) =>
  reduce(state, { type: 'hook', workerId, payload });
const occupied = (s: State) => s.slots.filter((x) => x.status !== 'vazio');

test('poll fills slots in board order up to maxConcurrent and queues the rest', () => {
  const { state, effects } = filled(3, 5);
  assert.deepEqual(occupied(state).map((s) => s.task?.number), [1, 2, 3]);
  assert.deepEqual(state.queue.map((t) => t.number), [4, 5]);
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
  assert.deepEqual(state.queue.map((t) => t.number), [2]);
  assert.equal(effects.length, 0);
});

test('reducer never mutates its input', () => {
  const before = initialState(2);
  const snapshot = JSON.stringify(before);
  reduce(before, { type: 'poll', tasks: tasks(3) });
  assert.equal(JSON.stringify(before), snapshot);
});

test('setMax up adds empty slots and fills them from the queue', () => {
  const first = filled(1, 3).state;
  const { state, effects } = reduce(first, { type: 'setMax', max: 2 });
  assert.equal(state.maxConcurrent, 2);
  assert.equal(occupied(state).length, 2);
  assert.deepEqual(state.queue.map((t) => t.number), [3]);
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
  const { state, effects } = reduce(drained, { type: 'exit', workerId: drained.slots[1].id });
  assert.equal(state.slots.length, 2);
  assert.deepEqual(state.queue.map((t) => t.number), [2]);
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item2', key: 'queue' }]);
});

test('setMax down drops surplus empty slots', () => {
  const { state } = reduce(initialState(3), { type: 'setMax', max: 1 });
  assert.equal(state.slots.length, 1);
});

test('SessionStart records worktree and branch', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].id;
  const { state } = reduce(first, {
    type: 'hook', workerId: id, branch: 'hive-1-task-1',
    payload: { hook_event_name: 'SessionStart', cwd: '/repo/.claude/worktrees/hive-1-task-1' },
  });
  assert.equal(state.slots[0].worktree, '/repo/.claude/worktrees/hive-1-task-1');
  assert.equal(state.slots[0].branch, 'hive-1-task-1');
});

test('Notification of a waiting type turns the slot yellow with the message', () => {
  const first = filled(1, 1).state;
  const { state } = hook(first, first.slots[0].id, {
    hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?',
  });
  assert.equal(state.slots[0].status, 'esperando_voce');
  assert.equal(state.slots[0].question, 'Allow Bash?');
});

test('Notification of a non-waiting type is ignored', () => {
  const first = filled(1, 1).state;
  const { state } = hook(first, first.slots[0].id, {
    hook_event_name: 'Notification', notification_type: 'auth_success', message: 'ok',
  });
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(state.slots[0].question, undefined);
});

test('UserPromptSubmit and PreToolUse bring a yellow slot back to trabalhando and clear the question', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].id;
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
  const id = first.slots[0].id;
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
  const id = first.slots[0].id;
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
  const { state, effects } = hook(first, first.slots[0].id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'git status' }, tool_response: 'clean',
  });
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(effects.length, 0);
});

test('Stop only updates lastEvent', () => {
  const first = filled(1, 1).state;
  const { state, effects } = hook(first, first.slots[0].id, { hook_event_name: 'Stop' });
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(state.slots[0].lastEvent, 'turno encerrado');
  assert.equal(effects.length, 0);
});

test('exit without PR empties the slot, requeues the task at the end and pulls the next one', () => {
  const first = filled(1, 2).state;
  const id = first.slots[0].id;
  const { state, effects } = reduce(first, { type: 'exit', workerId: id });
  assert.equal(state.slots[0].id, id, 'slot keeps its id');
  assert.equal(state.slots[0].task?.number, 2, 'next task pulled');
  assert.deepEqual(state.queue.map((t) => t.number), [1]);
  assert.deepEqual(effects.map((e) => e.type), ['setStatus', 'setStatus', 'spawn']);
  assert.deepEqual(effects[0], { type: 'setStatus', itemId: 'item1', key: 'queue' });
});

test('exit with PR does not requeue the task', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].id;
  const reviewed = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/1',
  }).state;
  const { state, effects } = reduce(reviewed, { type: 'exit', workerId: id });
  assert.equal(state.slots[0].status, 'vazio');
  assert.equal(state.queue.length, 0);
  assert.equal(effects.length, 0);
});

test('SessionEnd behaves like exit', () => {
  const first = filled(1, 1).state;
  const { state } = hook(first, first.slots[0].id, { hook_event_name: 'SessionEnd' });
  assert.equal(state.slots[0].status, 'vazio');
});

test('exit is idempotent and ignores unknown workers', () => {
  const first = filled(1, 1).state;
  const once = reduce(first, { type: 'exit', workerId: first.slots[0].id }).state;
  const twice = reduce(once, { type: 'exit', workerId: first.slots[0].id });
  assert.deepEqual(twice.state, once);
  assert.equal(twice.effects.length, 0);
  const unknown = reduce(first, { type: 'exit', workerId: 'nope' });
  assert.deepEqual(unknown.state, first);
});

test('hook for an empty or unknown slot is ignored', () => {
  const s = initialState(1);
  const { state, effects } = hook(s, s.slots[0].id, { hook_event_name: 'Stop' });
  assert.deepEqual(state, s);
  assert.equal(effects.length, 0);
});

test('boot empties slots whose worker is dead and requeues their tasks; alive ones stay', () => {
  const first = filled(2, 2).state;
  const { state, effects } = reduce(first, { type: 'boot', aliveSlugs: ['hive-2-task-2'] });
  assert.equal(state.slots[0].status, 'vazio');
  assert.equal(state.slots[1].task?.number, 2);
  assert.deepEqual(state.queue.map((t) => t.number), [1]);
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item1', key: 'queue' }]);
});

test('kill emits a kill effect for the slot slug', () => {
  const first = filled(1, 1).state;
  const { effects } = reduce(first, { type: 'kill', slotId: first.slots[0].id });
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-task-1' }]);
});

test('spawned stores the iTerm session id', () => {
  const first = filled(1, 1).state;
  const { state } = reduce(first, { type: 'spawned', slotId: first.slots[0].id, itermSessionId: 'w0t1p0' });
  assert.equal(state.slots[0].itermSessionId, 'w0t1p0');
});

test('error sets and poll clears state.error', () => {
  const withError = reduce(initialState(1), { type: 'error', message: 'gh: boom' }).state;
  assert.equal(withError.error, 'gh: boom');
  const cleared = reduce(withError, { type: 'poll', tasks: [] }).state;
  assert.equal(cleared.error, undefined);
  assert.ok(cleared.lastPolledAt);
});

test('slugFor strips accents, lowercases, and caps the title at 30 chars', () => {
  assert.equal(slugFor({ ...task(12), title: 'Adicionar Autenticação OAuth no backend da API v2' }), 'hive-12-adicionar-autenticacao-oauth-n');
  assert.equal(slugFor({ ...task(3), title: '  --weird__title!!  ' }), 'hive-3-weird-title');
});

test('extractPrUrl finds the PR url only for gh pr create', () => {
  assert.equal(extractPrUrl('gh pr create --fill', 'https://github.com/a/b/pull/9\n'), 'https://github.com/a/b/pull/9');
  assert.equal(extractPrUrl('gh pr create', { stdout: 'x https://github.com/a/b-c/pull/10 y' }), 'https://github.com/a/b-c/pull/10');
  assert.equal(extractPrUrl('gh pr view', 'https://github.com/a/b/pull/9'), undefined);
  assert.equal(extractPrUrl('gh pr create', 'error: not logged in'), undefined);
});
