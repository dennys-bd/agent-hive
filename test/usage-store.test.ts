import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EVENTS_FILE, SCHEMA_VERSION, ZERO_TOKENS, type EventRecord } from '../src/events.js';
import { openUsageStore, USAGE_FILE } from '../src/usage-store.js';
import { fakeLog } from './fakes.js';
import { tempDir } from './temp-dir.js';

const TS = '2026-10-20T12:00:00.000Z';
const TOKENS = { input: 1, output: 2, cache_write: 3, cache_read: 4 };
const ENDED: EventRecord = {
  schema_version: SCHEMA_VERSION, ts: TS, event: 'stage.ended', level: 'info', task_id: 'board:I1', task: '1', activity_id: 'a-board:I1', stage: 'dev',
  session_id: 's-1', attempt: 2, run_kind: 'spawn', agent: 'codex', outcome: 'done', duration_ms: 60_000, waited_ms: 0, tokens: TOKENS,
  subagent_tokens: ZERO_TOKENS, models: ['gpt-5.6-terra'], tokens_by_model: { 'gpt-5.6-terra': TOKENS }, tool_counts: {},
};
const MOVED: EventRecord = { schema_version: SCHEMA_VERSION, ts: '2026-10-20T12:01:00.000Z', event: 'task.moved', level: 'info', task_id: 'board:I1', from: 'dev', to: 'review', by: 'hand' };
const POLLED: EventRecord = { schema_version: SCHEMA_VERSION, ts: TS, event: 'source.polled', level: 'debug', source: 'board', items: 1, duration_ms: 2 };
const lineOf = (record: EventRecord): string => `${JSON.stringify(record)}\n`;

// The rows through a connection of the test's own, as plain objects
function rowsOf(home: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join(home, USAGE_FILE));
  try {
    return db.prepare('SELECT * FROM records ORDER BY rowid').all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

// The first value of a query's first row
function peek(path: string, sql: string): unknown {
  const db = new DatabaseSync(path);
  try {
    return Object.values(db.prepare(sql).get() ?? {})[0];
  } finally {
    db.close();
  }
}

test('a kept record lands as one row: its correlation and agent as columns, the whole record as data; a record not kept lands nowhere; the file is owner-only (#271)', async (t) => {
  const home = await tempDir(t, 'usage-');
  const { log, lines } = fakeLog();
  const store = await openUsageStore(home, log);
  store.write(ENDED);
  store.write(POLLED);
  store.close();
  assert.deepEqual(rowsOf(home), [{
    ts: TS, event: 'stage.ended', task_id: 'board:I1', task: '1', activity_id: 'a-board:I1', stage: 'dev', session_id: 's-1', attempt: 2, run_kind: 'spawn',
    agent: 'codex', data: JSON.stringify(ENDED),
  }]);
  assert.deepEqual(lines, []);
  assert.equal(statSync(join(home, USAGE_FILE)).mode & 0o777, 0o600);
});

test('the rows survive a reopen, which imports nothing: a later write lands beside them, and a second close closes nothing twice (#271)', async (t) => {
  const home = await tempDir(t, 'usage-');
  const first = await openUsageStore(home, fakeLog().log);
  first.write(ENDED);
  first.close();
  await writeFile(join(home, EVENTS_FILE), lineOf(MOVED)); // written after the creation: never imported
  const second = await openUsageStore(home, fakeLog().log);
  second.write(MOVED);
  second.close();
  assert.doesNotThrow(() => second.close());
  assert.deepEqual(rowsOf(home).map((r) => r.event), ['stage.ended', 'task.moved']);
});

test('on creation the store imports the kept records of events.jsonl.1 then events.jsonl, skipping a line that does not parse (#271)', async (t) => {
  const home = await tempDir(t, 'usage-');
  await writeFile(join(home, `${EVENTS_FILE}.1`), `${lineOf(ENDED)}${lineOf(POLLED)}{"event":"task.mo\n`);
  await writeFile(join(home, EVENTS_FILE), `${lineOf(MOVED)}not json\n`);
  const { log, lines } = fakeLog();
  const store = await openUsageStore(home, log);
  store.close();
  assert.deepEqual(rowsOf(home).map((r) => [r.event, r.data]), [['stage.ended', JSON.stringify(ENDED)], ['task.moved', JSON.stringify(MOVED)]]);
  assert.deepEqual(lines, []);
});

test('a file that is not a database turns the store off with one error line and is left on disk as it was; a write then is a no-op (#271)', async (t) => {
  const home = await tempDir(t, 'usage-');
  const junk = randomBytes(4096);
  await writeFile(join(home, USAGE_FILE), junk);
  const { log, lines } = fakeLog();
  const store = await openUsageStore(home, log);
  assert.doesNotThrow(() => store.write(ENDED));
  store.close();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ERROR usage store: off, nothing is kept: /);
  assert.deepEqual(readFileSync(join(home, USAGE_FILE)), junk);
});

test('a file of a newer schema turns the store off the same way and keeps its rows and its version (#271)', async (t) => {
  const home = await tempDir(t, 'usage-');
  const path = join(home, USAGE_FILE);
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE records (x INTEGER); INSERT INTO records VALUES (7); PRAGMA user_version = 99');
  raw.close();
  const { log, lines } = fakeLog();
  const store = await openUsageStore(home, log);
  store.write(ENDED);
  store.close();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ERROR usage store: off, nothing is kept: usage store: schema version 99 is newer than 1/);
  assert.deepEqual([peek(path, 'PRAGMA user_version'), peek(path, 'SELECT x FROM records')], [99, 7]);
});

test('a write that fails turns the store off with one error line; it never throws, and a later write adds no line (#271)', async (t) => {
  const home = await tempDir(t, 'usage-');
  const { log, lines } = fakeLog();
  const store = await openUsageStore(home, log);
  const raw = new DatabaseSync(join(home, USAGE_FILE));
  raw.exec('DROP TABLE records'); // the statement the store prepared no longer has its table
  raw.close();
  assert.doesNotThrow(() => store.write(ENDED));
  store.write(MOVED);
  store.close();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ERROR usage store: off after a failed write/);
});
