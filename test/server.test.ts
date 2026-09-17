import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseConfig } from '../src/config.js';
import { prepareHiveDir } from '../src/hooks-settings.js';
import type { Logger } from '../src/log.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { PLAN_LIMITS_INTERVAL_MS } from '../src/plan-limits.js';
import { transcriptDir } from '../src/usage.js';
import { createServer, type HiveServer } from '../src/server.js';
import type { BoardQuota, Card, RateLimits, SetupBody, Slot, State } from '../src/types.js';
import { COLUMNS, fakeBoardFactory, fakeLog, fakeSpawn, type FakeWorker } from './fakes.js';

const BODY: SetupBody = {
  board: { type: 'github', owner: 'acme', number: 6 },
  columns: COLUMNS,
  maxConcurrent: 1, // one slot: the fake board's single task is spawned into the fake worker
};

interface Started { repo: string; base: string; port: number; server: HiveServer; workers: FakeWorker[] }

const postJson = (url: string, body?: unknown): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
const slot0 = (server: HiveServer): Slot => server.getState()!.slots[0];
const card0 = (server: HiveServer): Card => server.getState()!.cards[0];
const QUOTA: BoardQuota = { limit: 5000, remaining: 4320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' };
const PLAN: RateLimits = {
  at: '2026-09-17T12:00:00.000Z',
  windows: { five_hour: { usedPercent: 23.4, resetsAt: '2026-09-17T15:00:00.000Z' }, seven_day_opus: { usedPercent: 7.5, resetsAt: '2026-09-21T00:00:00.000Z' } },
};
const NO_TOKEN = 'no Claude Code OAuth token (env, .credentials.json or Keychain)';

async function start(t: TestContext, body: SetupBody = BODY, log?: Logger): Promise<Started> {
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ repo, boardFactory: fakeBoardFactory().factory, spawnWorker: spawn, log });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/setup`, body)).status, 200); // configure + poll: boot opens under yellow, so nothing spawns yet
  await server.dispatch({ type: 'setSignal', signal: 'green' }); // these tests exercise worker behavior, not the boot signal itself
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

// What the worker's hook command posts: the JSON payload on the body, the worker id on the header.
const hookEvent = (base: string, workerId: string, payload: unknown): Promise<Response> =>
  fetch(`${base}/hooks/event`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-worker': workerId }, body: JSON.stringify(payload) });

test('POST /setup does not override a maxConcurrent changed through POST /config', async (t) => {
  const { base, server } = await start(t);
  assert.equal(server.getState()?.maxConcurrent, 1);
  assert.equal((await postJson(`${base}/config`, { maxConcurrent: 2 })).status, 200);
  assert.equal(server.getState()?.maxConcurrent, 2);
  const { maxConcurrent: _omitted, ...withoutMax } = BODY; // the form re-save: no maxConcurrent key
  assert.equal((await postJson(`${base}/setup`, withoutMax)).status, 200);
  assert.equal(server.getState()?.maxConcurrent, 2, 'the form re-save does not revert the header change');
});

test('saving the setup starts one worker with the launch: mode, repo, port, hooks and the prompt file with the rendered prompt', async (t) => {
  const { repo, port, server, workers } = await start(t);
  const slot = slot0(server);
  assert.equal(slot.status, 'working');
  assert.equal(card0(server).slug, 'hive-1-from-ready');
  assert.equal(workers.length, 1);
  const promptPath = join(repo, '.hive', 'prompts', 'hive-1-from-ready.md');
  assert.deepEqual(workers[0].launch, {
    mode: 'embedded', workerId: slot.workerId, slug: 'hive-1-from-ready', repo, port,
    hooksPath: join(repo, '.hive', 'hooks.json'), promptPath,
    args: ['--worktree=hive-1-from-ready', '--session-id', server.getState()!.cards[0].sessionId!],
  });
  assert.match(workers[0].launch.args[2], /^[0-9a-f-]{36}$/);
  assert.match(await readFile(promptPath, 'utf8'), /from Ready/, 'the command line reads the prompt from this file');
});

test('workers: iterm in the setup reaches the launch; POST /hooks/exit frees its slot and POST /slots/:id/focus reaches the tab', async (t) => {
  const { base, server, workers } = await start(t, { ...BODY, workers: 'iterm' });
  const { id, workerId } = slot0(server);
  assert.equal(workers[0].launch.mode, 'iterm');
  assert.deepEqual(await json(postJson(`${base}/slots/${id}/focus`)), { ok: true });
  assert.equal(workers[0].focused, 1);
  await fetch(`${base}/hooks/exit`, { method: 'POST', headers: { 'x-hive-worker': workerId! } });
  await waitFor(() => workers.length === 2); // the slot freed, the card still in its column and run again by a new worker
});

test('POST /slots/:id/focus reaches the handle of an embedded worker too; an unknown slot is 404 and a terminal that fails is 500', async (t) => {
  const { base, server, workers } = await start(t);
  const id = slot0(server).id;
  assert.deepEqual(await json(postJson(`${base}/slots/${id}/focus`)), { ok: true });
  assert.equal(workers[0].focused, 1);
  assert.equal((await postJson(`${base}/slots/nope/focus`)).status, 404);
  workers[0].focusError = new Error('terminal não suportado em win32');
  const failed = await postJson(`${base}/slots/${id}/focus`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'terminal não suportado em win32' });
});

test('GET /slots/:id/output is the formatted tail of the worker transcript SessionStart pointed at; [] before the hook, when unreadable or when the path is not the worker own; unknown slot is 404', async (t) => {
  const { base, repo, server } = await start(t);
  const { id, workerId } = slot0(server);
  const { slug } = card0(server);
  const configDir = await mkdtemp(join(tmpdir(), 'hive-claude-'));
  process.env.CLAUDE_CONFIG_DIR = configDir; // where transcriptDir looks; the suite runs one file per process
  t.after(() => { delete process.env.CLAUDE_CONFIG_DIR; });
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'faz a task' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'lendo o issue' }, { type: 'tool_use', name: 'Bash', input: { command: 'gh issue view 1' } }] } }),
    '',
  ].join('\n');
  const sessionStart = (transcriptPath: string): Promise<Response> => fetch(`${base}/hooks/event`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-worker': workerId! },
    body: JSON.stringify({ hook_event_name: 'SessionStart', cwd: repo, transcript_path: transcriptPath }),
  });
  assert.deepEqual(await json(fetch(`${base}/slots/${id}/output`)), { lines: [] });
  const forged = join(configDir, 'projects', '-Users-x-secret', 'other.jsonl'); // another project's transcript: any local process can post a hook
  await mkdir(dirname(forged), { recursive: true });
  await writeFile(forged, lines);
  assert.equal((await sessionStart(forged)).status, 200);
  assert.deepEqual(await json(fetch(`${base}/slots/${id}/output`)), { lines: [] }, 'a path outside the worker transcript dir is dropped');
  assert.equal(slot0(server).transcriptPath, undefined);
  const own = join(transcriptDir(join(repo, '.claude', 'worktrees', slug)), 'abc.jsonl');
  await mkdir(dirname(own), { recursive: true });
  await writeFile(own, lines);
  assert.equal((await sessionStart(own)).status, 200);
  assert.deepEqual(await json(fetch(`${base}/slots/${id}/output`)), { lines: ['lendo o issue', '▶ Bash: gh issue view 1'] });
  await rm(own);
  assert.deepEqual(await json(fetch(`${base}/slots/${id}/output`)), { lines: [] }, 'an unreadable transcript is an empty excerpt, not an error');
  assert.equal((await fetch(`${base}/slots/nope/output`)).status, 404);
});

test('a Stop ends the run: the session is killed, onFinish written, the card leaves (single column) and the slot frees; a PR seen before stays on the card until then', async (t) => {
  const { log, lines } = fakeLog();
  const { base, server, workers } = await start(t, BODY, log);
  const [worker] = workers;
  const workerId = slot0(server).workerId!;
  await openPr(server, workerId);
  assert.equal(slot0(server).status, 'review');
  assert.equal(card0(server).prUrl, 'https://github.com/acme/r/pull/9');
  assert.equal(worker.killed, 0, 'a PR is not a transition any more');
  assert.equal((await hookEvent(base, workerId, { hook_event_name: 'Stop' })).status, 200);
  assert.equal(worker.killed, 1, 'killed through the effect, before the answer');
  assert.equal(slot0(server).status, 'empty');
  assert.deepEqual(server.getState()?.cards, [], 'fila is the last column');
  assert.ok(lines.includes('INFO setColumn #I1 → In review ok'), lines.join('\n'));
  worker.handlers.onExit();
  await sleep(20);
  assert.equal(workers.length, 1, 'the exit of a killed session is a no-op');
});

test('a Stop from a child session (a subagent or teammate) does not end the run; the main session does (#24)', async (t) => {
  const { base, repo, server, workers } = await start(t);
  const [worker] = workers;
  const workerId = slot0(server).workerId!;
  const mainId = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  assert.equal((await hookEvent(base, workerId, { hook_event_name: 'SessionStart', cwd: repo, session_id: mainId })).status, 200);
  assert.equal((await hookEvent(base, workerId, { hook_event_name: 'Stop', session_id: 'another-child-session-0001' })).status, 200);
  assert.equal(worker.killed, 0);
  assert.equal(slot0(server).status, 'working');
  assert.equal((await hookEvent(base, workerId, { hook_event_name: 'Stop', session_id: mainId })).status, 200);
  assert.equal(worker.killed, 1);
});

test('an error reported by the spawner lands in State.error with the worker slug', async (t) => {
  const { server, workers } = await start(t);
  workers[0].handlers.onError('tmux: spawn tmux ENOENT');
  await waitFor(() => server.getState()?.error === 'worker hive-1-from-ready: tmux: spawn tmux ENOENT');
  assert.equal(slot0(server).status, 'working', 'only the exit frees the slot');
});

test('an exit without Stop keeps the card in its column and a new worker runs it again with a fresh session id', async (t) => {
  const { server, workers } = await start(t);
  const first = slot0(server).workerId;
  const session = card0(server).sessionId;
  workers[0].handlers.onExit();
  await waitFor(() => workers.length === 2);
  const slot = slot0(server);
  assert.equal(slot.status, 'working');
  assert.notEqual(slot.workerId, first);
  assert.equal(workers[1].launch.workerId, slot.workerId);
  assert.equal(card0(server).column, 'fila');
  assert.notEqual(card0(server).sessionId, session, 'new: a fresh id each run');
});

test('POST /slots/:id/kill sends kill to the live worker; the slot frees on its exit, not before', async (t) => {
  const { base, server, workers } = await start(t);
  const id = slot0(server).id;
  assert.deepEqual(await json(postJson(`${base}/slots/${id}/kill`)), { ok: true });
  assert.equal(workers[0].killed, 1);
  assert.equal(slot0(server).status, 'working');
  workers[0].handlers.onExit();
  await waitFor(() => workers.length === 2); // the card stays in its column and runs again
});

test('kill on a slot whose process the pool does not know (Hive restarted) frees the slot directly', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, 0);
  const { factory } = fakeBoardFactory();
  const config = parseConfig(BODY);
  const board = factory(config);
  const previous = reduce({ ...initialState(1), columns: config.columns }, { type: 'poll', cards: await board.listCards() }).state; // occupied by a worker of a previous run
  const state: State = { ...previous, signal: 'yellow' }; // yellow: the freed card is not run again, so the freed slot stays visible
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ repo, boardFactory: factory, spawnWorker: spawn, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state });
  await server.listen(0);
  t.after(() => server.close());
  await server.dispatch({ type: 'kill', slotId: state.slots[0].id });
  assert.equal(slot0(server).status, 'empty');
  assert.deepEqual(server.getState()?.cards.map((c) => [c.task.id, c.slotId]), [['1', undefined]]);
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
      return { ...board, listCards: () => { polls += 1; return board.listCards(); } };
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

test('the log tells the story: slot transitions, signal and board writes at info, events at debug, and never a tool_input', async (t) => {
  const { log, lines } = fakeLog();
  const { base, repo, server } = await start(t, BODY, log);
  const workerId = slot0(server).workerId!;
  const id8 = workerId.slice(0, 8);
  const has = (line: string): void => assert.ok(lines.includes(line), `missing "${line}" in:\n${lines.join('\n')}`);
  has('INFO signal: green → yellow'); // boot
  has('INFO poll cards=1');
  has('INFO signal: yellow → green');
  has(`INFO slot 1: empty → working #1 worker=${id8}`);
  has('INFO setColumn #I1 → In progress ok');
  has(`INFO spawn slot=${slot0(server).id.slice(0, 8)} #1 slug=hive-1-from-ready column=fila session=new worker=${id8}`);
  has('DEBUG setSignal green');
  has(`DEBUG effects: setColumn #I1 → In progress; spawn slot=${slot0(server).id.slice(0, 8)} #1 slug=hive-1-from-ready column=fila session=new worker=${id8}`);
  const session = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  assert.equal((await hookEvent(base, workerId, { hook_event_name: 'SessionStart', cwd: repo, session_id: session })).status, 200);
  assert.equal(slot0(server).sessionId, session, 'the route hands the whole payload to the reducer');
  has(`DEBUG hook SessionStart worker=${id8}`);
  has(`INFO slot 1: session=${session} #1 worker=${id8}`);
  assert.equal(lines.filter((l) => l.includes(`session=${session}`)).length, 1, 'one line per session');
  await openPr(server, workerId);
  has(`DEBUG hook PostToolUse worker=${id8} tool=Bash`);
  has(`INFO slot 1: working → review #1 worker=${id8}`);
  assert.ok(!lines.some((l) => l.includes('setColumn #I1 → In review')), 'a PR writes nothing');
  assert.ok(!lines.some((l) => l.includes('gh pr create')), 'tool_input never reaches the log');
  assert.ok(!lines.some((l) => l.includes('pull/9')), 'tool_response never reaches the log');
  assert.ok(!lines.some((l) => l.startsWith('ERROR')), lines.filter((l) => l.startsWith('ERROR')).join('\n'));
});

