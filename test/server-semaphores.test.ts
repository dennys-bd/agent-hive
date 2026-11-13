import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSemaphores } from '../src/command-semaphores.js';
import { initialState } from '../src/orchestrator.js';
import { NOT_IN_LINE_CODE, registerSemaphoreRoutes } from '../src/server-semaphores.js';
import type { State } from '../src/types.js';

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
const acquire = async (base: string, ptyId: string | undefined, body: unknown = { argv: ['pnpm', 'test'], pid: 4242 }): Promise<string> => {
  const res = await post(`${base}/hooks/semaphores/acquire`, body, ptyId);
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

test('with no live Hive every acquire answers run (#798)', async (t) => {
  const base = await start(t, null);
  assert.equal(await acquire(base, 'R1'), 'run\n');
});

test('a bad body answers 400 and touches nothing (#798)', async (t) => {
  const base = await start(t);
  for (const body of [{}, { argv: [], pid: 1 }, { argv: ['pnpm', 1], pid: 1 }, { argv: 'pnpm test', pid: 1 }, { argv: ['pnpm'], pid: 0 }, { argv: ['pnpm'], pid: -1 }, { argv: ['pnpm'], pid: 1.5 }, { argv: ['pnpm'], pid: 1, now: false }]) {
    assert.equal((await post(`${base}/hooks/semaphores/acquire`, body, 'R1')).status, 400, JSON.stringify(body));
  }
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
