import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, describeChanges, describeEffect, describeEvent, LOG_FILE, MESSAGE_MAX, shortId } from '../src/log.js';
import { initialState } from '../src/orchestrator.js';
import type { Card, Column, Slot, State, Task } from '../src/types.js';

const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (ERROR|INFO |DEBUG) /;
const ISO_WIDTH = 25; // "2026-09-17T12:00:00.000Z " — what precedes the level tag
const quiet = (): void => {};
const WORKER = '1a2b3c4d-1111-4111-8111-111111111111';
const SLOT = '9f8e7d6c-2222-4222-8222-222222222222';
const task = (id: string): Task => ({ itemId: `I${id}`, id, title: 'Logs', body: 'the body is never logged', url: `https://github.com/acme/r/issues/${id}` });
const cardFor = (id: string): Card => ({ task: task(id), column: 'dev', boardColumn: 'Ready', slug: `hive-${id}-logs` });

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
  assert.equal(describeEvent({ type: 'poll', cards: [task('1'), task('2')].map((t) => ({ task: t, column: 'Ready' })) }), 'poll cards=2 ids=1,2');
  const ids = Array.from({ length: 25 }, (_, i) => String(i + 1));
  assert.equal(describeEvent({ type: 'poll', cards: ids.map((id) => ({ task: task(id), column: 'Ready' })) }), `poll cards=25 ids=${ids.slice(0, 20).join(',')}`);
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
  assert.equal(describeEvent({ type: 'start', itemId: 'PVTI_1' }), 'start #PVTI_1 raiseMax=false');
  assert.equal(describeEvent({ type: 'start', itemId: 'PVTI_1', raiseMax: true }), 'start #PVTI_1 raiseMax=true');
  assert.equal(describeEvent({ type: 'closeCard', cardId: 'PVTI_1' }), 'closeCard #PVTI_1');
  assert.equal(describeEvent({ type: 'keepCard', cardId: 'PVTI_1' }), 'keepCard #PVTI_1');
  assert.equal(describeEvent({ type: 'done', workerId: WORKER }), 'done worker=1a2b3c4d');
  assert.equal(describeEvent({ type: 'spawnFailed', workerId: WORKER, message: 'tmux: duplicate session: hive-30-logs' }), 'spawnFailed worker=1a2b3c4d tmux: duplicate session: hive-30-logs');
  assert.equal(describeEvent({ type: 'setColumns', columns: [{ name: 'a', weight: 2, from: [] }, { name: 'b', weight: 0, from: [] }] }), 'setColumns a(2)>b(0)');
});

test('describeEffect: spawn, setColumn, kill and continue', () => {
  const slot: Slot = { id: SLOT, workerId: WORKER, status: 'working', cardId: 'I30' };
  const column: Column = { name: 'dev', weight: 1, from: ['Ready'], prompt: 'x' };
  assert.equal(describeEffect({ type: 'spawn', slot, card: cardFor('30'), column, session: 'new' }), 'spawn slot=9f8e7d6c #30 slug=hive-30-logs column=dev session=new worker=1a2b3c4d');
  assert.equal(describeEffect({ type: 'setColumn', itemId: 'PVTI_1', column: 'In review' }), 'setColumn #PVTI_1 → In review');
  assert.equal(describeEffect({ type: 'kill', slug: 'hive-30-logs', workerId: WORKER }), 'kill slug=hive-30-logs worker=1a2b3c4d');
  assert.equal(describeEffect({ type: 'continue', workerId: WORKER, card: cardFor('30'), column }), 'continue column=dev worker=1a2b3c4d');
});

test('describeChanges lists each slot whose status changed (position in the grid, matched by id) and the signal change; [] when nothing moved', () => {
  const empty: Slot = { id: SLOT, status: 'empty' };
  const other: Slot = { id: 'b0b0b0b0-3333-4333-8333-333333333333', status: 'empty' };
  const working: Slot = { ...empty, workerId: WORKER, status: 'working', cardId: 'I30' };
  const prev: State = { ...initialState(0), signal: 'yellow', slots: [empty, other], cards: [cardFor('30')] };
  const next: State = { ...prev, signal: 'green', slots: [working, other] };
  assert.deepEqual(describeChanges(prev, next), ['slot 1: empty → working #30 worker=1a2b3c4d', 'signal: yellow → green']);
  const reviewed: State = { ...next, slots: [{ ...working, status: 'review' }, other] };
  assert.deepEqual(describeChanges(next, reviewed), ['slot 1: working → review #30 worker=1a2b3c4d']);
  const freed: State = { ...reviewed, slots: [empty, other] };
  assert.deepEqual(describeChanges(reviewed, freed), ['slot 1: review → empty #30 worker=1a2b3c4d'], 'an emptied slot names what it held');
  assert.deepEqual(describeChanges(next, { ...next, cards: [cardFor('30'), cardFor('1')], lastPolledAt: '2026-09-17T12:00:00.000Z' }), []);
  assert.deepEqual(describeChanges(next, { ...next, slots: [working, other, { id: 'c0c0c0c0-4444-4444-8444-444444444444', status: 'empty' }] }), [], 'a slot added by setMax is not a transition');
  const added: Slot = { ...working, id: 'c0c0c0c0-4444-4444-8444-444444444444' };
  assert.deepEqual(describeChanges(next, { ...next, slots: [working, other, added] }), ['slot 3: empty → working #30 worker=1a2b3c4d'], 'a slot that appears already occupied (start with raiseMax) is a transition');
});

test('describeChanges emits the session line once, when the id appears, after the status lines and before the signal', () => {
  const session = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const empty: Slot = { id: SLOT, status: 'empty' };
  const working: Slot = { ...empty, workerId: WORKER, status: 'working', cardId: 'I29' };
  const prev: State = { ...initialState(0), signal: 'yellow', slots: [working], cards: [cardFor('29')] };
  const started: State = { ...prev, slots: [{ ...working, sessionId: session }] };
  assert.deepEqual(describeChanges(prev, started), [`slot 1: session=${session} #29 worker=1a2b3c4d`]);
  const later: State = { ...started, slots: [{ ...started.slots[0], lastEvent: { kind: 'tool', detail: 'Bash: pnpm test' } }] };
  assert.deepEqual(describeChanges(started, later), [], 'the same id in both states is not a change');
  const both: State = { ...prev, signal: 'green', slots: [{ ...working, status: 'waiting', sessionId: session }] };
  assert.deepEqual(describeChanges(prev, both), [
    'slot 1: working → waiting #29 worker=1a2b3c4d',
    `slot 1: session=${session} #29 worker=1a2b3c4d`,
    'signal: yellow → green',
  ]);
  assert.deepEqual(describeChanges(started, { ...started, slots: [empty] }), ['slot 1: working → empty #29 worker=1a2b3c4d'], 'freeing the slot drops the id silently: its line already left');
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