test('POST /setup re-reads logLevel from hive.config.json and switches the logger level without a restart', async (t) => {
  const { log, lines } = fakeLog();
  const { base, repo, port } = await start(t, BODY, log);
  assert.ok(lines.includes('LEVEL info'), 'the first save activates the default level');
  assert.ok(lines.includes(`INFO config port=${port} board=github workers=embedded logLevel=info columns=fila(1)`));
  assert.ok(lines.includes('INFO setup saved'));
  assert.ok(lines.includes(`INFO listening port=${port}`));
  const file = join(repo, 'hive.config.json');
  const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...saved, logLevel: 'debug' })); // the hand edit the spec describes
  const { maxConcurrent: _omitted, ...formBody } = BODY; // the form re-save: no logLevel in the body
  assert.equal((await postJson(`${base}/setup`, formBody)).status, 200);
  assert.ok(lines.includes('LEVEL debug'), lines.filter((l) => l.startsWith('LEVEL')).join('\n'));
  assert.ok(lines.includes(`INFO config port=${port} board=github workers=embedded logLevel=debug columns=fila(1)`));
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as { logLevel: string }).logLevel, 'debug', 'the save keeps the level it read');
});

test('POST /setup reads the plan limits through the injected reader with no worker alive, and the timer reads again every 5 min', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] }); // before listen: the timer is armed there
  let reads = 0;
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const server = createServer({
    repo, boardFactory: fakeBoardFactory().factory, spawnWorker: fakeSpawn().spawn,
    readPlanLimits: async () => { reads += 1; return { ...PLAN, at: `2026-09-17T12:0${reads}:00.000Z` }; },
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  assert.equal(reads, 0, 'nothing to read before the Hive is configured');
  assert.equal((await postJson(`http://127.0.0.1:${port}/setup`, { ...BODY, maxConcurrent: 0 })).status, 200); // no slot: no worker ever
  assert.equal(reads, 1, 'configure reads once, after the poll');
  assert.deepEqual(server.getState()?.rateLimits, { ...PLAN, at: '2026-09-17T12:01:00.000Z' });
  t.mock.timers.tick(PLAN_LIMITS_INTERVAL_MS);
  await waitFor(() => server.getState()?.rateLimits?.at === '2026-09-17T12:02:00.000Z');
  assert.equal(reads, 2);
  const saved = JSON.parse(await readFile(join(repo, '.hive', 'state.json'), 'utf8')) as State;
  assert.deepEqual(saved.rateLimits, server.getState()?.rateLimits, 'persisted like any other reading');
  assert.equal(server.getState()?.error, undefined);
});

