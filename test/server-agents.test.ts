import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, type HiveServer, type ServerDeps } from '../src/server.js';
import { runArgs, ptyCommand } from '../src/spawn.js';
import type { Activity, AgentAvailability, Task, Exec, SettingsBody, SettingsInfo, Worker } from '../src/types.js';
import { activityOf } from '../src/activities.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT, SPAWN_FAILED } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, STAGES, fakeSourceFactory, fakeSpawn, type FakeWorker, workspacesAt, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// The agent a stage run starts (#516), end to end through the server: the detection, the resolution and the refusal before any worktree.
const REFUSAL = 'agent claude is not on PATH: install it, then restart the Hive';
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true,
  defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};

interface Started { base: string; server: HiveServer; workers: FakeWorker[]; calls: string[][] }

const postJson = (url: string, body: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body) });
const task0 = (server: HiveServer): Task => server.getState()!.tasks[0];
// Its live activity (#629): the run fields
const work0 = (server: HiveServer): Activity | undefined => activityOf(server.getState()!, task0(server).item.itemId);
const worker0 = (server: HiveServer): Worker => server.getState()!.workers[0];

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

// `cap` is the state's worker cap: one by default, so the fake source's task starts
async function start(t: TestContext, body: Omit<SettingsBody, 'workspaces'> = BODY, extra: Partial<ServerDeps> = {}, cap = 1): Promise<Started> {
  const { home, repo } = await tempHive(t, cap);
  const { spawn, workers } = fakeSpawn();
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: '' };
  };
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec, ...extra });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { workspaces: workspacesAt(repo), ...body })).status, 200);
  await server.poll();
  await server.dispatch({ type: 'setSignal', signal: 'green' });
  return { base, server, workers, calls };
}

test('an agent boot did not find is refused before any worktree: the task keeps the reason, no worker starts and the worker frees (#516)', async (t) => {
  const { server, workers, calls } = await start(t, BODY, { agents: [{ agent: 'claude', available: false }] });
  await waitFor(() => work0(server)?.error !== undefined);
  assert.equal(work0(server)?.error, SPAWN_FAILED + REFUSAL);
  assert.equal(workers.length, 0, 'nothing was launched');
  assert.equal(worker0(server).status, 'empty', 'the worker is free again');
  assert.equal(calls.some((c) => c.includes('worktree')), false, 'no worktree step ran');
});

test("a stage's agent and modelo reach the launch as typed; claude's command line is unchanged (#516)", async (t) => {
  const stage = { ...STAGES[0], agent: 'claude' as const, model: 'sonnet' };
  const { server, workers } = await start(t, { ...BODY, stages: [stage] });
  await waitFor(() => workers.length === 1);
  const { launch } = workers[0];
  assert.deepEqual(launch.args, runArgs(work0(server)!, stage, 'new', [], 'claude'));
  assert.deepEqual(launch.args.slice(0, 2), ['--model', 'sonnet']);
  assert.match(ptyCommand(launch), /^cd '[^']+' && HIVE_PTY_ID=\S+ HIVE_PORT=\d+ claude /);
});

test('GET /settings lists the agents found on boot; without detection every agent is available (#516)', async (t) => {
  const agents: AgentAvailability[] = [{ agent: 'claude', available: false }];
  const detected = await start(t, BODY, { agents }, 0);
  assert.deepEqual(((await (await hiveFetch(`${detected.base}/settings`)).json()) as SettingsInfo).agents, agents);
  const plain = await start(t, BODY, {}, 0);
  assert.deepEqual(((await (await hiveFetch(`${plain.base}/settings`)).json()) as SettingsInfo).agents, [{ agent: 'claude', available: true }]);
});

test('the live state holds the config\'s default agent from the first save on (#925)', async (t) => {
  const { server } = await start(t);
  assert.equal(server.getState()!.defaultAgent, 'claude');
});
