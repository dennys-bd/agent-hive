import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlationOf, deriveEvents, endedStageRuns, signalRecords } from '../src/event-derive.js';
import { textRef, type RecordInput, type RunKind } from '../src/events.js';
import { renameStages } from '../src/stage-rename.js';
import { initialState } from '../src/orchestrator.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { HiveEvent, HookPayload, Item, State, Task, UsageRule, Worker } from '../src/types.js';
import { chained } from './fakes.js';
import { withWork } from './fixtures/work.js';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const PTY = '1a2b3c4d-1111-4111-8111-111111111111';
const SESSION = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const ACTIVITY = 'a-board:I1'; // withWork's id for board:I1
// dev, the last stage, ends with a move then an archive on the board source (#134: its transition to end); review has no onFinish
const STAGES: LegacyStage[] = [
  { name: 'review', from: {}, prompt: 'r' },
  { name: 'dev', from: {}, prompt: 'p', model: 'opus', onFinish: { board: [{ type: 'move', column: 'Done' }, { type: 'archive' }] } },
];
const POLL: HiveEvent = { type: 'poll', source: 'board', items: [] };
const STOP: HiveEvent = { type: 'hook', ptyId: PTY, payload: { hook_event_name: 'Stop' } };
const item = (n: number, extra: Partial<Item> = {}): Item =>
  ({ itemId: `board:I${n}`, id: String(n), title: 'SECRET-TITLE', body: 'SECRET-BODY', url: `https://github.com/acme/r/issues/${n}`, source: 'board', ...extra });
const task = (n: number, stage = 'dev', extra: Partial<Task> = {}): Task => ({ item: item(n), stage, boardColumn: 'Ready', auto: true, ...extra });
const base = (tasks: Task[] = [task(1)]): State => ({ ...initialState(1), ...chained(STAGES), tasks });
const runner = (extra: Partial<Worker> = {}): Worker => ({ id: 'w1', runId: PTY, status: 'working', activityId: ACTIVITY, startedAt: iso(NOW - 10_000), ...extra });
const only = (records: RecordInput[], event: string): RecordInput[] => records.filter((r) => r.event === event);
const field = (record: RecordInput | undefined, key: string): unknown => (record as Record<string, unknown> | undefined)?.[key];
const IDS = { task_id: 'board:I1', task: '1', activity_id: ACTIVITY, stage: 'dev' };

test('a new task is task.discovered with its source and the source\'s creation time; a task created in the Hive was created now (#742)', () => {
  const next = base([task(1, 'dev', { item: item(1, { createdAt: '2026-09-01T10:00:00Z' }) }), task(2, 'dev', { created: true, item: item(2, { source: undefined }) })]);
  assert.deepEqual(only(deriveEvents(base([]), next, POLL, NOW), 'task.discovered'), [
    { event: 'task.discovered', level: 'info', task_id: 'board:I1', task: '1', stage: 'dev', source: 'board', source_created_at: '2026-09-01T10:00:00Z' },
    { event: 'task.discovered', level: 'info', task_id: 'board:I2', task: '2', stage: 'dev', source: 'local', source_created_at: iso(NOW) },
  ]);
});

test('task.moved names who moved it: by hand, an approval, a merge, a stage\'s action ending, the source poll, else the flow (#742)', () => {
  const prev = withWork(base(), 'board:I1');
  const next = withWork(base([task(1, 'review')]), 'board:I1');
  const by = (event: HiveEvent): unknown => field(only(deriveEvents(prev, next, event, NOW), 'task.moved')[0], 'by');
  assert.deepEqual(only(deriveEvents(prev, next, { type: 'moveToStage', taskId: 'board:I1', stage: 'review' }, NOW), 'task.moved'), [
    { event: 'task.moved', level: 'info', task_id: 'board:I1', task: '1', activity_id: ACTIVITY, stage: 'review', from: 'dev', to: 'review', by: 'hand' },
  ]);
  assert.equal(by({ type: 'approve', activityId: ACTIVITY }), 'approval');
  assert.equal(by({ type: 'prStates', states: [] }), 'merge');
  assert.equal(by({ type: 'activityDeleted', activityId: ACTIVITY }), 'on_finish');
  assert.equal(by(POLL), 'source', 'the task\'s column changed in the source');
  assert.equal(by(STOP), 'auto', 'hive_done and its Stop advanced it');
});