test('a reader that rejects keeps the last value and the Hive going; the reason is logged once per change and the recovery once', async (t) => {
  const { log, lines } = fakeLog();
  let failWith: string | undefined = NO_TOKEN;
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const server = createServer({
    repo, boardFactory: fakeBoardFactory().factory, spawnWorker: fakeSpawn().spawn, log,
    readPlanLimits: async () => { if (failWith) throw new Error(failWith); return PLAN; },
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  const planLines = (): string[] => lines.filter((l) => l.includes('plan limits'));
  assert.equal((await postJson(`http://127.0.0.1:${port}/setup`, { ...BODY, maxConcurrent: 0 })).status, 200, 'setup succeeds without limits');
  assert.equal(server.getState()?.rateLimits, undefined);
  assert.equal(server.getState()?.error, undefined, 'never the error bar: an API-key user has no token, by design');
  assert.deepEqual(planLines(), [`INFO plan limits: ${NO_TOKEN}`]);
  await server.refreshPlanLimits();
  assert.deepEqual(planLines(), [`INFO plan limits: ${NO_TOKEN}`], 'same reason again: silent');
  failWith = 'HTTP 401';
  await server.refreshPlanLimits();
  assert.deepEqual(planLines(), [`INFO plan limits: ${NO_TOKEN}`, 'INFO plan limits: HTTP 401']);
  failWith = undefined;
  await server.refreshPlanLimits();
  assert.deepEqual(server.getState()?.rateLimits, PLAN);
  assert.deepEqual(planLines().at(-1), 'INFO plan limits: ok');
  await server.refreshPlanLimits();
  assert.equal(planLines().length, 3, 'a success after a success logs nothing');
  failWith = 'HTTP 401';
  await server.refreshPlanLimits();
  assert.deepEqual(server.getState()?.rateLimits, PLAN, 'the last value stays');
  assert.ok(!lines.some((l) => l.startsWith('ERROR')), lines.filter((l) => l.startsWith('ERROR')).join('\n'));
});

test('without a readPlanLimits dep the server never reads the plan limits and logs nothing about them', async (t) => {
  const { log, lines } = fakeLog();
  const { server } = await start(t, BODY, log);
  await server.refreshPlanLimits();
  assert.equal(server.getState()?.rateLimits, undefined);
  assert.ok(!lines.some((l) => l.includes('plan limits')), lines.join('\n'));
});

test('POST /cards/:id/start under yellow opens the card in the pool with its slug, marked manualStart; 404 for an unknown card, 409 before the setup', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ repo, boardFactory: fakeBoardFactory().factory, spawnWorker: spawn });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/cards/I1/start`)).status, 409, 'not configured');
  assert.equal((await postJson(`${base}/setup`, { ...BODY, maxConcurrent: 2 })).status, 200); // boot opens under yellow: I1 queued, nothing spawned
  assert.equal(server.getState()?.signal, 'yellow');
  assert.deepEqual(server.getState()?.cards.filter((c) => !c.slotId).map((c) => c.task.id), ['1']);
  assert.equal(workers.length, 0);
  const missing = await postJson(`${base}/cards/nope/start`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'card desconhecido' });
  assert.deepEqual(await json(postJson(`${base}/cards/I1/start`)), { ok: true });
  const slot = slot0(server);
  assert.equal(slot.status, 'working');
  assert.deepEqual(slot.lastEvent, { kind: 'manualStart' });
  assert.equal(workers.length, 1, 'the spawn ran before the answer');
  assert.equal(workers[0].launch.slug, 'hive-1-from-ready');
  assert.equal(workers[0].launch.workerId, slot.workerId);
  assert.equal(server.getState()?.cards.filter((c) => !c.slotId).length, 0);
  assert.equal(server.getState()?.signal, 'yellow', 'the signal is untouched');
  assert.equal(server.getState()?.maxConcurrent, 2, 'a free slot: nothing to raise');
});

test('POST /cards/:id/start is 409 for a blocked card and, without a free slot, unless raiseMax is true: then the max rises, persists and the worker opens', async (t) => {
  const { log, lines } = fakeLog();
  const { base, repo, server, workers } = await start(t, BODY, log); // 1 slot, I1 working
  const blocked = { itemId: 'I2', id: '2', title: 'blocked', body: '', url: 'https://github.com/acme/r/issues/2', blockedBy: ['1'] };
  const free = { itemId: 'I3', id: '3', title: 'free', body: '', url: 'https://github.com/acme/r/issues/3' };
  await server.dispatch({ type: 'poll', cards: [{ task: { itemId: 'I1', id: '1', title: 'from Ready', body: '', url: 'https://github.com/acme/r/issues/1' }, column: 'Ready' }, { task: blocked, column: 'Ready' }, { task: free, column: 'Ready' }] }); // I1 stays in its slot; no free slot, so nothing spawns
  assert.deepEqual(server.getState()?.cards.filter((c) => !c.slotId).map((c) => c.task.id), ['2', '3']);
  const refused = await postJson(`${base}/cards/I2/start`, { raiseMax: true });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'card bloqueado por 1' });
  const noSlot = await postJson(`${base}/cards/I3/start`);
  assert.equal(noSlot.status, 409);
  assert.deepEqual(await noSlot.json(), { error: 'nenhum slot livre' });
  assert.equal((await postJson(`${base}/cards/I3/start`, { raiseMax: 'yes' })).status, 409, 'only a literal true raises the max');
  assert.equal(workers.length, 1);
  assert.ok(!lines.some((l) => l.startsWith('DEBUG start')), 'a refusal never reaches the reducer');
  assert.deepEqual(await json(postJson(`${base}/cards/I3/start`, { raiseMax: true })), { ok: true });
  assert.equal(server.getState()?.maxConcurrent, 2);
  assert.equal(server.getState()?.slots.length, 2);
  const opened = server.getState()!.slots[1];
  assert.equal(opened.cardId, 'I3');
  assert.deepEqual(opened.lastEvent, { kind: 'manualStart' });
  assert.equal(workers.length, 2);
  assert.equal(workers[1].launch.slug, 'hive-3-free');
  assert.deepEqual(server.getState()?.cards.filter((c) => !c.slotId).map((c) => c.task.id), ['2']);
  assert.ok(lines.includes('DEBUG start #I3 raiseMax=true'), lines.filter((l) => l.includes('start')).join('\n'));
  assert.ok(lines.includes(`INFO slot 2: empty → working #3 worker=${opened.workerId!.slice(0, 8)}`), 'the slot that appeared occupied is a transition');
  const saved = JSON.parse(await readFile(join(repo, '.hive', 'state.json'), 'utf8')) as State;
  assert.equal(saved.maxConcurrent, 2, 'the raised max survives a restart');
  assert.equal(server.getState()?.error, undefined);
});
