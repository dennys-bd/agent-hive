import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import { readDaemonSecret } from '../../src/daemon-files.js';
import { bootHive } from '../../src/hive.js';
import { initialState } from '../../src/orchestrator.js';
import { saveState } from '../../src/state-store.js';
import { SECRET_HEADER, secretCookie } from '../../src/secret.js';
import { type Intervention, SIGNALS_DEFAULTS, type Task } from '../../src/types.js';
import type { RunMarker } from '../../src/benchmark/run-home.js';
import { combConfig, fakeSpawn, LOCAL_STAGES, tempHive, WORKSPACE } from '../fakes.js';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INTERVENTIONS_FILE } from '../../src/benchmark/metrics.js';
import { MARKER_FILE } from '../../src/benchmark/run-home.js';
import { createRecorder, type InterventionRecorder, readMarker, registerRunMode, TERMINAL_INPUT, viewerInput, writeMarker } from '../../src/benchmark/run-mode.js';
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

// The gate in server.ts already ran: what tells the viewer's page from a worker is only the missing x-hive-secret
const VIEWER = { 'x-hive-ui': '1' };
const WORKER = { [SECRET_HEADER]: 'w'.repeat(64), 'x-hive-ui': '1' };

interface Harness { base: string; recorder: InterventionRecorder; approved: string[]; home: string }
async function runApp(t: TestContext, frozen = false): Promise<Harness> {
  const home = await tempDir(t, 'run-home-');
  const recorder = createRecorder(home, () => new Date(AT), () => undefined);
  const approved: string[] = [];
  const app = express();
  registerRunMode(app, { marker: runMarker({ frozen }), recorder, home });
  app.post('/tasks/:id/approve', (req, res) => {
    approved.push(String(req.params.id));
    res.status(req.params.id === 'nope' ? 404 : 200).json({ ok: true });
  });
  app.post('/view-state/:key', (_req, res) => void res.json({ ok: true }));
  app.post('/hooks/event', (_req, res) => void res.status(204).end());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, recorder, approved, home };
}