test('a task that left is task.closed or task.deleted with finished (and the onFinish mechanism as via), missing or hand, carrying only the fields the old state still fills (#742)', () => {
  const left = (gone: Task, event: HiveEvent): RecordInput[] => deriveEvents(base([gone]), base([]), event, NOW);
  const CLOSE: HiveEvent = { type: 'closeTask', taskId: 'board:I1' };
  const closed = (stage: string, rest: Record<string, unknown>) => [{ event: 'task.closed', level: 'info', task_id: 'board:I1', task: '1', stage, ...rest }];
  assert.deepEqual(left(task(1, 'dev', { missing: true }), CLOSE), closed('dev', { reason: 'missing' }));
  assert.deepEqual(left(task(1, 'dev', { leaving: true }), CLOSE), closed('dev', { reason: 'finished', via: 'archive' }), 'its leaving action went through');
  assert.deepEqual(left(task(1), STOP), closed('dev', { reason: 'finished', via: 'move' }), 'past the last stage after an onFinish move');
  assert.deepEqual(left(task(1, 'review'), STOP), closed('review', { reason: 'finished', via: 'none' }), 'no onFinish action');
  assert.deepEqual(left(task(1, 'dev', { created: true }), STOP), closed('dev', { reason: 'finished', via: 'none' }), 'a local task: no source action');
  assert.deepEqual(left(task(1, 'dev', { created: true }), CLOSE), [{ event: 'task.deleted', level: 'info', task_id: 'board:I1', task: '1', stage: 'dev', reason: 'hand' }]);
  assert.deepEqual(left(task(1), { type: 'taskDeleted', taskId: 'board:I1' }), [{ event: 'task.deleted', level: 'info', task_id: 'board:I1', task: '1', stage: 'dev', reason: 'hand' }]);
});

test('approve, feedback, extendApproval and approvalExpired write their approval event timed from approval.since; feedback carries only its text\'s reference (#742)', () => {
  const prev = withWork({ ...base(), workers: [runner({ status: 'approval' })] }, 'board:I1', { approval: { since: iso(NOW - 60_000) }, workerId: 'w1' });
  const next = withWork(prev, 'board:I1', { workerId: 'w1' });
  const answered = (event: HiveEvent): RecordInput[] => deriveEvents(prev, next, event, NOW).filter((r) => r.event.startsWith('approval.'));
  const FEEDBACK: HiveEvent = { type: 'feedback', activityId: ACTIVITY, text: 'SECRET-FEEDBACK', start: true };
  assert.deepEqual(answered({ type: 'approve', activityId: ACTIVITY }), [{ event: 'approval.granted', level: 'info', ...IDS, duration_ms: 60_000 }]);
  assert.deepEqual(answered(FEEDBACK), [{ event: 'approval.rejected', level: 'info', ...IDS, duration_ms: 60_000, start: true, ...textRef('SECRET-FEEDBACK') }]);
  assert.deepEqual(answered({ type: 'extendApproval', activityId: ACTIVITY }), [{ event: 'approval.extended', level: 'info', ...IDS, duration_ms: 60_000 }]);
  assert.deepEqual(answered({ type: 'approvalExpired', ptyId: PTY }), [{ event: 'approval.expired', level: 'info', ...IDS, duration_ms: 60_000 }]);
  assert.ok(!JSON.stringify(deriveEvents(prev, next, FEEDBACK, NOW)).includes('SECRET'));
});

