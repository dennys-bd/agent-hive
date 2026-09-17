import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, cardOf, isBlocked, mergeCards, slugFor } from '../src/cards.js';
import { canSchedule, canStart, extractPrUrl, initialState, isChildSession, isFree, reduce } from '../src/orchestrator.js';
import { HOUR_MS } from '../src/usage.js';
import type { BoardCard, BoardQuota, Budget, Card, Column, HookPayload, RateLimits, Signal, Slot, State, Task, UsageRule } from '../src/types.js';

const COLUMNS: Column[] = [
  { name: 'spec', weight: 5, from: ['Backlog'], onFinish: 'Ready', prompt: '/hive-spec {url}', session: 'new', model: 'opus' },
  { name: 'dev', weight: 1, from: ['Ready'], onStart: 'In progress', onFinish: 'In review', prompt: '/hive-build {url}', session: 'continue' },
  { name: 'review', weight: 0, from: ['In review'] },
];
const task = (n: number): Task => ({ itemId: `item${n}`, id: String(n), title: `Task ${n}`, body: `body ${n}`, url: `https://github.com/o/r/issues/${n}` });
const listed = (n: number, column = 'Backlog'): BoardCard => ({ task: task(n), column });
const many = (n: number, column = 'Backlog'): BoardCard[] => Array.from({ length: n }, (_, i) => listed(i + 1, column));
const base = (max: number, columns: Column[] = COLUMNS): State => ({ ...initialState(max), columns });
const polled = (state: State, cards: BoardCard[]) => reduce(state, { type: 'poll', cards });
const filled = (max: number, n: number) => polled(base(max), many(n)); // n Backlog cards into spec; up to max running
const hook = (state: State, workerId: string, payload: Partial<HookPayload> & { hook_event_name: string }) =>
  reduce(state, { type: 'hook', workerId, payload });
const occupied = (s: State) => s.slots.filter((x) => x.status !== 'empty');
const card = (s: State, n: number): Card | undefined => s.cards.find((c) => c.task.itemId === `item${n}`);
const signaled = (state: State, signal: Signal) => reduce(state, { type: 'setSignal', signal });
const done = (state: State, workerId: string): State => reduce(state, { type: 'done', workerId }).state;
// The worker's Stop after its /hooks/done: what ends a stage now
const stopped = (state: State, workerId: string) => hook(done(state, workerId), workerId, { hook_event_name: 'Stop' });
const counted = (state: State, workerId: string, tokens: number) =>
  reduce(done(state, workerId), { type: 'hook', workerId, payload: { hook_event_name: 'Stop' }, tokens }).state;
