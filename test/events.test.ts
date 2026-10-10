import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEventLog, EVENTS_FILE, RAW_TEXT_MAX, rawText, SCHEMA_VERSION, textRef } from '../src/events.js';
import { createLogger, LOG_FILE } from '../src/log.js';
import { fakeLog } from './fakes.js';
import { tempDir, type AfterHost } from './temp-dir.js';

const quiet = (): void => {};
const ACTIVITY = '9f8e7d6c-2222-4222-8222-222222222222';

async function eventsDir(t: AfterHost): Promise<string> {
  return join(await tempDir(t, 'events-'), '.hive'); // does not exist yet: the writer creates it
}
const records = (dir: string, file = EVENTS_FILE): Record<string, unknown>[] =>
  readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

test('a record gets schema_version 1 and an ISO ts first, keeps its fields, leaves an undefined one out, and writes its text line to hive.log (#742)', async (t) => {
  const dir = await eventsDir(t);
  const { log, lines } = fakeLog();
  const events = createEventLog(dir, 'info', { log, stderr: quiet });
  events.write({ event: 'stage.started', level: 'info', task_id: 'board:I30', activity_id: ACTIVITY, stage: 'dev', attempt: 2, run_kind: 'restart', session_id: undefined });
  const [record] = records(dir);
  assert.deepEqual(Object.keys(record).slice(0, 2), ['schema_version', 'ts']);
  assert.equal(record.schema_version, SCHEMA_VERSION);
  assert.match(String(record.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const { ts: _ts, ...rest } = record;
  assert.deepEqual(rest, { schema_version: 1, level: 'info', event: 'stage.started', task_id: 'board:I30', activity_id: ACTIVITY, stage: 'dev', attempt: 2, run_kind: 'restart' });
  assert.deepEqual(lines, ['INFO stage.started task_id=board:I30 activity_id=9f8e7d6c stage=dev attempt=2 run_kind=restart']);
});

test('the level filters both files the same way: under warn an info record reaches neither, warn and error reach both; setLevel moves it (#742)', async (t) => {
  const dir = await eventsDir(t);
  const { log, lines } = fakeLog();
  const events = createEventLog(dir, 'warn', { log, stderr: quiet });
  events.write({ event: 'workers.changed', level: 'info', active: 1, max: 2 });
  events.write({ event: 'http.error', level: 'warn', route: '/signal', status: 400 });
  events.write({ event: 'run.spawn_failed', level: 'error', code: 'exit 1' });
  events.setLevel('info');
  events.write({ event: 'workers.changed', level: 'info', active: 2, max: 2 });
  assert.deepEqual(records(dir).map((r) => r.event), ['http.error', 'run.spawn_failed', 'workers.changed']);
  assert.deepEqual(lines, ['WARN http.error route=/signal status=400', 'ERROR run.spawn_failed code=exit 1', 'INFO workers.changed active=2 max=2']);
});

test('past maxBytes events.jsonl becomes events.jsonl.1 and a new file starts (#742)', async (t) => {
  const dir = await eventsDir(t);
  const events = createEventLog(dir, 'info', { log: fakeLog().log, maxBytes: 250, stderr: quiet });
  // each hive.booted line is 106 bytes: two fit, the third rotates first
  events.write({ event: 'hive.booted', level: 'info', duration_ms: 1 });
  events.write({ event: 'hive.booted', level: 'info', duration_ms: 2 });
  events.write({ event: 'hive.booted', level: 'info', duration_ms: 3 });
  assert.deepEqual(records(dir).map((r) => r.duration_ms), [3]);
  assert.deepEqual(records(dir, `${EVENTS_FILE}.1`).map((r) => r.duration_ms), [1, 2]);
});

test('a write error disables events.jsonl with one stderr line and never throws; hive.log still gets the text line (#742)', async (t) => {
  const dir = join(await tempDir(t, 'events-'), '.hive');
  await writeFile(dir, 'not a directory'); // mkdir / append fail with EEXIST / ENOTDIR
  const calls: string[] = [];
  const { log, lines } = fakeLog();
  const events = createEventLog(dir, 'info', { log, stderr: (line) => { calls.push(line); } });
  assert.doesNotThrow(() => events.write({ event: 'hive.quit', level: 'info', reason: 'stop' }));
  events.write({ event: 'hive.quit', level: 'info', reason: 'signal' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^events\.jsonl: /);
  assert.deepEqual(lines, ['INFO hive.quit reason=stop', 'INFO hive.quit reason=signal']);
});

test('textRef gives the length and the first 16 hex characters of the sha256, never the text (#742)', () => {
  assert.deepEqual(textRef('rewrite the intro'), { chars: 17, sha256: createHash('sha256').update('rewrite the intro').digest('hex').slice(0, 16) });
  assert.match(textRef('').sha256, /^[0-9a-f]{16}$/);
});

test('a raw outside text is cut to 100 characters and kept on one line by the writer (#742)', async (t) => {
  const dir = await eventsDir(t);
  const events = createEventLog(dir, 'info', { log: fakeLog().log, stderr: quiet });
  events.write({ event: 'pr.checks', level: 'info', pr: 9, sha: 'abcdef12', check_run_id: 1, name: `lint\nERROR forged ${'x'.repeat(200)}`, conclusion: 'success' });
  const [record] = records(dir);
  assert.equal(String(record.name).length, RAW_TEXT_MAX);
  assert.equal(String(record.name).includes('\n'), false);
});

test('an error record reaches hive.log once, without a second stderr echo; events.jsonl is created 0600 (#742)', async (t) => {
  const dir = await eventsDir(t);
  const calls: string[] = [];
  const log = createLogger(dir, 'info', { stderr: (line) => { calls.push(line); } });
  createEventLog(dir, 'info', { log, stderr: quiet }).write({ event: 'run.spawn_failed', level: 'error', code: 'git_failed' });
  assert.match(readFileSync(join(dir, LOG_FILE), 'utf8'), /ERROR run\.spawn_failed code=git_failed\n$/);
  assert.deepEqual(calls, []);
  assert.equal(statSync(join(dir, EVENTS_FILE)).mode & 0o777, 0o600);
});

test('a fact hive.log already writes in a line of its own is not mirrored there again: source.action, source.polled, source.poll_failed (#742)', async (t) => {
  const dir = await eventsDir(t);
  const { log, lines } = fakeLog();
  const events = createEventLog(dir, 'debug', { log, stderr: quiet });
  events.write({ event: 'source.action', level: 'info', action: 'move', outcome: 'ok', latency_ms: 3 });
  events.write({ event: 'source.polled', level: 'debug', source: 'board', items: 1, duration_ms: 2 });
  events.write({ event: 'source.poll_failed', level: 'warn', source: 'board' });
  assert.deepEqual(records(dir).map((r) => r.event), ['source.action', 'source.polled', 'source.poll_failed']);
  assert.deepEqual(lines, []);
});

test('rawText turns control, separator and bidi characters into one space; the writer caps every list at 50 items (#742)', async (t) => {
  assert.equal(rawText('a\u0085b c‮d⁦e\u0007f'), 'a b c d e f');
  const dir = await eventsDir(t);
  const events = createEventLog(dir, 'info', { log: fakeLog().log, stderr: quiet });
  const models = Array.from({ length: 60 }, (_, i) => `m${i}`);
  events.write({ event: 'stage.ended', level: 'info', outcome: 'done', duration_ms: 1, waited_ms: 0, tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 }, subagent_tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 }, models, tool_counts: {} });
  assert.deepEqual(records(dir)[0]?.models, models.slice(0, 50));
});