test('stage.started carries the attempt the reduce just counted and how it started: spawn, Continue, restart, queued feedback, in place (#742)', () => {
  const idle = withWork({ ...base(), workers: [{ id: 'w1', status: 'empty' }] }, 'board:I1', { sessionId: SESSION }, { stageRuns: { dev: 1 } });
  const running = (runs: number): State => withWork({ ...base(), workers: [runner()] }, 'board:I1', { sessionId: SESSION, workerId: 'w1' }, { stageRuns: { dev: runs } });
  const started = (prev: State, next: State, event: HiveEvent): RecordInput[] => only(deriveEvents(prev, next, event, NOW), 'stage.started');
  const expected = (attempt: number, run_kind: RunKind) => [{ event: 'stage.started', level: 'info', ...IDS, session_id: SESSION, attempt, run_kind }];
  assert.deepEqual(started(idle, running(2), POLL), expected(2, 'spawn'));
  assert.deepEqual(started(idle, running(2), { type: 'continue', activityId: ACTIVITY }), expected(2, 'continue'));
  assert.deepEqual(started(idle, running(2), { type: 'restart', activityId: ACTIVITY }), expected(2, 'restart'));
  const queued = withWork(idle, 'board:I1', { sessionId: SESSION, handover: { prompt: 'SECRET-FEEDBACK' } }, { stageRuns: { dev: 1 } });
  assert.deepEqual(started(queued, running(2), POLL), expected(2, 'feedback'));
  assert.deepEqual(started(running(2), running(3), { type: 'feedback', activityId: ACTIVITY, text: 'x', start: true }), expected(3, 'feedback'));
  assert.deepEqual(started(running(2), running(3), STOP), expected(3, 'continue'));
});

test('run.spawned names the worker and the stage\'s model, run.started the spawn latency, run.exited and run.stopped the run\'s time, run.restarted the time since the stop; a failed spawn writes its first line with paths masked (#742)', () => {
  const idle = withWork({ ...base(), workers: [{ id: 'w1', status: 'empty' }] }, 'board:I1');
  const busy = withWork({ ...base(), workers: [runner()] }, 'board:I1', { workerId: 'w1' });
  assert.deepEqual(only(deriveEvents(idle, busy, POLL, NOW), 'run.spawned'), [{ event: 'run.spawned', level: 'info', ...IDS, worker: 1, model: 'opus' }]);
  const seen = withWork({ ...base(), workers: [runner({ sessionId: SESSION })] }, 'board:I1', { workerId: 'w1' });
  assert.deepEqual(only(deriveEvents(busy, seen, { type: 'hook', ptyId: PTY, payload: { hook_event_name: 'SessionStart' } }, NOW), 'run.started'),
    [{ event: 'run.started', level: 'info', ...IDS, session_id: SESSION, spawn_latency_ms: 10_000 }]);
  assert.deepEqual(only(deriveEvents(busy, idle, { type: 'exit', ptyId: PTY }, NOW), 'run.exited'), [{ event: 'run.exited', level: 'info', ...IDS, duration_ms: 10_000 }]);
  const failed: HiveEvent = { type: 'spawnFailed', ptyId: PTY, message: "fatal: '/tmp/r/.hive/worktrees/hive-1' already exists\nsetup output with TOKEN=x" };
  assert.deepEqual(only(deriveEvents(busy, idle, failed, NOW), 'run.spawn_failed'), [{ event: 'run.spawn_failed', level: 'error', ...IDS, code: 'git_failed' }]);
  const stopped = withWork(busy, 'board:I1', { workerId: 'w1', stopped: true });
  assert.deepEqual(only(deriveEvents(busy, stopped, { type: 'stop', ptyId: PTY, cause: 'manual' }, NOW), 'run.stopped'), [{ event: 'run.stopped', level: 'info', ...IDS, duration_ms: 10_000 }]);
  assert.deepEqual(only(deriveEvents(busy, stopped, { type: 'stop', ptyId: PTY }, NOW), 'run.stopped'), [], 'hive_stop or a timeout: not the user\'s');
  const parked = withWork(idle, 'board:I1', { stopped: true, stoppedAt: iso(NOW - 300_000) });
  assert.deepEqual(only(deriveEvents(parked, idle, { type: 'restart', activityId: ACTIVITY }, NOW), 'run.restarted'), [{ event: 'run.restarted', level: 'info', ...IDS, duration_ms: 300_000 }]);
});

test('workers.changed when the cap-counted runs or the cap move; signal.changed names the rule when the floor moved it (#742)', () => {
  const prev: State = { ...base(), workers: [{ id: 'w1', status: 'empty' }] };
  const next = withWork({ ...prev, workers: [runner()] }, 'board:I1', { workerId: 'w1' });
  assert.deepEqual(only(deriveEvents(prev, next, POLL, NOW), 'workers.changed'), [{ event: 'workers.changed', level: 'info', active: 1, max: 1 }]);
  assert.deepEqual(deriveEvents(prev, { ...prev, maxConcurrent: 3 }, { type: 'setMax', max: 3 }, NOW), [{ event: 'workers.changed', level: 'info', active: 0, max: 3 }]);
  assert.deepEqual(only(deriveEvents(prev, { ...prev, signal: 'red' }, { type: 'setSignal', signal: 'red' }, NOW), 'signal.changed'), [], 'the server compares against the last signal it wrote');
});

