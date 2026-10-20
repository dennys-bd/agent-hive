import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZERO_TOKENS, type Correlation } from '../src/events.js';
import { createHumanSignals } from '../src/human-signals.js';
import type { HookPayload, Worker } from '../src/types.js';

const PTY = '1a2b3c4d-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-10-03T12:00:00.000Z');
const IDS: Correlation = { task_id: 'board:I1', activity_id: 'a-board:I1', stage: 'dev', attempt: 1 };
const working: Worker = { id: 'w1', runId: PTY, status: 'working', activityId: 'a-board:I1' };
const hook = (hook_event_name: string, extra: Partial<HookPayload> = {}): HookPayload => ({ hook_event_name, ...extra });
const USAGE = {
  tokens: { input: 10, output: 20, cache_write: 30, cache_read: 40 }, models: ['claude-opus-4-1'], subagentTokens: { input: 5, output: 0, cache_write: 0, cache_read: 1 },
  tokensByModel: { 'claude-opus-4-1': { input: 10, output: 20, cache_write: 30, cache_read: 40 } },
};

test('the spawn\'s prompt is the Hive\'s; each later prompt is a run.takeover timed to the next Stop, written once (#742)', () => {
  const signals = createHumanSignals();
  signals.expectPrompt(PTY);
  assert.deepEqual(signals.onHook(PTY, hook('UserPromptSubmit'), working, IDS, T0), []);
  assert.deepEqual(signals.onHook(PTY, hook('UserPromptSubmit'), working, IDS, T0 + 1000), []);
  assert.deepEqual(signals.onHook(PTY, hook('UserPromptSubmit'), working, IDS, T0 + 3000), []);
  assert.deepEqual(signals.onHook(PTY, hook('Stop'), working, IDS, T0 + 5000), [
    { event: 'run.takeover', level: 'info', ...IDS, outcome: 'ended', duration_ms: 4000 }, { event: 'run.takeover', level: 'info', ...IDS, outcome: 'ended', duration_ms: 2000 },
  ]);
  assert.deepEqual(signals.onHook(PTY, hook('Stop'), working, IDS, T0 + 6000), []);
});

test('a prompt while the worker waits on its hive_ask or an elicitation is question.answered from waitingSince; a free session\'s own prompt is no takeover (#742)', () => {
  const signals = createHumanSignals();
  const asking: Worker = { ...working, status: 'waiting', lastEvent: { kind: 'ask' }, waitingSince: new Date(T0).toISOString() };
  assert.deepEqual(signals.onHook(PTY, hook('UserPromptSubmit'), asking, IDS, T0 + 30_000), [{ event: 'question.answered', level: 'info', ...IDS, kind: 'ask', outcome: 'answered', duration_ms: 30_000 }]);
  const dialog: Worker = { ...working, status: 'waiting', lastEvent: { kind: 'waiting', detail: 'elicitation_dialog' }, waitingSince: new Date(T0).toISOString() };
  assert.deepEqual(signals.onHook(PTY, hook('UserPromptSubmit'), dialog, IDS, T0 + 5000), [{ event: 'question.answered', level: 'info', ...IDS, kind: 'elicitation', outcome: 'answered', duration_ms: 5000 }]);
  const free: Worker = { ...working, freeSession: true };
  assert.deepEqual(signals.onHook(PTY, hook('UserPromptSubmit'), free, IDS, T0), []);
  assert.deepEqual(signals.onHook(PTY, hook('Stop'), free, IDS, T0 + 1000), []);
});

test('a permission prompt then a tool use is granted; then a Stop denies the next one; both name the tool (#742)', () => {
  const signals = createHumanSignals();
  signals.onHook(PTY, hook('PreToolUse', { tool_name: 'Bash' }), working, IDS, T0);
  assert.deepEqual(signals.onHook(PTY, hook('Notification', { notification_type: 'permission_prompt' }), working, IDS, T0 + 100), []);
  assert.deepEqual(signals.onHook(PTY, hook('PostToolUse', { tool_name: 'Bash' }), working, IDS, T0 + 2100),
    [{ event: 'permission.answered', level: 'info', ...IDS, outcome: 'granted', tool: 'Bash', duration_ms: 2000 }]);
  signals.onHook(PTY, hook('Notification', { notification_type: 'permission_prompt' }), working, IDS, T0 + 3000);
  assert.deepEqual(signals.onHook(PTY, hook('Stop'), working, IDS, T0 + 4000),
    [{ event: 'permission.answered', level: 'info', ...IDS, outcome: 'denied', tool: 'Bash', duration_ms: 1000 }]);
});