const spent = (tokens: number, ageMs: number, budget: Budget): State => ({
  ...base(1), budget, usage: [{ at: new Date(Date.now() - ageMs).toISOString(), tokens }],
});
const RULES: UsageRule[] = [{ percent: 50, maxWorkers: 1 }, { percent: 80, signal: 'yellow' }, { percent: 90, signal: 'red' }];
const ruled = (state: State, tokens: number, ageMs = 0): State => ({
  ...state, budget: { maxTokensPerHour: 1000 }, usageRules: RULES, usage: [{ at: new Date(Date.now() - ageMs).toISOString(), tokens }],
});
const started = (state: State, itemId: string, raiseMax?: boolean) => reduce(state, { type: 'start', itemId, raiseMax });
const LIMITS: RateLimits = { at: '2026-09-16T12:00:00.000Z', windows: { five_hour: { usedPercent: 23, resetsAt: '2026-09-16T15:00:00.000Z' } } };
const limited = (state: State, workerId: string, rateLimits: RateLimits = LIMITS) => reduce(state, { type: 'rateLimits', workerId, rateLimits });
const QUOTA: BoardQuota = { limit: 5000, remaining: 4320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' };

test('poll enters unknown cards through the first column whose from contains their board column, keeps board order and ignores the rest', () => {
  const { state, effects } = polled(signaled(base(2), 'yellow').state, [listed(1, 'Ready'), listed(2, 'Backlog'), listed(3, 'Done'), listed(4, 'In review'), listed(5, 'In progress')]);
  assert.deepEqual(state.cards.map((c) => [c.task.id, c.column, c.boardColumn]), [['1', 'dev', 'Ready'], ['2', 'spec', 'Backlog'], ['4', 'review', 'In review']]);
  assert.equal(card(state, 1)?.slug, 'hive-1-task-1');
  assert.equal(card(state, 5), undefined, 'a column that appears only in onStart / onFinish is not a door');
  assert.equal(effects.length, 0);
  assert.ok(state.lastPolledAt);
});

test('poll fills free slots by weight, ties by board order, and marks the card with its slot', () => {
  const { state, effects } = polled(base(2), [listed(1, 'Ready'), listed(2, 'Backlog'), listed(3, 'Backlog'), listed(4, 'Backlog')]);
  assert.deepEqual(occupied(state).map((s) => cardOf(state.cards, s)?.task.id), ['2', '3'], 'spec (5) beats dev (1); 2 before 3');
  assert.deepEqual(state.cards.filter((c) => c.slotId).map((c) => c.task.id), ['2', '3']);
  assert.equal(card(state, 2)?.slotId, state.slots[0].id);
  assert.equal(state.slots[0].cardId, 'item2');
  assert.equal(state.slots[0].status, 'working');
  assert.deepEqual(state.slots[0].lastEvent, { kind: 'starting' });
  assert.ok(state.slots[0].startedAt && state.slots[0].workerId);
  assert.deepEqual(effects.map((e) => e.type), ['spawn', 'spawn'], 'spec has no onStart: no board write');
  const spawn = effects[0];
  assert.ok(spawn.type === 'spawn' && spawn.card.task.id === '2' && spawn.column.name === 'spec' && spawn.session === 'new');
});

test('occupy writes onStart only when it differs from boardColumn, generates a session id for new and keeps it for continue', () => {
  const dev = polled(base(1), [listed(1, 'Ready')]);
  assert.deepEqual(dev.effects.map((e) => e.type), ['setColumn', 'spawn']);
  assert.deepEqual(dev.effects[0], { type: 'setColumn', itemId: 'item1', column: 'In progress' });
  assert.equal(card(dev.state, 1)?.boardColumn, 'In progress', 'the Hive remembers what it wrote');
  const fresh = card(dev.state, 1)?.sessionId;
  assert.ok(fresh && /^[0-9a-f-]{36}$/.test(fresh), 'continue without an id runs as new');
  assert.equal(dev.effects[1].type === 'spawn' && dev.effects[1].session, 'new');
  const known: State = { ...base(1), cards: [{ task: task(1), column: 'dev', boardColumn: 'In progress', slug: 'hive-1-task-1', sessionId: 'kept-session-id-0001' }] };
  const again = reduce(known, { type: 'setSignal', signal: 'green' });
  assert.deepEqual(again.effects.map((e) => e.type), ['spawn'], 'already In progress: nothing to write');
  assert.equal(card(again.state, 1)?.sessionId, 'kept-session-id-0001');
  assert.equal(again.effects[0].type === 'spawn' && again.effects[0].session, 'continue');
});

test('candidates skips running, missing, blocked cards and columns without a prompt, highest weight first', () => {
  const cards: Card[] = [
    { task: task(1), column: 'review', boardColumn: 'In review', slug: 'a' },
    { task: task(2), column: 'dev', boardColumn: 'Ready', slug: 'b' },
    { task: { ...task(3), blockedBy: ['9'] }, column: 'spec', boardColumn: 'Backlog', slug: 'c' },
    { task: task(4), column: 'spec', boardColumn: 'Backlog', slug: 'd', missing: true },
    { task: task(5), column: 'spec', boardColumn: 'Backlog', slug: 'e', slotId: 's1' },
    { task: task(6), column: 'dev', boardColumn: 'Ready', slug: 'f' },
    { task: task(7), column: 'spec', boardColumn: 'Backlog', slug: 'g' },
  ];
  assert.deepEqual(candidates(cards, COLUMNS).map((c) => c.task.id), ['7', '2', '6']);
});

test('Stop kills the session, writes onFinish when it differs, moves the card to the next column and frees the slot; fill then runs the next column', () => {
  const first = signaled(filled(1, 1).state, 'yellow').state;
  const id = first.slots[0].workerId!;
  const { state, effects } = stopped(first, id);
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-task-1', workerId: id }, { type: 'setColumn', itemId: 'item1', column: 'Ready' }]);
  assert.deepEqual([card(state, 1)?.column, card(state, 1)?.boardColumn, card(state, 1)?.slotId], ['dev', 'Ready', undefined]);
  assert.equal(card(state, 1)?.sessionId, card(first, 1)?.sessionId, 'the session id travels with the card');
  assert.deepEqual(state.slots[0], { id: first.slots[0].id, status: 'empty' });
  const green = signaled(state, 'green');
  assert.deepEqual(green.effects.map((e) => e.type), ['setColumn', 'spawn']);
  assert.equal(green.effects[1].type === 'spawn' && green.effects[1].session, 'continue');
  assert.deepEqual(reduce(green.state, { type: 'exit', workerId: id }).effects, [], 'the exit of the killed session finds no slot: no-op');
});

test('Stop on the last column drops the card; a column without a prompt parks it; onFinish equal to boardColumn is not written', () => {
  const columns: Column[] = [{ name: 'only', weight: 1, from: ['Ready'], onFinish: 'Ready', prompt: 'x' }];
  const first = polled(base(1, columns), [listed(1, 'Ready')]).state;
  const { state, effects } = stopped(first, first.slots[0].workerId!);
  assert.deepEqual(effects.map((e) => e.type), ['kill'], 'onFinish is where the board already shows it');
  assert.deepEqual(state.cards, []);
  const parked = polled(signaled(base(1), 'yellow').state, [listed(1, 'In review')]);
  assert.equal(card(parked.state, 1)?.column, 'review');
  assert.equal(signaled(parked.state, 'green').effects.length, 0, 'no prompt: the card just sits');
});

test('an exit without Stop frees the slot, keeps the card in its column with its session id and writes nothing; fill runs it again', () => {
  const first = filled(1, 2).state;
  const id = first.slots[0].workerId!;
  const { state, effects } = reduce(signaled(first, 'yellow').state, { type: 'exit', workerId: id });
  assert.equal(state.slots[0].status, 'empty');
  assert.deepEqual([card(state, 1)?.column, card(state, 1)?.slotId], ['spec', undefined]);
  assert.equal(card(state, 1)?.sessionId, card(first, 1)?.sessionId);
  assert.equal(effects.length, 0);
  const again = signaled(state, 'green');
  assert.equal(cardOf(again.state.cards, again.state.slots[0])?.task.id, '1', 'board order: 1 before 2');
  assert.notEqual(card(again.state, 1)?.sessionId, card(first, 1)?.sessionId, 'spec is new: a fresh session each run');
  const draining = reduce(filled(2, 2).state, { type: 'setMax', max: 1 }).state;
  const gone = reduce(draining, { type: 'exit', workerId: draining.slots[1].workerId! }).state;
  assert.equal(gone.slots.length, 1, 'a draining slot is removed');
  assert.equal(card(gone, 2)?.slotId, undefined);
});

test('poll rules on a known card: same board column nothing; moved by hand into a from while stopped → the column follows; while running only boardColumn', () => {
  const two = signaled(polled(base(1), [listed(1, 'Backlog'), listed(2, 'Backlog')]).state, 'yellow').state; // 1 running in spec, 2 stopped in spec
  const moved = polled(two, [listed(1, 'In review'), listed(2, 'In review')]).state;
  assert.deepEqual([card(moved, 1)?.column, card(moved, 1)?.boardColumn], ['spec', 'In review'], 'running: the Hive column waits for the Stop');
  assert.deepEqual([card(moved, 2)?.column, card(moved, 2)?.boardColumn], ['review', 'In review']);
  const outside = polled(moved, [listed(1, 'In review'), listed(2, 'In progress')]).state;
  assert.deepEqual([card(outside, 2)?.column, card(outside, 2)?.boardColumn], ['review', 'In progress'], 'not a from: only boardColumn');
  assert.deepEqual(polled(outside, [listed(1, 'In review'), listed(2, 'In progress')]).state.cards, outside.cards, 'same again: same content');
  const done = stopped(outside, outside.slots[0].workerId!);
  assert.deepEqual(done.effects[1], { type: 'setColumn', itemId: 'item1', column: 'Ready' }, 'onFinish overwrites the human move');
});

test('poll updates the task fields, reorders by the listing and keeps unlisted cards in place', () => {
  const first = signaled(polled(base(1), [listed(1), listed(2), listed(3)]).state, 'yellow').state;
  const { state } = polled(first, [{ task: { ...task(3), title: 'Renamed', blockedBy: ['1'] }, column: 'Backlog' }, listed(1)]);
  assert.deepEqual(state.cards.map((c) => c.task.id), ['3', '2', '1']);
  assert.equal(card(state, 3)?.task.title, 'Renamed');
  assert.deepEqual(card(state, 3)?.task.blockedBy, ['1']);
  assert.equal(card(state, 2)?.missing, true, 'not listed: missing, kept at its index');
  assert.equal(card(state, 1)?.missing, undefined);
});

test('a card the board stops listing is missing (out of contention, keeps running); listed again it loses the mark', () => {
  const first = signaled(polled(base(1), [listed(1), listed(2)]).state, 'yellow').state; // 1 running, 2 stopped
  const gone = polled(first, []).state;
  assert.deepEqual(gone.cards.map((c) => [c.task.id, c.missing, c.slotId !== undefined]), [['1', true, true], ['2', true, false]]);
  assert.equal(signaled(gone, 'green').effects.length, 0, 'missing: never started');
  const back = polled(gone, [listed(2)]).state;
  assert.equal(card(back, 2)?.missing, undefined);
  const finished = stopped(back, back.slots[0].workerId!);
  assert.deepEqual(finished.effects.map((e) => e.type), ['kill'], 'a missing card finishes without a board write');
  assert.equal(card(finished.state, 1)?.column, 'dev');
});

test('closeCard removes a missing card, killing its session when it runs; keepCard turns it into an orphan that runs to the end without board writes and is ignored by the poll', () => {
  const first = signaled(polled(base(2), [listed(1), listed(2)]).state, 'yellow').state; // both running
  const gone = polled(first, []).state;
  const closed = reduce(gone, { type: 'closeCard', cardId: 'item1' });
  assert.deepEqual(closed.effects, [{ type: 'kill', slug: 'hive-1-task-1', workerId: first.slots[0].workerId }]);
  assert.deepEqual(closed.state.cards.map((c) => c.task.id), ['2']);
  assert.equal(closed.state.slots[0].status, 'empty');
  const kept = reduce(closed.state, { type: 'keepCard', cardId: 'item2' });
  assert.equal(kept.effects.length, 0);
  assert.deepEqual([card(kept.state, 2)?.orphan, card(kept.state, 2)?.missing], [true, undefined]);
  const finished = stopped(kept.state, kept.state.slots[1].workerId!);
  assert.deepEqual(finished.effects.map((e) => e.type), ['kill']);
  assert.equal(card(finished.state, 2)?.column, 'dev');
  const green = signaled(finished.state, 'green');
  assert.deepEqual(green.effects.map((e) => e.type), ['spawn'], 'orphan in dev: no onStart write');
  assert.equal(polled(green.state, [listed(2, 'In review')]).state.cards.find((c) => c.task.id === '2')?.column, 'dev', 'the poll ignores an orphan');
  assert.equal(reduce(closed.state, { type: 'closeCard', cardId: 'nope' }).state, closed.state, 'unknown: same object');
  assert.equal(reduce(first, { type: 'closeCard', cardId: 'item1' }).state, first, 'not missing: refused');
  assert.equal(reduce(first, { type: 'keepCard', cardId: 'item1' }).state, first);
});

test('reducer never mutates its input', () => {
  const before = base(2);
  const snapshot = JSON.stringify(before);
  reduce(before, { type: 'poll', cards: many(3) });
  reduce(before, { type: 'setSignal', signal: 'red' });
  reduce(before, { type: 'setUsageRules', usageRules: RULES });
  assert.equal(JSON.stringify(before), snapshot);
  const first = filled(1, 2).state;
  const firstSnapshot = JSON.stringify(first);
  const id = first.slots[0].workerId!;
  reduce(first, { type: 'hook', workerId: id, payload: { hook_event_name: 'Stop' }, tokens: 900 });
  reduce(first, { type: 'poll', cards: [] });
  reduce(first, { type: 'start', itemId: 'item2', raiseMax: true });
  reduce(first, { type: 'setColumns', columns: [] });
  reduce(first, { type: 'done', workerId: id });
  reduce(first, { type: 'spawnFailed', workerId: id, message: 'tmux: boom' });
  assert.equal(JSON.stringify(first), firstSnapshot);
  const gone = polled(first, []).state;
  const goneSnapshot = JSON.stringify(gone);
  reduce(gone, { type: 'closeCard', cardId: 'item1' });
  reduce(gone, { type: 'keepCard', cardId: 'item2' });
  assert.equal(JSON.stringify(gone), goneSnapshot);
});

test('setColumns replaces the columns, drops stopped cards whose column vanished and keeps running ones until they finish', () => {
  const first = signaled(polled(base(1), [listed(1), listed(2)]).state, 'yellow').state;
  const renamed: Column[] = [{ name: 'triage', weight: 1, from: ['Backlog'], prompt: 'x' }];
  const { state, effects } = reduce(first, { type: 'setColumns', columns: renamed });
  assert.deepEqual(state.columns, renamed);
  assert.deepEqual(state.cards.map((c) => c.task.id), ['1'], 'the running one stays');
  assert.equal(effects.length, 0);
  const done = stopped(state, state.slots[0].workerId!);
  assert.deepEqual(done.effects.map((e) => e.type), ['kill'], 'unknown column: no write, no next');
  assert.deepEqual(done.state.cards, []);
});

test('setMax up adds empty slots and fills them; down marks extra occupied slots draining and drops surplus empty ones', () => {
  const { state, effects } = reduce(filled(1, 3).state, { type: 'setMax', max: 2 });
  assert.equal(state.maxConcurrent, 2);
  assert.equal(occupied(state).length, 2);
  assert.equal(effects.filter((e) => e.type === 'spawn').length, 1);
  const down = reduce(filled(3, 3).state, { type: 'setMax', max: 1 });
  assert.equal(down.effects.length, 0);
  assert.deepEqual(down.state.slots.map((s) => s.draining), [undefined, true, true]);
  assert.equal(reduce(base(3), { type: 'setMax', max: 1 }).state.slots.length, 1);
});

test('SessionStart records worktree and branch on the card, transcript path and session id on the slot; the first session id wins; malformed values are dropped', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const uuid = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const { state } = reduce(first, {
    type: 'hook', workerId: id, branch: 'hive-1-task-1',
    payload: { hook_event_name: 'SessionStart', cwd: '/repo/.claude/worktrees/hive-1-task-1', transcript_path: '/Users/x/.claude/projects/p/abc.jsonl', session_id: uuid },
  });
  assert.equal(card(state, 1)?.worktree, '/repo/.claude/worktrees/hive-1-task-1');
  assert.equal(card(state, 1)?.branch, 'hive-1-task-1');
  assert.equal(state.slots[0].transcriptPath, '/Users/x/.claude/projects/p/abc.jsonl');
  assert.equal(state.slots[0].sessionId, uuid);
  const teammate = hook(state, id, { hook_event_name: 'SessionStart', cwd: '/w', session_id: 'another-session-id-0001' }).state;
  assert.equal(teammate.slots[0].sessionId, uuid, 'a teammate SessionStart does not replace the main session (#24)');
  for (const bad of ['', 'short', 'has space-in-it', 'x'.repeat(65), '../../etc/passwd']) {
    assert.equal(hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w', session_id: bad }).state.slots[0].sessionId, undefined, JSON.stringify(bad));
  }
  assert.equal(hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w', transcript_path: 'abc.jsonl' }).state.slots[0].transcriptPath, undefined);
});

test('isChildSession: no slot id, no payload id, a malformed payload id and a matching id are all false; a different well-formed id is true (#24)', () => {
  const mainId = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const childId = 'another-child-session-0001';
  const slot: Slot = { id: 's1', status: 'working', sessionId: mainId };
  assert.equal(isChildSession(undefined, { hook_event_name: 'Stop', session_id: childId }), false);
  assert.equal(isChildSession({ id: 's1', status: 'working' }, { hook_event_name: 'Stop', session_id: childId }), false);
  assert.equal(isChildSession(slot, { hook_event_name: 'Stop' }), false);
  assert.equal(isChildSession(slot, { hook_event_name: 'Stop', session_id: 'short' }), false);
  assert.equal(isChildSession(slot, { hook_event_name: 'Stop', session_id: mainId }), false);
  assert.equal(isChildSession(slot, { hook_event_name: 'Stop', session_id: childId }), true);
});

test('Stop or SessionEnd from a child session changes nothing: no finish, no exit, no token sample (#24)', () => {
  const first = filled(1, 2).state;
  const id = first.slots[0].workerId!;
  const mainId = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const started = hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w', session_id: mainId }).state;
  const child = reduce(started, { type: 'hook', workerId: id, payload: { hook_event_name: 'Stop', session_id: 'another-child-session-0001' }, tokens: 999 });
  assert.equal(child.state, started, 'same object');
  assert.equal(child.effects.length, 0);
  const end = hook(started, id, { hook_event_name: 'SessionEnd', session_id: 'another-child-session-0001' });
  assert.equal(end.state, started);
  assert.deepEqual(stopped(started, id).effects.map((e) => e.type), ['kill', 'setColumn', 'spawn'], 'the main session still finishes (and card 2 starts)');
  assert.deepEqual(hook(done(started, id), id, { hook_event_name: 'Stop', session_id: mainId }).effects[0].type, 'kill');
});

test('Notification of a waiting type turns the slot yellow with the message; other types are ignored; a prompt or a tool brings it back', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const yellow = hook(first, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' }).state;
  assert.equal(yellow.slots[0].status, 'waiting');
  assert.equal(yellow.slots[0].question, 'Allow Bash?');
  assert.deepEqual(yellow.slots[0].lastEvent, { kind: 'waiting', detail: 'permission_prompt' });
  assert.equal(hook(first, id, { hook_event_name: 'Notification', notification_type: 'auth_success', message: 'ok' }).state.slots[0].status, 'working');
  const green = hook(yellow, id, { hook_event_name: 'UserPromptSubmit' }).state;
  assert.equal(green.slots[0].status, 'working');
  assert.equal(green.slots[0].question, undefined);
  assert.deepEqual(green.slots[0].lastEvent, { kind: 'prompt' });
  const tool = hook(yellow, id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' } }).state;
  assert.equal(tool.slots[0].status, 'working');
  assert.deepEqual(tool.slots[0].lastEvent, { kind: 'tool', detail: 'Bash: pnpm test' });
});

test('PostToolUse with gh pr create records the PR on the card and turns the slot blue with no effect; other commands change nothing', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const { state, effects } = hook(first, id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: { stdout: 'https://github.com/o/r/pull/42\n' } });
  assert.equal(state.slots[0].status, 'review');
  assert.equal(card(state, 1)?.prUrl, 'https://github.com/o/r/pull/42');
  assert.deepEqual(state.slots[0].lastEvent, { kind: 'pr' });
  assert.equal(effects.length, 0);
  const back = hook(hook(state, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }).state, id, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }).state;
  assert.equal(back.slots[0].status, 'review', 'after a PR the active colour is review');
  const other = hook(first, id, { hook_event_name: 'PostToolUse', tool_input: { command: 'git status' }, tool_response: 'clean' });
  assert.equal(other.state.slots[0].status, 'working');
  assert.equal(other.effects.length, 0);
  const finished = stopped(state, id);
  assert.equal(card(finished.state, 1)?.prUrl, 'https://github.com/o/r/pull/42', 'the PR travels with the card');
});