test('signalRecords: the first reduction writes the signal, then only a change from the last one written, time-driven too; the rule only when exactly one tripped (#742)', () => {
  const prev: State = { ...base(), workers: [{ id: 'w1', status: 'empty' }] };
  assert.deepEqual(signalRecords(undefined, prev, prev, NOW), { signal: 'green', records: [{ event: 'signal.changed', level: 'info', from: 'green', to: 'green' }] });
  assert.deepEqual(signalRecords('green', prev, prev, NOW), { signal: 'green', records: [] });
  assert.deepEqual(signalRecords('green', prev, { ...prev, signal: 'red' }, NOW).records, [{ event: 'signal.changed', level: 'info', from: 'green', to: 'red' }]);
  const rules: UsageRule[] = [{ source: 'hour', percent: 80, signal: 'red' }];
  const spent: State = { ...prev, budget: { maxTokensPerHour: 100 }, usageRules: rules, usage: [{ at: iso(NOW - 1000), tokens: 90 }] };
  assert.deepEqual(signalRecords('green', spent, spent, NOW).records, [{ event: 'signal.changed', level: 'info', from: 'green', to: 'red', rule: 'hour≥80', usage_percent: 90 }], 'the same state, a later clock: still caught');
  assert.deepEqual(signalRecords('red', spent, spent, NOW + 3_600_000).records, [{ event: 'signal.changed', level: 'info', from: 'red', to: 'green' }], 'the hour went by');
  const two: State = { ...spent, usageRules: [...rules, { source: 'hour', percent: 70, signal: 'red' }] };
  assert.deepEqual(signalRecords('green', two, two, NOW).records, [{ event: 'signal.changed', level: 'info', from: 'green', to: 'red' }], 'two rules tripped: none named');
});

test('pr.opened when a record gains a PR; pr.state when the poll reads it merged, timed from its opening and from the stage entry (#742)', () => {
  const url = 'https://github.com/acme/r/pull/9';
  const entered = base([task(1, 'dev', { enteredAt: iso(NOW - 7_200_000) })]);
  const none = withWork(entered, 'board:I1');
  const open = withWork(entered, 'board:I1', {}, { prs: [{ url, state: 'open', openedAt: iso(NOW - 3_600_000) }] });
  assert.deepEqual(deriveEvents(none, open, { type: 'pr', ptyId: PTY, url }, NOW), [{ event: 'pr.opened', level: 'info', ...IDS, pr: 9 }]);
  const merged = withWork(entered, 'board:I1', {}, { prs: [{ url, state: 'merged', openedAt: iso(NOW - 3_600_000), mergedAt: iso(NOW) }] });
  assert.deepEqual(deriveEvents(open, merged, { type: 'prStates', states: [] }, NOW),
    [{ event: 'pr.state', level: 'info', ...IDS, pr: 9, state: 'merged', since_opened_ms: 3_600_000, since_stage_started_ms: 7_200_000 }]);
});

test('a boot that sets the crash notice writes hive.crash_recovered with the runs it found dead, and no run.exited each; correlationOf leaves out what does not apply (#742)', () => {
  const dead = withWork({ ...base(), workers: [runner()] }, 'board:I1', { workerId: 'w1' });
  const booted: State = { ...withWork({ ...base(), workers: [{ id: 'w1', status: 'empty' }] }, 'board:I1', { stopped: true }), crash: { at: iso(NOW), tasks: ['board:I1'] } };
  const records = deriveEvents(dead, booted, { type: 'boot' }, NOW);
  assert.deepEqual(only(records, 'hive.crash_recovered'), [{ event: 'hive.crash_recovered', level: 'error', workers: 1 }]);
  assert.deepEqual(only(records, 'run.exited'), []);
  assert.deepEqual(deriveEvents(booted, booted, { type: 'boot' }, NOW), [], 'the same state: nothing');
  const free = withWork({ ...base(), workers: [runner({ freeSession: true })] }, 'board:I1', { sessionId: SESSION }, { stageRuns: { dev: 2 } });
  assert.deepEqual(correlationOf(free, free.workers[0]), { task_id: 'board:I1', task: '1', activity_id: ACTIVITY }, 'a free session: no stage, no attempt, not the stage run\'s session');
  const stage = withWork({ ...base(), workers: [runner()] }, 'board:I1', { sessionId: SESSION }, { stageRuns: { dev: 2 } });
  assert.deepEqual(correlationOf(stage, stage.workers[0]), { ...IDS, session_id: SESSION, attempt: 2 });
});