test('a stage run counts its tool uses and ends once with its agent, the last turn\'s usage split per model, its time and its share of the waits (#742, #271)', () => {
  const signals = createHumanSignals();
  signals.openStageRun({ ptyId: PTY, correlation: { ...IDS, run_kind: 'spawn' }, waitedMs: 1000, agent: 'codex' }, T0);
  assert.equal(signals.usageSince(PTY), T0);
  for (const tool of ['Bash', 'Bash', 'Edit']) signals.onHook(PTY, hook('PreToolUse', { tool_name: tool }), working, IDS, T0 + 1);
  signals.onHook(PTY, hook('Stop'), working, IDS, T0 + 10, USAGE);
  assert.deepEqual(signals.endStageRun({ ptyId: PTY, outcome: 'done', waitedMs: 4000 }, T0 + 60_000), {
    event: 'stage.ended', level: 'info', ...IDS, run_kind: 'spawn', agent: 'codex', outcome: 'done', duration_ms: 60_000, waited_ms: 3000,
    tokens: USAGE.tokens, models: USAGE.models, subagent_tokens: USAGE.subagentTokens, tokens_by_model: USAGE.tokensByModel, tool_counts: { Bash: 2, Edit: 1 },
  });
  assert.equal(signals.endStageRun({ ptyId: PTY, outcome: 'exit', waitedMs: 0 }, T0 + 61_000), undefined, 'ended once');
});

test('a stage run opened in place starts with no usage of its own; prune forgets a pty no longer live (#742)', () => {
  const signals = createHumanSignals();
  signals.openStageRun({ ptyId: PTY, correlation: IDS, waitedMs: 0 }, T0);
  signals.onHook(PTY, hook('Stop'), working, IDS, T0 + 10, USAGE);
  signals.endStageRun({ ptyId: PTY, outcome: 'done', waitedMs: 0 }, T0 + 20);
  signals.openStageRun({ ptyId: PTY, correlation: { ...IDS, stage: 'review' }, waitedMs: 0 }, T0 + 20);
  const next = signals.endStageRun({ ptyId: PTY, outcome: 'exit', waitedMs: 0 }, T0 + 30) as Record<string, unknown> | undefined;
  assert.deepEqual([next?.tokens, next?.models, next?.tokens_by_model, next !== undefined && 'agent' in next], [ZERO_TOKENS, [], {}, false], 'no usage yet, and no agent for a run opened without one');
  signals.expectPrompt(PTY);
  signals.prune(new Set());
  signals.onHook(PTY, hook('UserPromptSubmit'), working, IDS, T0 + 40);
  assert.equal(signals.onHook(PTY, hook('Stop'), working, IDS, T0 + 50).length, 1, 'the dropped prompt count no longer covers it');
});

test('prune drops every tracker whose pty is not among the live runs: a prompt expected for a pty that never ran is not carried over (#742)', () => {
  const signals = createHumanSignals();
  signals.expectPrompt(PTY);
  signals.prune(new Set());
  signals.onHook(PTY, hook('UserPromptSubmit'), working, IDS, T0);
  assert.deepEqual(signals.onHook(PTY, hook('Stop'), working, IDS, T0 + 1000), [{ event: 'run.takeover', level: 'info', ...IDS, outcome: 'ended', duration_ms: 1000 }]);
  signals.expectPrompt(PTY);
  signals.prune(new Set([PTY]));
  assert.deepEqual(signals.onHook(PTY, hook('UserPromptSubmit'), working, IDS, T0 + 2000), [], 'a live run keeps its count');
});