test('SessionEnd behaves like exit; exit is idempotent and ignores unknown or replaced worker ids', () => {
  const first = filled(1, 2).state;
  const id = first.slots[0].workerId!;
  const { state, effects } = hook(first, id, { hook_event_name: 'SessionEnd' });
  assert.equal(cardOf(state.cards, state.slots[0])?.task.id, '1', 'card 1 runs again (board order)');
  assert.equal(effects.length, 1);
  const w2 = state.slots[0].workerId!;
  assert.ok(w2 !== id, 'refill assigns a fresh worker id');
  const stale = reduce(state, { type: 'exit', workerId: id });
  assert.equal(stale.state, state);
  assert.equal(reduce(first, { type: 'exit', workerId: 'nope' }).state, first);
  const staleHook = hook(state, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' });
  assert.equal(staleHook.state.slots[0].status, 'working');
  const s = base(1);
  assert.equal(hook(s, 'ghost', { hook_event_name: 'Stop' }).state, s);
});

test('boot gives every occupied slot as dead: slots empty, cards keep their column and session id, no effects, and opens under yellow unless red', () => {
  const first = filled(2, 3).state;
  const { state, effects } = reduce(first, { type: 'boot' });
  assert.deepEqual(state.slots.map((s) => s.status), ['empty', 'empty']);
  assert.deepEqual(state.cards.map((c) => [c.column, c.slotId]), [['spec', undefined], ['spec', undefined], ['spec', undefined]]);
  assert.equal(card(state, 1)?.sessionId, card(first, 1)?.sessionId);
  assert.equal(effects.length, 0, 'no board write, no spawn');
  assert.equal(state.signal, 'yellow');
  assert.equal(reduce(signaled(base(1), 'red').state, { type: 'boot' }).state.signal, 'red');
});

test('boot clears a slotId that points at no occupied slot, so a card from a tampered or half-written state.json is not stuck', () => {
  const first = filled(1, 1).state;
  const stale: State = { ...first, slots: first.slots.map((s) => ({ id: s.id, status: 'empty' as const })) }; // normalizeSlot on an unknown status
  const { state } = reduce(stale, { type: 'boot' });
  assert.equal(card(state, 1)?.slotId, undefined);
  assert.equal(card(state, 1)?.column, 'spec');
});

test('kill emits a kill effect with the card slug; error sets and poll clears state.error', () => {
  const first = filled(1, 1).state;
  assert.deepEqual(reduce(first, { type: 'kill', slotId: first.slots[0].id }).effects, [{ type: 'kill', slug: 'hive-1-task-1', workerId: first.slots[0].workerId }]);
  assert.deepEqual(reduce(first, { type: 'kill', slotId: 'nope' }).effects, []);
  const withError = reduce(base(1), { type: 'error', message: 'gh: boom' }).state;
  assert.equal(withError.error, 'gh: boom');
  assert.equal(polled(withError, []).state.error, undefined);
});

test('initialState starts green with no cards, no columns, no usage; canStart is true only under green with a free, non-draining slot', () => {
  const idle = initialState(2);
  assert.deepEqual([idle.signal, idle.cards, idle.columns, idle.usage, idle.budget], ['green', [], [], [], {}]);
  assert.equal(canStart('green', idle.slots), true);
  assert.equal(canStart('green', filled(2, 2).state.slots), false);
  assert.equal(canStart('green', [{ id: 'x', status: 'empty', draining: true }]), false);
  assert.equal(canStart('green', []), false);
  assert.equal(canStart('yellow', idle.slots), false);
  assert.equal(canStart('green', filled(2, 1).state.slots, 1), false, 'occupied 1 = limit 1');
  assert.equal(canStart('green', filled(2, 1).state.slots, 2), true);
});

test('poll under yellow or red enters the cards and spawns nothing; setSignal green fills', () => {
  const yellow = polled(signaled(base(2), 'yellow').state, many(3));
  assert.equal(yellow.state.cards.length, 3);
  assert.equal(occupied(yellow.state).length, 0);
  assert.equal(yellow.effects.length, 0);
  const red = signaled(yellow.state, 'red');
  assert.equal(red.effects.length, 0);
  const green = signaled(red.state, 'green');
  assert.equal(occupied(green.state).length, 2);
  assert.deepEqual(green.effects.map((e) => e.type), ['spawn', 'spawn']);
  assert.equal(reduce(signaled(filled(1, 3).state, 'red').state, { type: 'setMax', max: 3 }).effects.length, 0, 'setMax up under red spawns nothing');
});

test('Stop with tokens records the sample even though the slot is freed; a SessionEnd with tokens too; no tokens adds nothing; unknown worker is ignored', () => {
  const first = signaled(filled(1, 1).state, 'yellow').state; // yellow: dev has a prompt, so under green the Stop would refill the slot at once
  const id = first.slots[0].workerId!;
  const one = counted(first, id, 1200);
  assert.deepEqual(one.usage.map((s) => s.tokens), [1200]);
  assert.ok(Number.isFinite(Date.parse(one.usage[0].at)));
  assert.equal(one.slots[0].status, 'empty', 'Stop finishes the run');
  const partial = reduce(first, { type: 'hook', workerId: id, payload: { hook_event_name: 'SessionEnd' }, tokens: 800 }).state;
  assert.deepEqual(partial.usage.map((s) => s.tokens), [800]);
  assert.equal(stopped(first, id).state.usage.length, 0);
  assert.equal(reduce(first, { type: 'hook', workerId: 'nope', payload: { hook_event_name: 'Stop' }, tokens: 999 }).state, first);
});

test('poll under an exhausted hour budget enters cards and starts nothing; a sample outside the hour does not count; setBudget can reopen', () => {
  const blocked = polled(spent(1000, 0, { maxTokensPerHour: 1000 }), many(2));
  assert.equal(occupied(blocked.state).length, 0);
  assert.equal(blocked.state.cards.length, 2);
  assert.equal(blocked.effects.length, 0);
  const reopened = polled(spent(1000, 2 * HOUR_MS, { maxTokensPerHour: 1000 }), many(2));
  assert.equal(occupied(reopened.state).length, 1);
  assert.equal(occupied(polled(spent(1000, 2 * HOUR_MS, { maxTokensPerDay: 1000 }), many(1)).state).length, 0);
  const raised = reduce(blocked.state, { type: 'setBudget', budget: { maxTokensPerHour: 5000 } });
  assert.deepEqual(raised.state.budget, { maxTokensPerHour: 5000 });
  assert.deepEqual(raised.effects.map((e) => e.type), ['spawn']);
});

test('usage rules: a cap opens up to the cap and drains nothing; yellow stops fill without touching the manual signal; aging out reopens', () => {
  const capped = polled(ruled(base(3), 550), many(3)); // 55%: cap 1
  assert.equal(capped.state.maxConcurrent, 3);
  assert.equal(occupied(capped.state).length, 1);
  assert.ok(capped.state.slots.every((s) => !s.draining));
  const three = ruled(filled(3, 4).state, 550); // 3 running, 1 stopped, cap 1
  const freed = reduce(three, { type: 'exit', workerId: three.slots[0].workerId! });
  assert.equal(freed.effects.length, 0, 'the freed slot stays empty while occupied >= cap');
  assert.equal(occupied(freed.state).length, 2);
  const yellow = polled(ruled(base(1), 850), many(1)); // 85%: dynamic yellow
  assert.equal(yellow.state.signal, 'green');
  assert.equal(occupied(yellow.state).length, 0);
  const aged = polled(ruled(yellow.state, 850, 2 * HOUR_MS), many(1));
  assert.equal(occupied(aged.state).length, 1);
  const loosened = reduce(capped.state, { type: 'setUsageRules', usageRules: [] });
  assert.deepEqual(loosened.state.usageRules, []);
  assert.deepEqual(loosened.effects.map((e) => e.type), ['spawn', 'spawn'], 'lifting the cap pulls the rest right away');
  assert.equal(reduce(loosened.state, { type: 'setUsageRules', usageRules: RULES }).effects.length, 0, 'rules that tighten never kill or drain');
});

test('Stop under a red signal (manual or dynamic) still finishes the run: there is no paused state any more', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const manual = stopped(signaled(first, 'red').state, id);
  assert.equal(manual.state.slots[0].status, 'empty');
  assert.equal(manual.effects[0].type, 'kill');
  assert.equal(card(manual.state, 1)?.column, 'dev');
  const dynamic = counted(ruled({ ...first, usage: [] }, 0), id, 950); // 95% in one turn
  assert.equal(dynamic.slots[0].status, 'empty');
  assert.equal('paused' in dynamic.slots[0], false);
});

