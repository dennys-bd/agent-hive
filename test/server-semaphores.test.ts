import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSemaphores } from '../src/command-semaphores.js';
import { initialState } from '../src/orchestrator.js';
import { NOT_IN_LINE_CODE, registerSemaphoreRoutes } from '../src/server-semaphores.js';
import type { State } from '../src/types.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { localActivityId } from '../src/activities.js';
import { parseConfig } from '../src/config.js';
import { createSources } from '../src/source.js';
import { createServer, type HiveServer } from '../src/server.js';
import type { OpenResult, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../src/types.js';
import { AUTH, bodyFlows, combConfig, fakeSourceFactory, fakeSpawn, type FakeWorker, GITHUB_ENTRY, STAGES, tempHive, WORKSPACE, workspacesAt } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

const MEMORY = { name: 'memory', limit: 1, reservation: '2m' };
const TEST_COMMAND = { name: 'test', impls: [{ workspace: null, command: 'pnpm test', semaphore: 'memory' }], menu: true, env: {} };
// R1, R2: two agents' runs; T1: a terminal; C1: a commands stage's command; all in api
const STATE: State = {
  ...initialState(0),
  activities: [
    { id: 'A1', kind: 'task', workspace: 'api' },
    { id: 'A2', kind: 'task', workspace: 'api', commands: { stage: 'Check', at: 0, ptyId: 'C1', runId: 'C1', failed: [], workerId: 'w0', started: [] } },
  ],
  workers: [{ id: 'w1', status: 'working', runId: 'R1', activityId: 'A1' }, { id: 'w2', status: 'working', runId: 'R2', activityId: 'A1' }],
  terminals: [{ terminalId: 'T1', activityId: 'A1', startedAt: '2026-11-13T10:00:00.000Z', cwd: '/w' }],
};

// The routes alone on a bare app: the secret gate and the JSON parser are server.ts', tested there
// null: no live Hive (setup mode); undefined would take the default
async function start(t: TestContext, state: State | null = STATE): Promise<string> {
  const semaphores = createSemaphores({ config: { commandSemaphores: [MEMORY], comb: { commands: [TEST_COMMAND] } }, dispatch: () => {}, now: Date.now, pidAlive: () => true });
  const app = express();
  app.use(express.json());
  registerSemaphoreRoutes(app, { state: () => state ?? undefined, semaphores: () => semaphores });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  t.after(() => { semaphores.stop(); server.close(); });
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
}

const post = (url: string, body: unknown, ptyId?: string): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(ptyId === undefined ? {} : { 'x-hive-pty': ptyId }) }, body: JSON.stringify(body) });
// The shim's form (#800): one arg field per argv word, then pid, then anything extra
const acquireForm = (argv: readonly string[], pid: number | string, extra: [string, string][] = []): URLSearchParams =>
  new URLSearchParams([...argv.map((a): [string, string] => ['arg', a]), ['pid', String(pid)], ...extra]);
const postForm = (url: string, form: URLSearchParams, ptyId?: string): Promise<Response> =>
  fetch(url, { method: 'POST', headers: ptyId === undefined ? {} : { 'x-hive-pty': ptyId }, body: form });
const acquire = async (base: string, ptyId: string | undefined, form = acquireForm(['pnpm', 'test'], 4242)): Promise<string> => {
  const res = await postForm(`${base}/hooks/semaphores/acquire`, form, ptyId);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
  return res.text();
};

test('acquire answers plain lines: a grant names its semaphore, an agent is refused, a terminal and a commands stage wait, an unknown pty runs (#798)', async (t) => {
  const base = await start(t);
  assert.equal(await acquire(base, 'R1'), 'run memory\n');
  assert.equal(await acquire(base, 'R2'), 'refused memory 1\n');
  assert.equal(await acquire(base, 'T1'), 'wait memory 2\n');
  assert.equal(await acquire(base, 'C1'), 'wait memory 3\n', 'a command the Hive runs itself waits');
  assert.equal(await acquire(base, 'nobody'), 'run\n', 'a pty the daemon does not know runs');
  assert.equal(await acquire(base, undefined), 'run\n');
  assert.equal((await post(`${base}/hooks/semaphores/release`, { semaphore: 'memory' }, 'R1')).status, 204);
  assert.equal(await acquire(base, 'R2'), 'run memory\n', 'the release gave R2 its turn');
});

