import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, describeChanges, describeEffect, describeEvent, LOG_FILE, MESSAGE_MAX, shortId } from '../src/log.js';
import { initialState } from '../src/orchestrator.js';
import type { Slot, State, Task } from '../src/types.js';

const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (ERROR|INFO |DEBUG) /;
const ISO_WIDTH = 25; // "2026-09-17T12:00:00.000Z " — what precedes the level tag
const quiet = (): void => {};
const WORKER = '1a2b3c4d-1111-4111-8111-111111111111';
const SLOT = '9f8e7d6c-2222-4222-8222-222222222222';
const task = (id: string): Task => ({ itemId: `I${id}`, id, title: 'Logs', body: 'the body is never logged', url: `https://github.com/acme/r/issues/${id}` });

async function logDir(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'hive-log-')), '.hive'); // does not exist yet: the logger creates it
}

const tail = (dir: string, file = LOG_FILE): string[] =>
  readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => l.slice(ISO_WIDTH));

function stderrSpy(): { calls: string[]; stderr: (line: string) => void } {
  const calls: string[] = [];
  return { calls, stderr: (line) => { calls.push(line); } };
}

test('createLogger creates .hive/ and hive.log and writes one `<ISO> <LEVEL> <message>` line per call', async () => {
  const dir = await logDir();
  assert.equal(existsSync(dir), false);
  const log = createLogger(dir, 'info', { stderr: quiet });
  assert.equal(existsSync(dir), true, 'the directory is created on construction (setup mode has no prepareHiveDir yet)');
  log.info('poll queue=3');
  const raw = readFileSync(join(dir, LOG_FILE), 'utf8');
  assert.match(raw, LINE);
  assert.equal(raw.slice(ISO_WIDTH), 'INFO  poll queue=3\n');
});

test('info is written and debug dropped at level info; setLevel(debug) starts writing debug', async () => {
  const dir = await logDir();
  const log = createLogger(dir, 'info', { stderr: quiet });
  log.debug('hook PreToolUse worker=1a2b3c4d tool=Bash');
  log.info('boot');
  log.setLevel('debug');
  log.debug('hook PostToolUse worker=1a2b3c4d tool=Bash');
  assert.deepEqual(tail(dir), ['INFO  boot', 'DEBUG hook PostToolUse worker=1a2b3c4d tool=Bash']);
  assert.deepEqual(tail(dir), tail(dir)); // reading is stable: sync writes leave no pending data
});

test('error goes to the injected stderr and to the file, whatever the level', async () => {
  const dir = await logDir();
  const { calls, stderr } = stderrSpy();
  const log = createLogger(dir, 'info', { stderr });
  log.error('board.listQueue: gh project item-list: rate limited');
  assert.deepEqual(calls, ['board.listQueue: gh project item-list: rate limited']);
  assert.deepEqual(tail(dir), ['ERROR board.listQueue: gh project item-list: rate limited']);
});

test('past maxBytes the file becomes hive.log.1 (replacing the previous one) and a new hive.log starts; a new logger picks up the existing size', async () => {
  const dir = await logDir();
  // one line is 32 bytes + the message: "first" 37, "second" 38, "third" 37 …
  const log = createLogger(dir, 'info', { maxBytes: 100, stderr: quiet });
  log.info('first');
  log.info('second'); // 75 bytes so far
  log.info('third'); // 112 > 100: rotate before writing
  assert.deepEqual(tail(dir), ['INFO  third']);
  assert.deepEqual(tail(dir, `${LOG_FILE}.1`), ['INFO  first', 'INFO  second']);
  log.info('fourth'); // 75
  log.info('fifth'); // 112: rotate again, the old hive.log.1 is replaced
  assert.deepEqual(tail(dir), ['INFO  fifth']);
  assert.deepEqual(tail(dir, `${LOG_FILE}.1`), ['INFO  third', 'INFO  fourth']);
  const again = createLogger(dir, 'info', { maxBytes: 100, stderr: quiet }); // 37 bytes already on disk
  again.info('sixth'); // 74
  again.info('seventh'); // 113: rotates only because the size was read from the file
  assert.deepEqual(tail(dir), ['INFO  seventh']);
  assert.deepEqual(tail(dir, `${LOG_FILE}.1`), ['INFO  fifth', 'INFO  sixth']);
});

test('a write failure prints once on stderr, disables the file and never throws; error still reaches stderr', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'hive-log-')), '.hive');
  await writeFile(dir, 'not a directory'); // mkdir / append fail with EEXIST / ENOTDIR
  const { calls, stderr } = stderrSpy();
  const log = createLogger(dir, 'debug', { stderr });
  log.info('one');
  log.debug('two');
  log.info('three');
  assert.equal(calls.length, 1, 'one complaint, then silence');
  assert.match(calls[0], /^hive\.log: /);
  log.error('board.listQueue: boom');
  assert.deepEqual(calls.slice(1), ['board.listQueue: boom']);
  assert.equal(readFileSync(dir, 'utf8'), 'not a directory', 'the Hive kept running and touched nothing');
});

test('shortId keeps the first 8 characters and shows - for a missing id', () => {
  assert.equal(shortId(WORKER), '1a2b3c4d');
  assert.equal(shortId(undefined), '-');
  assert.equal(shortId('abc'), 'abc');
});