test('rateLimits from an occupied slot stores the reading with no effect; unknown or exited worker leaves the state; the Hive own reading is always kept', () => {
  const first = filled(1, 2).state;
  const id = first.slots[0].workerId!;
  const roomy: State = { ...first, maxConcurrent: 2, slots: [...first.slots, { id: 'free', status: 'empty' }] };
  const { state, effects } = limited(roomy, id);
  assert.deepEqual(state.rateLimits, LIMITS);
  assert.equal(effects.length, 0, 'display only: no fill, no spawn');
  assert.equal(state.slots[1].status, 'empty');
  assert.equal(limited(first, 'ghost').state, first);
  const gone = reduce(first, { type: 'exit', workerId: id }).state;
  assert.equal(limited(gone, id).state.rateLimits, undefined);
  const own = reduce(base(1), { type: 'rateLimits', rateLimits: LIMITS });
  assert.deepEqual(own.state.rateLimits, LIMITS);
  assert.deepEqual(reduce(reduce(state, { type: 'poll', cards: many(1) }).state, { type: 'boot' }).state.rateLimits, LIMITS, 'survives poll and boot');
});

test('boardQuota stores the reading, emits no effect and never fills; a poll keeps the last reading', () => {
  const first = filled(1, 2).state;
  const roomy: State = { ...first, maxConcurrent: 2, slots: [...first.slots, { id: 'free', status: 'empty' }] };
  const { state, effects } = reduce(roomy, { type: 'boardQuota', quota: QUOTA });
  assert.deepEqual(state.boardQuota, QUOTA);
  assert.equal(effects.length, 0);
  assert.equal(state.slots[1].status, 'empty');
  assert.deepEqual(polled(state, many(2)).state.boardQuota, QUOTA);
});