test('acquire reads the shim\'s form: each arg field whole, in order, a space, a line break and an & included (#800)', async (t) => {
  const base = await start(t);
  assert.equal(await acquire(base, 'R1', acquireForm(['pnpm', 'test', 'a b', 'x\ny', 'p&q=r'], 4242)), 'run memory\n', 'pnpm test is the prefix');
  assert.equal(await acquire(base, 'R2', acquireForm(['pnpm', 'lint'], 4243)), 'run\n', 'no line matches pnpm lint');
});

test('with no live Hive every acquire answers run (#798)', async (t) => {
  const base = await start(t, null);
  assert.equal(await acquire(base, 'R1'), 'run\n');
});

test('a bad body answers 400 and touches nothing (#798)', async (t) => {
  const base = await start(t);
  const url = `${base}/hooks/semaphores/acquire`;
  const bad = [
    new URLSearchParams(), new URLSearchParams([['pid', '1']]), // nothing; no arg
    acquireForm(['pnpm'], 0), acquireForm(['pnpm'], -1), acquireForm(['pnpm'], '1.5'), acquireForm(['pnpm'], 'abc'), acquireForm(['pnpm'], ''),
    acquireForm(['pnpm'], 1, [['pid', '2']]), acquireForm(['pnpm'], 1, [['now', 'false']]),
  ];
  for (const form of bad) assert.equal((await postForm(url, form, 'R1')).status, 400, form.toString());
  assert.equal((await post(url, { argv: ['pnpm', 'test'], pid: 1 }, 'R1')).status, 400, '#798\'s JSON body is no form');
  for (const body of [{}, { semaphore: 1 }]) assert.equal((await post(`${base}/hooks/semaphores/release`, body, 'R1')).status, 400, JSON.stringify(body));
  for (const body of [{}, { ptyId: '' }, { ptyId: 7 }]) assert.equal((await post(`${base}/api/semaphores/memory/run-now`, body)).status, 400, JSON.stringify(body));
  assert.equal(await acquire(base, 'R1'), 'run memory\n', 'nothing was held');
});

test('run now grants a place its turn above the limit; a pty with no place answers 409 (#798)', async (t) => {
  const base = await start(t);
  await acquire(base, 'R1');
  assert.equal(await acquire(base, 'T1'), 'wait memory 1\n');
  const ok = await post(`${base}/api/semaphores/memory/run-now`, { ptyId: 'T1' });
  assert.deepEqual([ok.status, await ok.json()], [200, { ok: true }]);
  assert.equal(await acquire(base, 'T1'), 'run memory\n');
  for (const [name, ptyId] of [['memory', 'R2'], ['gone', 'T1']]) {
    const refused = await post(`${base}/api/semaphores/${name}/run-now`, { ptyId });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code?: string }).code, NOT_IN_LINE_CODE);
  }
});

test('acquire refuses a pid above 2**31 - 1 and an argv beyond 256 items or 4096 chars with 400 (#798)', async (t) => {
  const base = await start(t);
  const forms = [acquireForm(['pnpm'], 2 ** 31), acquireForm(Array.from({ length: 257 }, () => 'a'), 1), acquireForm(['a'.repeat(4097)], 1)];
  for (const form of forms) assert.equal((await postForm(`${base}/hooks/semaphores/acquire`, form, 'R1')).status, 400);
  assert.equal(await acquire(base, 'R1', acquireForm(['pnpm', 'test', ...Array.from({ length: 253 }, () => 'a'), 'a'.repeat(4096)], 2 ** 31 - 1)), 'run memory\n', 'the bounds themselves pass');
});

test('run now from a pty (x-hive-pty) answers 403 (#798)', async (t) => {
  const base = await start(t);
  await acquire(base, 'R1');
  await acquire(base, 'T1');
  assert.equal((await post(`${base}/api/semaphores/memory/run-now`, { ptyId: 'T1' }, 'R1')).status, 403);
  assert.equal((await post(`${base}/api/semaphores/memory/run-now`, { ptyId: 'T1' })).status, 200);
});

