import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseConfig } from '../src/config.js';
import { prepareHiveDir } from '../src/hooks-settings.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { RESULT_LINE } from '../src/workers.js';
import type { SetupBody, Slot, State } from '../src/types.js';
import { fakeBoardFactory, fakeSpawn, type FakeWorker } from './fakes.js';

const BODY: SetupBody = {
  board: { type: 'github', owner: 'acme', number: 6 },
  status: { queue: 'Ready', working: 'In progress', review: 'In review' },
  maxConcurrent: 1, // one slot: the fake board's single task is spawned into the fake worker
};

interface Started { repo: string; base: string; port: number; server: HiveServer; workers: FakeWorker[] }

const postJson = (url: string, body?: unknown): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
const slot0 = (server: HiveServer): Slot => server.getState()!.slots[0];
const line = (worker: FakeWorker, payload: unknown): void => worker.handlers.onLine(JSON.stringify(payload));

async function start(t: TestContext, body: SetupBody = BODY, withFocus = false): Promise<Started> {
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const { spawn, workers } = fakeSpawn(withFocus);
  const server = createServer({ repo, boardFactory: fakeBoardFactory().factory, spawnWorker: spawn });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/setup`, body)).status, 200); // configure + poll + fill: the spawn runs before the answer
  return { repo, base, port, server, workers };
}

// The fake's onExit dispatches without awaiting, like a real process event: poll the state until it settles.
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

const openPr = (server: HiveServer, workerId: string): Promise<void> =>
  server.dispatch({
    type: 'hook', workerId,
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: 'https://github.com/acme/r/pull/9' },
  });

test('saving the setup starts one worker with the launch: mode, repo, port, hooks, prompt file and the rendered prompt', async (t) => {
  const { repo, port, server, workers } = await start(t);
  const slot = slot0(server);
  assert.equal(slot.status, 'trabalhando');
  assert.equal(slot.slug, 'hive-1-from-ready');
  assert.equal(workers.length, 1);
  const promptPath = join(repo, '.hive', 'prompts', 'hive-1-from-ready.md');
  assert.deepEqual(workers[0].launch, {
    mode: 'embedded', workerId: slot.workerId, slug: 'hive-1-from-ready', repo, port,
    hooksPath: join(repo, '.hive', 'hooks.json'), promptPath, prompt: await readFile(promptPath, 'utf8'), claudeArgs: [],
  });
});

test('workers: iterm in the setup reaches the launch; POST /hooks/exit frees its slot and POST /slots/:id/focus reaches the tab', async (t) => {
  const { base, server, workers } = await start(t, { ...BODY, workers: 'iterm' }, true);
  const { id, workerId } = slot0(server);
  assert.equal(workers[0].launch.mode, 'iterm');
  assert.deepEqual(await json(postJson(`${base}/slots/${id}/focus`)), { ok: true });
  assert.equal(workers[0].focused, 1);
  await fetch(`${base}/hooks/exit`, { method: 'POST', headers: { 'x-hive-worker': workerId! } });
  await waitFor(() => workers.length === 2); // the slot freed, the task requeued and picked up by a new worker
});

test('POST /slots/:id/focus is 404 for an embedded worker (no tab) and for an unknown slot', async (t) => {
  const { base, server } = await start(t);
  assert.equal((await postJson(`${base}/slots/${slot0(server).id}/focus`)).status, 404);
  assert.equal((await postJson(`${base}/slots/nope/focus`)).status, 404);
});

test('POST /slots/:id/input writes to the worker; blank text is 400 and an unknown slot is 404', async (t) => {
  const { base, server, workers } = await start(t);
  const id = slot0(server).id;
  assert.deepEqual(await json(postJson(`${base}/slots/${id}/input`, { text: 'olha o CI também' })), { ok: true });
  assert.deepEqual(workers[0].sent, ['olha o CI também']);
  assert.equal((await postJson(`${base}/slots/${id}/input`, { text: '   ' })).status, 400);
  assert.equal((await postJson(`${base}/slots/${id}/input`, {})).status, 400);
  assert.equal((await postJson(`${base}/slots/nope/input`, { text: 'x' })).status, 404);
  assert.equal(workers[0].sent.length, 1);
});

test('GET /slots/:id/output returns the formatted lines the worker emitted; an unknown slot is 404', async (t) => {
  const { base, server, workers } = await start(t);
  const id = slot0(server).id;
  assert.deepEqual(await json(fetch(`${base}/slots/${id}/output`)), { lines: [] });
  line(workers[0], { type: 'assistant', message: { content: [{ type: 'text', text: 'lendo o issue' }] } });
  workers[0].handlers.onLine('stderr: aviso');
  line(workers[0], { type: 'result' });
  assert.deepEqual(await json(fetch(`${base}/slots/${id}/output`)), { lines: ['lendo o issue', 'stderr: aviso', RESULT_LINE] });
  assert.equal((await fetch(`${base}/slots/nope/output`)).status, 404);
});

test('a result closes stdin only once the PR is open; the exit then frees the slot without requeueing', async (t) => {
  const { server, workers } = await start(t);
  const [worker] = workers;
  const workerId = slot0(server).workerId!;
  line(worker, { type: 'result' });
  assert.equal(worker.ended, 0, 'no PR yet: the session stays open for follow-ups');
  await openPr(server, workerId);
  assert.equal(slot0(server).status, 'aguardando_review');
  line(worker, { type: 'result' });
  assert.equal(worker.ended, 1);
  worker.handlers.onExit();
  await waitFor(() => slot0(server).status === 'vazio');
  assert.deepEqual(server.getState()?.queue, []);
  assert.equal(workers.length, 1, 'nothing left to spawn');
});

test('an exit without a PR requeues the task, which the free slot picks up again with a new worker', async (t) => {
  const { server, workers } = await start(t);
  const first = slot0(server).workerId;
  workers[0].handlers.onExit();
  await waitFor(() => workers.length === 2);
  const slot = slot0(server);
  assert.equal(slot.status, 'trabalhando');
  assert.notEqual(slot.workerId, first);
  assert.equal(workers[1].launch.workerId, slot.workerId);
  assert.deepEqual(server.getState()?.queue, []);
});

test('POST /slots/:id/kill sends kill to the live worker; the slot frees on its exit, not before', async (t) => {
  const { base, server, workers } = await start(t);
  const id = slot0(server).id;
  assert.deepEqual(await json(postJson(`${base}/slots/${id}/kill`)), { ok: true });
  assert.equal(workers[0].killed, 1);
  assert.equal(slot0(server).status, 'trabalhando');
  workers[0].handlers.onExit();
  await waitFor(() => workers.length === 2); // requeued and picked up again
});

test('kill on a slot whose process the pool does not know (Hive restarted) frees the slot directly', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, 0);
  const { factory } = fakeBoardFactory();
  const config = parseConfig(BODY);
  const board = factory(config);
  const previous = reduce(initialState(1), { type: 'poll', tasks: await board.listQueue() }).state; // occupied by a worker of a previous run
  const state: State = { ...previous, signal: 'yellow' }; // yellow: the requeued task is not picked up, so the freed slot stays visible
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ repo, boardFactory: factory, spawnWorker: spawn, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state });
  await server.listen(0);
  t.after(() => server.close());
  await server.dispatch({ type: 'kill', slotId: state.slots[0].id });
  assert.equal(slot0(server).status, 'vazio');
  assert.deepEqual(server.getState()?.queue.map((task) => task.id), ['1']);
  assert.equal(workers.length, 0);
});

test('close() kills every live worker before the HTTP server goes down, and a second close() is a no-op', async (t) => {
  const { base, server, workers } = await start(t);
  await server.close();
  assert.equal(workers[0].killed, 1);
  await assert.rejects(fetch(`${base}/setup`));
  await server.close();
});