test('describeEvent names the hook, worker and tool but never the tool_input, the response or the message', () => {
  const hook = describeEvent({
    type: 'hook', workerId: WORKER,
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: 'https://github.com/acme/r/pull/9' },
  });
  assert.equal(hook, 'hook PostToolUse worker=1a2b3c4d tool=Bash');
  const notification = describeEvent({
    type: 'hook', workerId: WORKER, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to run rm' },
  });
  assert.equal(notification, 'hook Notification worker=1a2b3c4d');
});

test('describeEvent summarises every other event with names, ids and counts only', () => {
  assert.equal(describeEvent({ type: 'boot' }), 'boot');
  assert.equal(describeEvent({ type: 'poll', tasks: [task('1'), task('2')] }), 'poll tasks=2 ids=1,2');
  const ids = Array.from({ length: 25 }, (_, i) => String(i + 1));
  assert.equal(describeEvent({ type: 'poll', tasks: ids.map(task) }), `poll tasks=25 ids=${ids.slice(0, 20).join(',')}`);
  assert.equal(describeEvent({ type: 'exit', workerId: WORKER }), 'exit worker=1a2b3c4d');
  assert.equal(describeEvent({ type: 'kill', slotId: SLOT }), 'kill slot=9f8e7d6c');
  assert.equal(describeEvent({ type: 'setSignal', signal: 'red' }), 'setSignal red');
  assert.equal(describeEvent({ type: 'setMax', max: 3 }), 'setMax 3');
  assert.equal(describeEvent({ type: 'setBudget', budget: { maxTokensPerHour: 10 } }), 'setBudget {"maxTokensPerHour":10}');
  assert.equal(describeEvent({ type: 'setUsageRules', usageRules: [{ percent: 80, signal: 'yellow' }] }), 'setUsageRules rules=1');
  assert.equal(describeEvent({ type: 'rateLimits', workerId: WORKER, rateLimits: { at: '2026-09-17T12:00:00.000Z', windows: {} } }), 'rateLimits worker=1a2b3c4d');
  assert.equal(describeEvent({ type: 'rateLimits', rateLimits: { at: '2026-09-17T12:00:00.000Z', windows: {} } }), 'rateLimits source=hive');
  assert.equal(
    describeEvent({ type: 'boardQuota', quota: { limit: 5000, remaining: 4320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' } }),
    'boardQuota remaining=4320/5000 resetsAt=2026-09-16T13:00:00.000Z',
  );
  assert.equal(describeEvent({ type: 'error', message: 'board.listQueue: boom' }), 'error board.listQueue: boom');
  assert.equal(describeEvent({ type: 'error' }), 'error');
});

test('describeEffect: spawn, setStatus and kill', () => {
  const slot: Slot = { id: SLOT, workerId: WORKER, status: 'trabalhando', task: task('30'), slug: 'hive-30-logs' };
  assert.equal(describeEffect({ type: 'spawn', slot }), 'spawn slot=9f8e7d6c #30 slug=hive-30-logs worker=1a2b3c4d');
  assert.equal(describeEffect({ type: 'setStatus', itemId: 'PVTI_1', key: 'review' }), 'setStatus #PVTI_1 → review');
  assert.equal(describeEffect({ type: 'kill', slug: 'hive-30-logs', workerId: WORKER }), 'kill slug=hive-30-logs worker=1a2b3c4d');
});

test('describeChanges lists each slot whose status changed (position in the grid, matched by id) and the signal change; [] when nothing moved', () => {
  const empty: Slot = { id: SLOT, status: 'vazio' };
  const other: Slot = { id: 'b0b0b0b0-3333-4333-8333-333333333333', status: 'vazio' };
  const working: Slot = { ...empty, workerId: WORKER, status: 'trabalhando', task: task('30'), slug: 'hive-30-logs' };
  const prev: State = { ...initialState(0), signal: 'yellow', slots: [empty, other] };
  const next: State = { ...prev, signal: 'green', slots: [working, other] };
  assert.deepEqual(describeChanges(prev, next), ['slot 1: vazio → trabalhando #30 worker=1a2b3c4d', 'signal: yellow → green']);
  const reviewed: State = { ...next, slots: [{ ...working, status: 'aguardando_review', prUrl: 'https://github.com/acme/r/pull/9' }, other] };
  assert.deepEqual(describeChanges(next, reviewed), ['slot 1: trabalhando → aguardando_review #30 worker=1a2b3c4d']);
  const freed: State = { ...reviewed, slots: [empty, other] };
  assert.deepEqual(describeChanges(reviewed, freed), ['slot 1: aguardando_review → vazio #30 worker=1a2b3c4d'], 'an emptied slot names what it held');
  assert.deepEqual(describeChanges(next, { ...next, queue: [task('1')], lastPolledAt: '2026-09-17T12:00:00.000Z' }), []);
  assert.deepEqual(describeChanges(next, { ...next, slots: [working, other, { id: 'c0c0c0c0-4444-4444-8444-444444444444', status: 'vazio' }] }), [], 'a slot added by setMax is not a transition');
});

test('a message with line breaks stays one log line, and an oversized one is cut: the file is always grep-able', async () => {
  const dir = await logDir();
  const log = createLogger(dir, 'info', { stderr: quiet });
  log.error('board.listQueue: gh api graphql: line one\nline two\r\nERROR forged'); // gh stderr, or a hook_event_name from any local process
  log.info(`x${'y'.repeat(MESSAGE_MAX + 100)}`);
  const lines = tail(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'ERROR board.listQueue: gh api graphql: line one line two ERROR forged');
  assert.equal(lines[1].length, 'INFO  '.length + MESSAGE_MAX);
});
