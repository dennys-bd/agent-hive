import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, type HiveServer, type ServerDeps } from '../src/server.js';
import type { RateLimits, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, STAGES, fakeSourceFactory, fakeSpawn, workspacesAt, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// POST /plan-limits/refresh: the header's refresh button, a reading on demand that replaces the held one instead of merging into it
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true,
  defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};
const RESET = '2026-09-21T00:00:00.000Z';
const reading = (percent: number, at: string): RateLimits => ({ at, windows: { seven_day: { usedPercent: percent, resetsAt: RESET } } });
const HIGH = reading(95, '2026-09-17T12:00:00.000Z');
const AFTER_UPGRADE = reading(40, '2026-09-17T12:10:00.000Z'); // a bigger plan: same window, lower percent

const postJson = (url: string, body: unknown = {}): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body) });

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

async function start(t: TestContext, extra: Partial<ServerDeps>, configure = true): Promise<{ base: string; server: HiveServer }> {
  const { home, repo } = await tempHive(t);
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, exec: async () => ({ stdout: '' }), ...extra });
  const base = `http://127.0.0.1:${await server.listen(0)}`;
  t.after(() => server.close());
  if (configure) assert.equal((await postJson(`${base}/settings`, { workspaces: workspacesAt(repo), ...BODY })).status, 200);
  return { base, server };
}

test('POST /plan-limits/refresh replaces the held reading: a lower percent in the same window wins, which the timer\'s merge never lets in', async (t) => {
  let next = HIGH;
  const { base, server } = await start(t, { readPlanLimits: async () => next });
  await waitFor(() => server.getState()?.rateLimits?.at === HIGH.at); // the background read after the save
  next = AFTER_UPGRADE;
  await server.refreshPlanLimits();
  assert.equal(server.getState()?.rateLimits?.windows.seven_day.usedPercent, 95, 'the timer merges: the higher percent stands');
  const res = await postJson(`${base}/plan-limits/refresh`);
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(server.getState()?.rateLimits, AFTER_UPGRADE);
});

test('POST /plan-limits/refresh answers 502 with the reader\'s reason and keeps the held reading', async (t) => {
  let failWith: string | undefined;
  const { base, server } = await start(t, { readPlanLimits: async () => { if (failWith) throw new Error(failWith); return HIGH; } });
  await waitFor(() => server.getState()?.rateLimits !== undefined);
  failWith = 'HTTP 429';
  const res = await postJson(`${base}/plan-limits/refresh`);
  assert.deepEqual([res.status, await res.json()], [502, { error: 'HTTP 429' }]);
  assert.deepEqual(server.getState()?.rateLimits, HIGH);
});

test('POST /plan-limits/refresh answers 502 when the endpoint brings no plan window, and keeps the held reading', async (t) => {
  let next: RateLimits | undefined = HIGH;
  const { base, server } = await start(t, { readPlanLimits: async () => next });
  await waitFor(() => server.getState()?.rateLimits !== undefined);
  next = undefined;
  const res = await postJson(`${base}/plan-limits/refresh`);
  assert.deepEqual([res.status, await res.json()], [502, { error: 'the usage endpoint answered no plan window' }]);
  assert.deepEqual(server.getState()?.rateLimits, HIGH);
});

test('POST /plan-limits/refresh is 501 without a reader and 409 before the settings', async (t) => {
  const bare = await start(t, {});
  assert.equal((await postJson(`${bare.base}/plan-limits/refresh`)).status, 501);
  const unset = await start(t, { readPlanLimits: async () => HIGH }, false);
  assert.equal((await postJson(`${unset.base}/plan-limits/refresh`)).status, 409);
});
