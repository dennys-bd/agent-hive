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
import type { BoardQuota, SetupBody, Slot, State } from '../src/types.js';
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
const QUOTA: BoardQuota = { limit: 5000, remaining: 4320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' };

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
  line(worker, { type: 'result', result: 'Abro o PR?' });
  assert.equal(worker.ended, 0, 'no PR yet: the session stays open for follow-ups');
  await waitFor(() => slot0(server).status === 'esperando_voce');
  await openPr(server, workerId);
  assert.equal(slot0(server).status, 'aguardando_review');
  line(worker, { type: 'result' });
  assert.equal(worker.ended, 1);
  worker.handlers.onExit();
  await waitFor(() => slot0(server).status === 'vazio');
  assert.deepEqual(server.getState()?.queue, []);
  assert.equal(workers.length, 1, 'nothing left to spawn');
});

test('a result without a PR marks the slot as waiting for you with the final text as the question; the answer clears it', async (t) => {
  const { base, server, workers } = await start(t);
  const [worker] = workers;
  const { id, workerId } = slot0(server);
  line(worker, { type: 'result', result: 'Quer que eu abra o PR agora?' });
  await waitFor(() => slot0(server).status === 'esperando_voce');
  assert.equal(slot0(server).question, 'Quer que eu abra o PR agora?');
  assert.equal(slot0(server).lastEvent, 'aguardando resposta');
  assert.equal(worker.ended, 0, 'stdin stays open for the answer');
  assert.deepEqual(await json(postJson(`${base}/slots/${id}/input`, { text: 'abre' })), { ok: true });
  await server.dispatch({ type: 'hook', workerId: workerId!, payload: { hook_event_name: 'UserPromptSubmit' } }); // what the worker's hook posts
  assert.equal(slot0(server).status, 'trabalhando');
  assert.equal(slot0(server).question, undefined);
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

test('every poll reads the board quota afterwards and persists it; a board without quota stores nothing', async (t) => {
  const { base, server } = await start(t);
  assert.equal(server.getState()?.boardQuota, undefined, 'the default fake has no quota, like markdown');
  assert.deepEqual(await json(postJson(`${base}/board/refresh`)), { ok: true });
  assert.equal(server.getState()?.boardQuota, undefined);
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const withQuota = createServer({ repo, boardFactory: fakeBoardFactory(0, QUOTA).factory, spawnWorker: fakeSpawn().spawn });
  const port = await withQuota.listen(0);
  t.after(() => withQuota.close());
  assert.equal((await postJson(`http://127.0.0.1:${port}/setup`, BODY)).status, 200); // configure polls: the quota is read at boot
  assert.deepEqual(withQuota.getState()?.boardQuota, QUOTA);
  await withQuota.dispatch({ type: 'boardQuota', quota: { ...QUOTA, remaining: 1 } }); // overwrite, so the refresh below proves a re-read
  assert.deepEqual(await json(postJson(`http://127.0.0.1:${port}/board/refresh`)), { ok: true });
  assert.deepEqual(withQuota.getState()?.boardQuota, QUOTA, 'read again after the manual poll');
  const saved = JSON.parse(await readFile(join(repo, '.hive', 'state.json'), 'utf8')) as State;
  assert.deepEqual(saved.boardQuota, QUOTA, 'persisted with the rest of the state');
  assert.equal(withQuota.getState()?.error, undefined);
});

test('the timer skips the board while nothing could start, and reads it again once the last poll is 5 min old', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() }); // the timer and the clock shouldPoll reads
  let polls = 0;
  const inner = fakeBoardFactory().factory;
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const server = createServer({
    repo, spawnWorker: fakeSpawn().spawn,
    boardFactory: (config) => {
      const board = inner(config);
      return { ...board, listQueue: () => { polls += 1; return board.listQueue(); } };
    },
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  assert.equal((await postJson(`http://127.0.0.1:${port}/setup`, { ...BODY, maxConcurrent: 0 })).status, 200); // no slot: nothing can start
  assert.equal(polls, 1, 'configure always polls');
  for (let i = 1; i <= 9; i += 1) { // one interval at a time, as the clock does: 9 ticks = 4 min 30 s since the configure poll
    t.mock.timers.tick(30_000);
    await sleep(5);
    assert.equal(polls, 1, `tick ${i} with no free slot: the board is not asked`);
  }
  t.mock.timers.tick(30_000); // 5 min: stale
  await waitFor(() => polls === 2);
  t.mock.timers.tick(30_000);
  await sleep(10);
  assert.equal(polls, 2, 'fresh again: the next tick skips');
  assert.equal(server.getState()?.error, undefined);
});
