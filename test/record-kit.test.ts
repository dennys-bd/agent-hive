import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prsOf } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import { liveRecord, taskTotals, withPr, withRun, withTurn } from '../src/record-kit.js';
import type { AgentId, State, Task, TaskUsage, UsagePart, Worker } from '../src/types.js';
import { activityIdOf, withWork } from './fixtures/work.js';

const URL = 'https://github.com/o/r/pull/7';
const TASK: Task = { item: { itemId: 'item1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const live = withWork({ ...initialState(0), tasks: [TASK] }, 'item1');

test('withPr stores the reporting session on a new PR; a later report of the url keeps the first session and still takes the slice; a report without one leaves it absent (#62)', () => {
  const opened = withPr(live, TASK, URL, undefined, 'session-a');
  assert.deepEqual(prsOf(opened, 'item1'), [{ url: URL, state: 'open', sessionId: 'session-a' }]);
  const sliced = withPr(opened, TASK, URL, { k: 2, type: 'stacked' }, 'session-b');
  assert.deepEqual(prsOf(sliced, 'item1'), [{ url: URL, state: 'open', sessionId: 'session-a', slice: { k: 2, type: 'stacked' } }], 'the first report\'s session stays');
  assert.equal(liveRecord(withPr(opened, TASK, URL, undefined, 'session-b'), TASK), liveRecord(opened, TASK), 'no slice and a known url: the same record');
  assert.deepEqual(prsOf(withPr(live, TASK, URL), 'item1'), [{ url: URL, state: 'open' }], 'no session: no key');
});

// #617: a task's usage split per stage and agent
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const MINUTE = 60_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const run = (changes: Partial<Worker> = {}): Worker => ({ id: 'w1', runId: 'r1', status: 'working', activityId: activityIdOf('item1'), ...changes });
const usage = (state: State): TaskUsage | undefined => liveRecord(state, TASK)?.usage;
const part = (stage: string | undefined, agent: AgentId | undefined, tokens: number, ms = 0, waitingMs = 0): UsagePart =>
  ({ ...(stage === undefined ? {} : { stage }), ...(agent === undefined ? {} : { agent }), tokens, ms, waitingMs });

test('withTurn adds the delta to the total and to the part of the stage and agent the worker runs: a new pair appends a part, a stage visited again adds to its own, another agent on the same stage is a part of its own (#617)', () => {
  const spec = run({ stage: 'spec', agent: 'claude' });
  const back = withTurn(withTurn(withTurn(live, TASK, spec, 1000, 1000), TASK, run({ stage: 'dev', agent: 'claude' }), 1500, 500), TASK, spec, 1700, 200);
  assert.deepEqual(usage(back), { tokens: 1700, ms: 0, waitingMs: 0, parts: [part('spec', 'claude', 1200), part('dev', 'claude', 500)] });
  const other = withTurn(back, TASK, run({ stage: 'spec', agent: 'codex' }), 100, 100);
  assert.deepEqual(usage(other)?.parts.map((p) => [p.stage, p.agent]), [['spec', 'claude'], ['dev', 'claude'], ['spec', 'codex']]);
});

test('withRun folds a run\'s time, its waiting included, into its stage and agent\'s part; a free session counts with no stage; a commands stage\'s run counts time with no agent (#617)', () => {
  const ran = run({ stage: 'dev', agent: 'claude', startedAt: ago(30 * MINUTE), waitedMs: 5 * MINUTE });
  assert.deepEqual(usage(withRun(live, TASK, ran, NOW)), { tokens: 0, ms: 30 * MINUTE, waitingMs: 5 * MINUTE, parts: [part('dev', 'claude', 0, 30 * MINUTE, 5 * MINUTE)] });
  const free = run({ agent: 'claude', freeSession: true, startedAt: ago(10 * MINUTE) });
  assert.deepEqual(usage(withRun(live, TASK, free, NOW))?.parts, [part(undefined, 'claude', 0, 10 * MINUTE)]);
  const commands = run({ stage: 'checks', startedAt: ago(2 * MINUTE) });
  assert.deepEqual(usage(withRun(live, TASK, commands, NOW))?.parts, [part('checks', undefined, 0, 2 * MINUTE)]);
});

test('withRun counts only what the run ran since its last fold: the time a continuation already left on another stage is not counted again (#617)', () => {
  const continued = run({ stage: 'dev', agent: 'claude', startedAt: ago(30 * MINUTE), waitedMs: 5 * MINUTE, foldedMs: 20 * MINUTE, foldedWaitingMs: 4 * MINUTE });
  assert.deepEqual(usage(withRun(live, TASK, continued, NOW))?.parts, [part('dev', 'claude', 0, 10 * MINUTE, MINUTE)]);
});

test('taskTotals adds each running worker\'s time since its last fold to its part as well as to the total (#617)', () => {
  const recorded = withWork({ ...initialState(0), tasks: [TASK] }, 'item1', {}, { usage: { tokens: 1000, ms: 10 * MINUTE, waitingMs: 0, parts: [part('spec', 'claude', 1000, 10 * MINUTE)] } });
  const workers = [run({ stage: 'dev', agent: 'claude', startedAt: ago(30 * MINUTE), foldedMs: 10 * MINUTE })];
  assert.deepEqual(taskTotals({ ...recorded, workers }, TASK, NOW), {
    tokens: 1000, ms: 30 * MINUTE, waitingMs: 0, parts: [part('spec', 'claude', 1000, 10 * MINUTE), part('dev', 'claude', 0, 20 * MINUTE)],
  });
});