test('every record that carries task_id also carries task, the visible id the user knows the task by (#742)', () => {
  const prev = withWork({ ...base(), workers: [runner()] }, 'board:I1');
  const next = withWork({ ...base([task(1, 'review')]), workers: [] }, 'board:I1');
  const records = deriveEvents(prev, next, { type: 'moveToStage', taskId: 'board:I1', stage: 'review' }, NOW);
  assert.ok(records.some((r) => field(r, 'task_id') !== undefined));
  assert.deepEqual(records.filter((r) => field(r, 'task_id') !== undefined && field(r, 'task') !== '1'), []);
});

test('a terminal that leaves the state is terminal.ended, timed from its open, with its Command\'s name only; a workspace\'s has only its activity; a boot writes none (#742)', () => {
  const shell = { terminalId: 't1', activityId: ACTIVITY, startedAt: iso(NOW - 4000), command: 'dev server', cwd: 'wt' };
  const local = { terminalId: 't2', activityId: 'local:ws', startedAt: iso(NOW - 1000), cwd: 'ws' };
  const prev: State = { ...withWork(base(), 'board:I1'), terminals: [shell, local] };
  const next: State = { ...prev, terminals: [] };
  assert.deepEqual(only(deriveEvents(prev, next, { type: 'tick' }, NOW), 'terminal.ended'), [
    { event: 'terminal.ended', level: 'info', task_id: 'board:I1', task: '1', activity_id: ACTIVITY, duration_ms: 4000, command: 'dev server' },
    { event: 'terminal.ended', level: 'info', activity_id: 'local:ws', duration_ms: 1000 },
  ]);
  assert.deepEqual(only(deriveEvents(prev, next, { type: 'boot' }, NOW), 'terminal.ended'), [], 'it died with the Hive');
});

test('endedStageRuns: done or approval at the Stop after hive_done, stop by hand, failed, killed on quit or a dropped task, exit otherwise; a held run already ended (#742)', () => {
  const run = runner({ done: true });
  const prev = withWork({ ...base(), workers: [run] }, 'board:I1', { workerId: 'w1' });
  const freed = withWork({ ...base(), workers: [{ id: 'w1', status: 'empty' }] }, 'board:I1');
  const ended = (from: State, to: State, event: HiveEvent): string[] => endedStageRuns(from, to, event, NOW).map((e) => e.outcome);
  assert.deepEqual(ended(prev, freed, STOP), ['done']);
  const held = withWork({ ...base(), workers: [{ ...run, status: 'approval' }] }, 'board:I1', { workerId: 'w1', approval: { since: iso(NOW) } });
  assert.deepEqual(ended(prev, held, STOP), ['approval']);
  const working = withWork({ ...base(), workers: [runner()] }, 'board:I1', { workerId: 'w1' });
  assert.deepEqual(ended(working, withWork(working, 'board:I1', { workerId: 'w1', stopped: true }), { type: 'stop', ptyId: PTY, cause: 'manual' }), ['stop']);
  assert.deepEqual(ended(working, withWork(working, 'board:I1', { workerId: 'w1', stopped: true }), { type: 'stop', ptyId: PTY }), ['agent_stop'], 'hive_stop or a timeout');
  assert.deepEqual(ended(working, freed, { type: 'spawnFailed', ptyId: PTY, message: 'x' }), ['failed']);
  assert.deepEqual(ended(working, { ...working, cleanStop: true }, { type: 'quit' }), ['killed']);
  assert.deepEqual(ended(working, { ...freed, tasks: [] }, { type: 'closeTask', taskId: 'board:I1' }), ['killed']);
  assert.deepEqual(ended(working, freed, { type: 'exit', ptyId: PTY }), ['exit']);
  assert.deepEqual(ended(held, freed, { type: 'exit', ptyId: PTY }), []);
  assert.deepEqual(endedStageRuns(working, freed, { type: 'exit', ptyId: PTY }, NOW)[0], { ptyId: PTY, outcome: 'exit', waitedMs: 0 });
});