// The whole server (#798): BODY is test/server-terminals.test.ts' (line 17) with memory and a line in it
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], flows: bodyFlows(STAGES),
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} },
  commands: [TEST_COMMAND], commandSemaphores: [MEMORY],
};
const LOCAL = encodeURIComponent(localActivityId(WORKSPACE));
const postUi = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const hook = (url: string, ptyId: string, body: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-pty': ptyId }, body: JSON.stringify(body) });
const acquireLive = async (base: string, ptyId: string): Promise<string> =>
  (await hiveFetch(`${base}/hooks/semaphores/acquire`, { method: 'POST', headers: { 'x-hive-pty': ptyId }, body: acquireForm(['pnpm', 'test'], process.pid) })).text();

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

async function startHive(t: TestContext): Promise<{ base: string; server: HiveServer; workers: FakeWorker[]; repo: string }> {
  const { home, repo } = await tempHive(t);
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec: async () => ({ stdout: '' }) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postUi(`${base}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  return { base, server, workers, repo };
}
const openShell = async (base: string): Promise<string> => ((await (await postUi(`${base}/activities/${LOCAL}/shell`)).json()) as OpenResult).ptyId ?? '';

test('the server mounts the line: a terminal\'s pty end frees its permit for the next one\'s turn, and a save that removes the semaphore empties State (#798)', async (t) => {
  const { base, server, workers, repo } = await startHive(t);
  assert.deepEqual(server.getState()?.semaphores, { memory: { runs: [], line: [] } }, 'created with the config, every semaphore free');
  const first = await openShell(base);
  const second = await openShell(base);
  assert.equal(await acquireLive(base, first), 'run memory\n');
  assert.equal(await acquireLive(base, second), 'wait memory 1\n');
  assert.deepEqual(server.getState()?.semaphores.memory, { runs: [first], line: [{ ptyId: second, place: 1 }] });
  workers.find((w) => w.launch.ptyId === first)?.handlers.onExit();
  await waitFor(() => server.getState()?.semaphores.memory?.runs.length === 0);
  assert.equal(server.getState()?.semaphores.memory?.line[0]?.place, 0, 'the pool\'s exit gave the waiting one its turn');
  const saved = await postUi(`${base}/settings`, { ...BODY, commands: [], commandSemaphores: [], workspaces: workspacesAt(repo) });
  assert.equal(saved.status, 200);
  await waitFor(() => isDeepStrictEqual(server.getState()?.semaphores, {}));
});

test('a captured session\'s exit frees what its run holds, as the terminal\'s own end does (#798)', async (t) => {
  const { base, server } = await startHive(t);
  const terminal = await openShell(base);
  const registered = await hiveFetch(`${base}/hooks/terminals/${terminal}/session`, { method: 'POST', body: new URLSearchParams({ agent: 'claude' }) });
  const runId = (await registered.text()).split('\n')[0] ?? '';
  assert.equal(await acquireLive(base, runId), 'run memory\n', 'the run\'s id reads as an agent\'s pty');
  await hook(`${base}/hooks/exit`, runId, {});
  await waitFor(() => server.getState()?.semaphores.memory?.runs.length === 0);
});

// hive.ts starts the server with its saved config and State, skipping configure(): the semaphores are created there too
test('a Hive started with its config and State has its semaphores from the first request (#798)', async (t) => {
  const { home, repo } = await tempHive(t);
  const { factory } = fakeSourceFactory();
  const config = parseConfig(combConfig({ sources: [GITHUB_ENTRY], path: repo, commands: [TEST_COMMAND], commandSemaphores: [MEMORY] }));
  const { spawn } = fakeSpawn();
  const server = createServer({ secret: SECRET, home, sourceFactory: factory, launchPty: spawn, exec: async () => ({ stdout: '' }), runtime: { config, sources: createSources(config, factory) }, state: { ...initialState(0), workspaces: [WORKSPACE] } });
  await server.listen(0);
  t.after(() => server.close());
  await waitFor(() => isDeepStrictEqual(server.getState()?.semaphores, { memory: { runs: [], line: [] } }));
});