test('canSchedule is the fill gate: green with a free slot and budget; not under yellow, a reached cap or an exhausted budget', () => {
  const now = Date.now();
  assert.equal(canSchedule(base(1), now), true);
  assert.equal(canSchedule(filled(1, 1).state, now), false);
  assert.equal(canSchedule(signaled(base(1), 'yellow').state, now), false);
  assert.equal(canSchedule(spent(1000, 0, { maxTokensPerHour: 1000 }), now), false);
  assert.equal(canSchedule(spent(1000, 2 * HOUR_MS, { maxTokensPerHour: 1000 }), now), true);
  assert.equal(canSchedule(ruled(filled(2, 1).state, 550), now), false, '55%: cap 1 with one occupied');
  assert.equal(canSchedule(ruled(base(1), 850), now), false, '85%: dynamic yellow');
  assert.equal(canSchedule(ruled(base(1), 100), now), true);
});

test('slugFor strips accents, lowercases, caps the title at 30 chars and kebab-izes the id; isBlocked is true only for a non-empty blockedBy', () => {
  assert.equal(slugFor({ ...task(12), title: 'Adicionar Autenticação OAuth no backend da API v2' }), 'hive-12-adicionar-autenticacao-oauth-n');
  assert.equal(slugFor({ ...task(3), title: '  --weird__title!!  ' }), 'hive-3-weird-title');
  assert.equal(slugFor({ ...task(1), id: 'T-12', title: 'Exemplo' }), 'hive-t-12-exemplo');
  assert.equal(slugFor({ ...task(1), id: 'Épico #3', title: 'x' }), 'hive-epico-3-x');
  assert.equal(isBlocked(task(1)), false);
  assert.equal(isBlocked({ ...task(1), blockedBy: [] }), false);
  assert.equal(isBlocked({ ...task(1), blockedBy: ['T-1'] }), true);
});

