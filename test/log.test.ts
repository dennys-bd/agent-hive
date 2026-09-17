import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, LOG_FILE } from '../src/log.js';

const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (ERROR|INFO |DEBUG) /;
const ISO_WIDTH = 25; // "2026-09-17T12:00:00.000Z " — what precedes the level tag
const quiet = (): void => {};

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