async function post(base: string, path: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${base}${path}?tab=2`, { method: 'POST', headers });
  await res.body?.cancel();
  return res.status;
}

// 'finish' fires as the answer leaves, so a read right after the response may come first: wait for the one that counts, then compare everything
async function settled(recorder: InterventionRecorder, count: number) {
  for (let i = 0; i < 100 && (await recorder.list()).length < count; i += 1) await sleep(5);
  return recorder.list();
}

test('a viewer write answered below 400 records the method and route pattern with the path and no query; a worker\'s, a refused one, view-state and hooks record nothing (#475)', async (t) => {
  const h = await runApp(t);
  assert.equal(await post(h.base, '/tasks/RUN-AB12-3/approve', WORKER), 200);
  assert.equal(await post(h.base, '/tasks/nope/approve', VIEWER), 404);
  assert.equal(await post(h.base, '/view-state/consoleHeight', VIEWER), 200);
  assert.equal(await post(h.base, '/hooks/event', VIEWER), 204);
  assert.equal(await post(h.base, '/tasks/RUN-AB12-3/approve', VIEWER), 200); // the one that counts, last: the others had their chance
  assert.deepEqual(await settled(h.recorder, 1), [entry('POST /tasks/:id/approve', '/tasks/RUN-AB12-3/approve')]);
});

test('frozen: a viewer write is refused with 409 frozen before its route runs; view-state, hooks and a worker\'s write pass, and nothing is recorded (#475)', async (t) => {
  const h = await runApp(t, true);
  const res = await fetch(`${h.base}/tasks/RUN-AB12-3/approve`, { method: 'POST', headers: VIEWER });
  assert.deepEqual([res.status, await res.json()], [409, { error: 'frozen' }]);
  assert.deepEqual(h.approved, [], 'the route never ran');
  assert.equal(await post(h.base, '/view-state/consoleHeight', VIEWER), 200);
  assert.equal(await post(h.base, '/hooks/event', VIEWER), 204);
  assert.equal(await post(h.base, '/tasks/RUN-AB12-3/approve', WORKER), 200, 'the main Hive and the run\'s own clients still reach it');
  assert.deepEqual(await settled(h.recorder, 1), []);
});

test('GET /benchmark-run answers the marker, the interventions so far and the daemon\'s home (#475, #469)', async (t) => {
  const h = await runApp(t);
  await h.recorder.record('POST /signal', '/signal');
  const res = await fetch(`${h.base}/benchmark-run`, { headers: WORKER });
  assert.deepEqual([res.status, await res.json()], [200, { marker: runMarker(), interventions: [entry('POST /signal', '/signal')], home: h.home }]);
});

test('viewerInput records a pty\'s first input once, under its detail, and delivers every input; frozen it delivers none and records none (#475)', async (t) => {
  const recorder = createRecorder(await tempDir(t, 'run-home-'), () => new Date(AT), () => undefined);
  const live = viewerInput({ marker: runMarker(), recorder, home: 'unused' }, (ptyId) => (ptyId === 'pty-1' ? 'RUN-AB12-3' : ptyId));
  assert.deepEqual([live('pty-1'), live('pty-1'), live('pty-2')], [true, true, true]);
  assert.deepEqual(await recorder.list(), [entry(TERMINAL_INPUT, 'RUN-AB12-3'), entry(TERMINAL_INPUT, 'pty-2')]);
  const still = createRecorder(await tempDir(t, 'run-home-'), () => new Date(AT), () => undefined);
  assert.equal(viewerInput({ marker: runMarker({ frozen: true }), recorder: still, home: 'unused' }, (id) => id)('pty-1'), false);
  assert.deepEqual(await still.list(), []);
});

const LOCAL_TASK: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'One', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: WORKSPACE };

// A run home as prepareRun leaves one, on a temp repo: no source, the flow opening green (a run's watcher turns it green), `cap` workers and
// `tasks`. Its pinned plugin folder is missing: the plugin render logs that and the boot goes on
async function runHomeWith(t: TestContext, marker: RunMarker | undefined, cap = 0, tasks: Task[] = []): Promise<string> {
  const { home, repo } = await tempHive(t, cap);
  await writeFile(join(home, 'hive.config.json'), JSON.stringify(combConfig({ stages: LOCAL_STAGES, path: repo, signals: { ...SIGNALS_DEFAULTS, onOpen: 'green' } })));
  await saveState(home, { ...initialState(cap), tasks });
  if (marker !== undefined) await writeMarker(home, marker);
  return home;
}

test('a daemon booted on a run home answers GET /benchmark-run with its marker and records a viewer\'s write through the real gate; one without benchmark.json answers 404 (#475)', async (t) => {
  const home = await runHomeWith(t, runMarker(), 0, [{ ...LOCAL_TASK, auto: false }]);
  const { server, port } = await bootHive(home);
  t.after(() => server.close());
  const secret = readDaemonSecret(home) ?? '';
  const viewer = { cookie: `${secretCookie(port)}=${secret}`, 'x-hive-ui': '1', 'content-type': 'application/json' };
  const write = await fetch(`http://127.0.0.1:${port}/tasks/local:1/auto`, { method: 'POST', headers: viewer, body: JSON.stringify({ auto: false }) });
  assert.equal(write.status, 200);
  const read = async () => (await (await fetch(`http://127.0.0.1:${port}/benchmark-run`, { headers: { [SECRET_HEADER]: secret } })).json()) as { marker: RunMarker; interventions: Intervention[]; home: string };
  let body = await read();
  for (let i = 0; i < 100 && body.interventions.length === 0; i += 1) {
    await sleep(5);
    body = await read();
  }
  assert.deepEqual(body.marker, runMarker());
  assert.equal(body.home, home, 'the run window\'s footer names the isolated home (#469)');
  assert.deepEqual(body.interventions.map((e) => [e.action, e.detail, e.by]), [['POST /tasks/:id/auto', '/tasks/local:1/auto', 'user']]);

  const plain = await runHomeWith(t, undefined);
  const normal = await bootHive(plain);
  t.after(() => normal.server.close());
  assert.equal((await fetch(`http://127.0.0.1:${normal.port}/benchmark-run`, { headers: { [SECRET_HEADER]: readDaemonSecret(plain) ?? '' } })).status, 404);
});

test('frozen, the daemon boots with no worker and a cap of 0 and the fill starts no run; the same home unfrozen starts its auto task (#475)', async (t) => {
  for (const frozen of [true, false]) {
    const home = await runHomeWith(t, runMarker({ frozen }), 2, [LOCAL_TASK]);
    const spawned = fakeSpawn();
    const { server } = await bootHive(home, { launchPty: spawned.spawn });
    t.after(() => server.close());
    const state = server.getState();
    // The workspace's local activity exists either way; the fill's start shows as the task's own activity (this home has no plugin folder, so
    // that start fails and leaves no worker occupied)
    const started = state?.activities.filter((x) => x.kind === 'task').length;
    if (frozen) assert.deepEqual([state?.maxConcurrent, state?.workers.length, started, spawned.workers.length], [0, 0, 0, 0]);
    else assert.equal(started, 1, 'the control: an unfrozen run home starts the task');
  }
});

test('a malformed benchmark.json fails the boot naming the file, and hive.log says so (#475)', async (t) => {
  const home = await runHomeWith(t, undefined);
  await writeFile(join(home, MARKER_FILE), '{"frozen":');
  await assert.rejects(bootHive(home), /benchmark\.json: does not parse/);
  assert.match(await readFile(join(home, 'hive.log'), 'utf8'), /ERROR benchmark: benchmark\.json: does not parse/);
});