test('fill skips a blocked card, takes the next free one, and a later poll without blockedBy starts it', () => {
  const { state, effects } = polled(base(1), [{ task: { ...task(1), blockedBy: ['3'] }, column: 'Backlog' }, listed(2), listed(3)]);
  assert.equal(cardOf(state.cards, state.slots[0])?.task.id, '2');
  assert.deepEqual(state.cards.map((c) => c.task.id), ['1', '2', '3'], 'the blocked card keeps its place');
  assert.deepEqual(effects.map((e) => e.type), ['spawn']);
  const waiting = polled(base(1), [{ task: { ...task(1), blockedBy: ['2'] }, column: 'Backlog' }]);
  assert.equal(waiting.state.slots[0].status, 'empty');
  assert.equal(polled(waiting.state, [listed(1)]).state.slots[0].cardId, 'item1');
  assert.equal(polled(base(1), [{ task: { ...task(1), blockedBy: [] }, column: 'Backlog' }]).state.slots[0].cardId, 'item1', 'blockedBy: [] counts as free');
});

test('extractPrUrl finds the PR url only for gh pr create; isFree is true only for an empty slot that is not draining', () => {
  assert.equal(extractPrUrl('gh pr create --fill', 'https://github.com/a/b/pull/9\n'), 'https://github.com/a/b/pull/9');
  assert.equal(extractPrUrl('gh pr create', { stdout: 'x https://github.com/a/b-c/pull/10 y' }), 'https://github.com/a/b-c/pull/10');
  assert.equal(extractPrUrl('gh pr view', 'https://github.com/a/b/pull/9'), undefined);
  assert.equal(isFree({ id: 'x', status: 'empty' }), true);
  assert.equal(isFree({ id: 'x', status: 'empty', draining: true }), false);
  assert.equal(isFree(filled(1, 1).state.slots[0]), false);
});