test('a StopFailure is run.api_error at warn: a backoff with its failure number and wait, a plan-reset wait with no failure, a stop after the third retry or at once, never the payload\'s details or message; after hive_done it is the run\'s Stop (#805)', () => {
  const LIMITS = { at: iso(NOW), windows: { five_hour: { usedPercent: 100, resetsAt: iso(NOW + 3_600_000) } } };
  const FAILURE: HiveEvent = { type: 'hook', ptyId: PTY, payload: { hook_event_name: 'StopFailure', error: 'overloaded', error_details: 'SECRET-DETAILS', last_assistant_message: 'SECRET-MESSAGE' } as HookPayload };
  const prevOf = (worker: Worker, extra: Partial<State> = {}): State => withWork({ ...base(), ...extra, workers: [worker] }, 'board:I1', { workerId: 'w1' });
  const failed = (error: string, worker: Worker = runner(), extra: Partial<State> = {}): RecordInput[] => {
    const prev = prevOf(worker, extra);
    const payload = { hook_event_name: 'StopFailure', error, error_details: 'SECRET-DETAILS', last_assistant_message: 'SECRET-MESSAGE' } as HookPayload;
    return only(deriveEvents(prev, { ...prev, workers: [] }, { type: 'hook', ptyId: PTY, payload }, NOW), 'run.api_error');
  };
  const record = (fields: Record<string, unknown>): Record<string, unknown>[] => [{ event: 'run.api_error', level: 'warn', ...IDS, ...fields }];
  assert.deepEqual(failed('overloaded'), record({ error: 'overloaded', action: 'backoff', failure: 1, wait_ms: 60_000 }));
  assert.deepEqual(failed('server_error', runner({ apiErrors: 2 })), record({ error: 'server_error', action: 'backoff', failure: 3, wait_ms: 240_000 }));
  assert.deepEqual(failed('overloaded', runner({ apiErrors: 3 })), record({ error: 'overloaded', action: 'stopped', failure: 4 }));
  assert.deepEqual(failed('authentication_failed'), record({ error: 'authentication_failed', action: 'stopped' }));
  assert.deepEqual(failed('rate_limit', runner(), { rateLimits: { claude: LIMITS } }), record({ error: 'rate_limit', action: 'backoff', wait_ms: 3_660_000 }));
  assert.doesNotMatch(JSON.stringify(failed('overloaded')), /SECRET/, 'never the details nor the message');
  assert.deepEqual(only(deriveEvents(base(), { ...base(), workers: [] }, STOP, NOW), 'run.api_error'), [], 'a plain Stop is no API error');
  assert.deepEqual(failed('overloaded', runner({ done: true })), [], 'after hive_done it is the run\'s Stop, not an API error');
  const done = prevOf(runner({ done: true }));
  assert.deepEqual(endedStageRuns(done, { ...done, workers: [] }, FAILURE, NOW).map((end) => end.outcome), ['done'], 'and its stage ends done');
});

test('a start a dirty local checkout refused is run.spawn_failed code=checkout_dirty: no path, no porcelain line, no message field (#945)', () => {
  const idle = withWork({ ...base(), workers: [{ id: 'w1', status: 'empty' }] }, 'board:I1');
  const busy = withWork({ ...base(), workers: [runner()] }, 'board:I1', { workerId: 'w1' });
  const refused: HiveEvent = { type: 'spawnFailed', ptyId: PTY, message: '/repo has changes that are not committed:\n M src/app.ts\n?? notes.md' };
  assert.deepEqual(only(deriveEvents(busy, idle, refused, NOW), 'run.spawn_failed'), [{ event: 'run.spawn_failed', level: 'error', ...IDS, code: 'checkout_dirty' }]);
});

test('renameStages derives no task.moved and no stage.started: a rename moves nothing and starts nothing (#861)', () => {
  const prev = withWork({ ...base(), workers: [runner()] }, 'board:I1', { workerId: 'w1' }, { stageRuns: { dev: 1 } });
  const event: HiveEvent = { type: 'renameStages', renames: { dev: 'build' } };
  assert.deepEqual(deriveEvents(prev, renameStages(prev, event.renames), event, NOW), []);
});