test('tool_counts counts any tool name as its own key, __proto__ and constructor included, and folds past 50 distinct names into other (#742)', () => {
  const signals = createHumanSignals();
  signals.openStageRun({ ptyId: PTY, correlation: IDS, waitedMs: 0 }, T0);
  for (const tool of ['__proto__', 'constructor', 'toString', '__proto__']) signals.onHook(PTY, hook('PreToolUse', { tool_name: tool }), working, IDS, T0);
  for (let i = 0; i < 49; i += 1) signals.onHook(PTY, hook('PreToolUse', { tool_name: `t${i}` }), working, IDS, T0);
  const ended = signals.endStageRun({ ptyId: PTY, outcome: 'done', waitedMs: 0 }, T0 + 1) as { tool_counts: Record<string, number> } | undefined;
  const counts = ended?.tool_counts ?? {};
  assert.equal(Object.keys(counts).length, 51, '50 names and other');
  assert.deepEqual([Object.getOwnPropertyDescriptor(counts, '__proto__')?.value, counts.constructor, counts.toString, counts.other], [2, 1, 1, 2]);
  assert.equal(Object.getPrototypeOf(counts), Object.prototype, 'no prototype was replaced');
});

test('flush writes every wait still open as unresolved, once: a permission prompt, a takeover, an ask; a later prompt does not answer a flushed ask (#742)', () => {
  const signals = createHumanSignals();
  signals.onHook(PTY, hook('PreToolUse', { tool_name: 'Bash' }), working, IDS, T0);
  signals.onHook(PTY, hook('UserPromptSubmit'), working, IDS, T0 + 1000);
  signals.onHook(PTY, hook('Notification', { notification_type: 'permission_prompt' }), working, IDS, T0 + 2000);
  const asking: Worker = { ...working, status: 'waiting', lastEvent: { kind: 'ask' }, waitingSince: new Date(T0 + 3000).toISOString() };
  assert.deepEqual(signals.flush(PTY, asking, IDS, T0 + 10_000), [
    { event: 'permission.answered', level: 'info', ...IDS, outcome: 'unresolved', tool: 'Bash', duration_ms: 8000 },
    { event: 'run.takeover', level: 'info', ...IDS, outcome: 'unresolved', duration_ms: 9000 },
    { event: 'question.answered', level: 'info', ...IDS, kind: 'ask', outcome: 'unresolved', duration_ms: 7000 },
  ]);
  assert.deepEqual(signals.flush(PTY, asking, IDS, T0 + 11_000), [], 'once');
  assert.deepEqual(signals.onHook(PTY, hook('UserPromptSubmit'), asking, IDS, T0 + 12_000), [], 'the flushed ask is not answered twice');
  assert.deepEqual(signals.flush(PTY, working, IDS, T0 + 13_000), [], 'nor taken over');
  assert.deepEqual(signals.flush('other', undefined, IDS, T0), [], 'nothing open, nothing written');
});

test('an ask with no waitingSince flushed unresolved does not swallow a later ask that has none either (#742)', () => {
  const signals = createHumanSignals();
  const asking: Worker = { ...working, status: 'waiting', lastEvent: { kind: 'ask' } };
  assert.equal(signals.flush(PTY, asking, IDS, T0).length, 1);
  assert.deepEqual(signals.onHook(PTY, hook('UserPromptSubmit'), asking, IDS, T0 + 1000), [{ event: 'question.answered', level: 'info', ...IDS, kind: 'ask', outcome: 'answered', duration_ms: 0 }]);
});

test('tokens_by_model keeps each model name on one line and at most 50 of them, as the writer does a list (#271)', () => {
  const signals = createHumanSignals();
  signals.openStageRun({ ptyId: PTY, correlation: IDS, waitedMs: 0 }, T0);
  const tokensByModel = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`m${i}\nERROR forged`, USAGE.tokens]));
  signals.onHook(PTY, hook('Stop'), working, IDS, T0 + 1, { ...USAGE, tokensByModel });
  const ended = signals.endStageRun({ ptyId: PTY, outcome: 'done', waitedMs: 0 }, T0 + 2) as { tokens_by_model: Record<string, unknown> } | undefined;
  const names = Object.keys(ended?.tokens_by_model ?? {});
  assert.deepEqual([names.length, names[0]], [50, 'm0 ERROR forged']);
});