test('start under yellow or red runs a stopped card in its own column, marked manualStart, ignoring the cap and the budget, and never fills', () => {
  const yellow = polled(signaled(base(2), 'yellow').state, [listed(1, 'Ready'), listed(2), listed(3)]).state;
  const { state, effects } = started(yellow, 'item1');
  assert.equal(state.signal, 'yellow');
  assert.equal(state.slots[0].cardId, 'item1');
  assert.deepEqual(state.slots[0].lastEvent, { kind: 'manualStart' });
  assert.equal(card(state, 1)?.column, 'dev', 'its own column, whatever the weights');
  assert.equal(state.slots[1].status, 'empty', 'only the card asked for opens');
  assert.deepEqual(effects.map((e) => e.type), ['setColumn', 'spawn']);
  assert.equal(started(signaled(yellow, 'red').state, 'item3').state.slots[0].cardId, 'item3');
  const capped = polled(ruled(base(3), 550), many(3)).state; // cap 1: one running
  assert.deepEqual(occupied(started(capped, 'item3').state).map((s) => s.cardId), ['item1', 'item3']);
  const broke = polled(spent(1000, 0, { maxTokensPerHour: 1000 }), many(1)).state;
  assert.equal(started(broke, 'item1').state.slots[0].cardId, 'item1');
});

test('start leaves the state as is for an unknown, running, missing or blocked card, a column without prompt, and no free slot without raiseMax', () => {
  const queued = polled(signaled(base(1), 'yellow').state, [{ task: { ...task(1), blockedBy: ['3'] }, column: 'Backlog' }, listed(2, 'In review'), listed(3)]).state;
  for (const [itemId, why] of [['nope', 'unknown'], ['item1', 'blocked'], ['item2', 'no prompt']] as const) {
    const { state, effects } = started(queued, itemId, true);
    assert.equal(state, queued, why);
    assert.equal(effects.length, 0, why);
  }
  const full = filled(1, 2).state;
  assert.equal(started(full, 'item2').state, full, 'no free slot and no raiseMax');
  assert.equal(started(full, 'item1', true).state, full, 'already running');
  const gone = polled(full, [listed(1)]).state;
  assert.equal(started(gone, 'item2', true).state, gone, 'missing');
});

test('start with raiseMax and no free slot sets maxConcurrent to occupied + 1 and opens the card in the new slot; a free slot ignores raiseMax', () => {
  const full = filled(2, 3).state;
  const { state, effects } = started(full, 'item3', true);
  assert.equal(state.maxConcurrent, 3);
  assert.deepEqual(state.slots.map((s) => s.cardId), ['item1', 'item2', 'item3']);
  assert.deepEqual(state.slots[2].lastEvent, { kind: 'manualStart' });
  assert.deepEqual(effects.map((e) => e.type), ['spawn']);
  const draining = reduce(filled(3, 4).state, { type: 'setMax', max: 1 }).state;
  const raised = started(draining, 'item4', true).state;
  assert.equal(raised.maxConcurrent, 4);
  assert.ok(raised.slots.every((s) => !s.draining));
  const roomy = polled(signaled(base(2), 'yellow').state, many(1)).state;
  const kept = started(roomy, 'item1', true).state;
  assert.equal(kept.maxConcurrent, 2);
  assert.equal(kept.slots[0].cardId, 'item1');
});

test('mergeCards is pure: an empty listing over no cards is no cards, and a card in an unknown column is left alone', () => {
  assert.deepEqual(mergeCards([], COLUMNS, []), []);
  const stray: Card = { task: task(1), column: 'gone', boardColumn: 'Backlog', slug: 'x' };
  assert.deepEqual(mergeCards([stray], COLUMNS, [listed(1)]), [{ ...stray, task: task(1) }]);
});

test('done marks the occupied slot; a Stop without it leaves the slot waiting with no effects and the card in place; a prompt or a tool brings it back; boot clears it', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const { state, effects } = hook(first, id, { hook_event_name: 'Stop' });
  assert.equal(effects.length, 0, 'no kill, no write, no spawn');
  assert.equal(state.slots[0].status, 'waiting');
  assert.deepEqual(state.slots[0].lastEvent, { kind: 'turn' });
  assert.equal(state.slots[0].workerId, id, 'the session stays alive');
  assert.deepEqual([card(state, 1)?.column, card(state, 1)?.slotId], ['spec', first.slots[0].id]);
  assert.equal(hook(state, id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).state.slots[0].status, 'working');
  assert.equal(hook(state, id, { hook_event_name: 'UserPromptSubmit' }).state.slots[0].status, 'working');
  const marked = done(state, id);
  assert.equal(marked.slots[0].done, true);
  assert.equal(marked.slots[0].status, 'waiting', 'done alone changes nothing else');
  assert.equal(done(marked, id).slots[0].done, true, 'idempotent');
  assert.equal(done(first, 'ghost'), first, 'unknown worker: same object');
  assert.equal(reduce(marked, { type: 'boot' }).state.slots[0].done, undefined);
  assert.equal(stopped(signaled(state, 'yellow').state, id).effects[0].type, 'kill', 'with done the Stop ends the stage');
});

