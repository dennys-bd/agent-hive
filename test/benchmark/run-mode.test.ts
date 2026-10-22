import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INTERVENTIONS_FILE } from '../../src/benchmark/metrics.js';
import { MARKER_FILE } from '../../src/benchmark/run-home.js';
import { createRecorder, readMarker, TERMINAL_INPUT, writeMarker } from '../../src/benchmark/run-mode.js';
import { tempDir } from '../temp-dir.js';
import { runMarker } from './fixtures.js';

test('readMarker reads no marker as none, reads back what writeMarker wrote (0600), and throws naming the file on a malformed one (#475)', async (t) => {
  const home = await tempDir(t, 'run-home-');
  assert.equal(await readMarker(home), undefined, 'no benchmark.json: a normal Hive');
  const marker = runMarker({ frozen: true });
  await writeMarker(home, marker);
  assert.deepEqual(await readMarker(home), marker);
  assert.equal((await stat(join(home, MARKER_FILE))).mode & 0o777, 0o600);
  const bad = ['{', '[]', JSON.stringify({ ...marker, frozen: 'yes' }), JSON.stringify({ ...marker, token: '../x' }), JSON.stringify({ ...marker, experiment: { id: 'exp-1' } }), JSON.stringify({ ...marker, round: -1 })];
  for (const text of bad) {
    await writeFile(join(home, MARKER_FILE), text);
    await assert.rejects(readMarker(home), /^Error: benchmark\.json: /, text);
  }
  await writeFile(join(home, MARKER_FILE), JSON.stringify({ ...marker, extra: 'dropped' }));
  assert.deepEqual(await readMarker(home), marker, 'a field the type does not know never reaches the daemon');
});

const AT = '2026-10-22T12:00:00.000Z';
const entry = (action: string, detail: string) => ({ at: AT, action, detail, by: 'user' as const });

test('the recorder appends { at, action, detail, by: user } to interventions.json (0600), records a pty\'s input once, and lists what it wrote (#475)', async (t) => {
  const home = await tempDir(t, 'run-home-');
  const lines: string[] = [];
  const recorder = createRecorder(home, () => new Date(AT), (line) => { lines.push(line); });
  assert.deepEqual(await recorder.list(), []);
  await recorder.record('POST /tasks/:id/approve', '/tasks/RUN-AB12-3/approve');
  await recorder.recordInput('pty-1', 'RUN-AB12-3');
  await recorder.recordInput('pty-1', 'RUN-AB12-3');
  await recorder.recordInput('pty-2', 'pty-2');
  const expected = [entry('POST /tasks/:id/approve', '/tasks/RUN-AB12-3/approve'), entry(TERMINAL_INPUT, 'RUN-AB12-3'), entry(TERMINAL_INPUT, 'pty-2')];
  assert.deepEqual(await recorder.list(), expected);
  assert.deepEqual(JSON.parse(await readFile(join(home, INTERVENTIONS_FILE), 'utf8')), expected);
  assert.equal((await stat(join(home, INTERVENTIONS_FILE))).mode & 0o777, 0o600);
  assert.deepEqual(lines, []);
});

test('records made at once all land, in call order: the writes are serialized (#475)', async (t) => {
  const recorder = createRecorder(await tempDir(t, 'run-home-'), () => new Date(AT), () => undefined);
  await Promise.all([0, 1, 2, 3, 4].map((i) => recorder.record('POST /signal', `/signal/${i}`)));
  assert.deepEqual((await recorder.list()).map((e) => e.detail), ['/signal/0', '/signal/1', '/signal/2', '/signal/3', '/signal/4']);
});

test('a broken interventions.json is left as it is: the record resolves, logs one line with no action or detail, and writes nothing (#475)', async (t) => {
  const home = await tempDir(t, 'run-home-');
  await writeFile(join(home, INTERVENTIONS_FILE), '{');
  const lines: string[] = [];
  const recorder = createRecorder(home, () => new Date(AT), (line) => { lines.push(line); });
  await recorder.record('POST /tasks/:id/approve', '/tasks/RUN-AB12-3/approve');
  assert.equal(await readFile(join(home, INTERVENTIONS_FILE), 'utf8'), '{');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /interventions\.json not written/);
  assert.ok(!lines[0].includes('/tasks'), 'the log never quotes what the user did');
});