test('Stop with done continues in place when the next column has a prompt and session continue and the card is next in line: no kill, same worker, onFinish then onStart written, card in the next column with its slot', () => {
  const first = filled(1, 1).state; // green: spec → dev, dev continues the session
  const id = first.slots[0].workerId!;
  const { state, effects } = stopped(first, id);
  const moved = card(state, 1)!;
  assert.deepEqual(effects, [
    { type: 'setColumn', itemId: 'item1', column: 'Ready' },
    { type: 'setColumn', itemId: 'item1', column: 'In progress' },
    { type: 'continue', workerId: id, card: moved, column: COLUMNS[1] },
  ]);
  assert.deepEqual([moved.column, moved.boardColumn, moved.slotId, moved.sessionId], ['dev', 'In progress', first.slots[0].id, card(first, 1)?.sessionId]);
  const slot = state.slots[0];
  assert.deepEqual([slot.workerId, slot.status, slot.done, slot.question, slot.cardId], [id, 'working', undefined, undefined, 'item1']);
  assert.deepEqual(slot.lastEvent, { kind: 'continuing' });
  assert.equal(slot.startedAt, first.slots[0].startedAt, 'the same run goes on');
  assert.equal(hook(state, id, { hook_event_name: 'Stop' }).effects.length, 0, 'done was cleared: the next Stop waits for a new done');
  const again = stopped(state, id); // dev is the last column with a prompt: the card parks in review, the session dies
  assert.deepEqual(again.effects, [{ type: 'kill', slug: 'hive-1-task-1', workerId: id }, { type: 'setColumn', itemId: 'item1', column: 'In review' }]);
  assert.deepEqual([card(again.state, 1)?.column, card(again.state, 1)?.slotId, again.state.slots[0].status], ['review', undefined, 'empty']);
});

test('Stop with done kills and respawns instead when a heavier card waits, when the next column is new, under yellow, or on a draining slot', () => {
  const two = filled(1, 2).state; // 1 runs in spec, 2 waits in spec (5): heavier than 1 in dev (1)
  const heavier = stopped(two, two.slots[0].workerId!);
  assert.deepEqual(heavier.effects.map((e) => e.type), ['kill', 'setColumn', 'spawn']);
  assert.ok(heavier.effects[2].type === 'spawn' && heavier.effects[2].card.task.id === '2', 'the heavier card takes the slot');
  assert.deepEqual([card(heavier.state, 1)?.column, card(heavier.state, 1)?.slotId], ['dev', undefined]);
  const fresh: Column[] = [COLUMNS[0], { ...COLUMNS[1], session: 'new' }, COLUMNS[2]];
  const one = polled(base(1, fresh), many(1)).state;
  const renewed = stopped(one, one.slots[0].workerId!);
  assert.deepEqual(renewed.effects.map((e) => e.type), ['kill', 'setColumn', 'setColumn', 'spawn'], 'same card, new session: kill then spawn in the same batch');
  assert.ok(renewed.effects[3].type === 'spawn' && renewed.effects[3].card.task.id === '1' && renewed.effects[3].session === 'new');
  assert.notEqual(renewed.state.slots[0].workerId, one.slots[0].workerId);
  const single = filled(1, 1).state;
  const yellow = stopped(signaled(single, 'yellow').state, single.slots[0].workerId!);
  assert.deepEqual(yellow.effects.map((e) => e.type), ['kill', 'setColumn']);
  assert.deepEqual([card(yellow.state, 1)?.column, card(yellow.state, 1)?.slotId, yellow.state.slots[0].status], ['dev', undefined, 'empty']);
  assert.equal(card(yellow.state, 1)?.sessionId, card(single, 1)?.sessionId, 'waits for a slot and resumes later');
  const drained = reduce(filled(2, 2).state, { type: 'setMax', max: 1 }).state; // slot 2 draining
  const gone = stopped(drained, drained.slots[1].workerId!);
  assert.deepEqual(gone.effects.map((e) => e.type), ['kill', 'setColumn']);
  assert.equal(gone.state.slots.length, 1, 'the draining slot leaves');
  assert.deepEqual([card(gone.state, 2)?.column, card(gone.state, 2)?.slotId], ['dev', undefined]);
});

test('spawnFailed frees the slot, keeps the card in its column with the error and sets the bar; fill skips it, another card may take the slot; start clears it and runs', () => {
  const two = filled(1, 2).state; // 1 runs, 2 waits
  const { state, effects } = reduce(two, { type: 'spawnFailed', workerId: two.slots[0].workerId!, message: 'tmux: duplicate session: hive-1-task-1' });
  assert.equal(card(state, 1)?.error, 'tmux: duplicate session: hive-1-task-1');
  assert.deepEqual([card(state, 1)?.column, card(state, 1)?.slotId], ['spec', undefined]);
  assert.equal(state.error, 'tmux: duplicate session: hive-1-task-1');
  assert.equal(state.slots[0].cardId, 'item2', 'the freed slot goes to the next card, never back to the failed one');
  assert.deepEqual(effects.map((e) => e.type), ['spawn']);
  assert.deepEqual(candidates(state.cards, state.columns), [], 'a card with an error is never picked');
  assert.equal(reduce(two, { type: 'spawnFailed', workerId: 'ghost', message: 'x' }).state, two, 'unknown worker: same object');
  const single = filled(1, 1).state;
  const failed = reduce(single, { type: 'spawnFailed', workerId: single.slots[0].workerId!, message: 'tmux: spawn tmux ENOENT' });
  assert.equal(failed.effects.length, 0, 'no retry');
  assert.equal(failed.state.slots[0].status, 'empty');
  assert.equal(polled(failed.state, many(1)).effects.length, 0, 'a poll does not retry either');
  assert.equal(card(polled(failed.state, many(1)).state, 1)?.error, 'tmux: spawn tmux ENOENT', 'the error survives the poll');
  const retried = started(failed.state, 'item1');
  assert.equal(card(retried.state, 1)?.error, undefined, 'start clears it');
  assert.deepEqual(retried.effects.map((e) => e.type), ['spawn']);
  assert.deepEqual(retried.state.slots[0].lastEvent, { kind: 'manualStart' });
});
