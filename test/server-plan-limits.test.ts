import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, type HiveServer, type ServerDeps } from '../src/server.js';
import type { AgentId, PlanLimitsReport, RateLimits, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, STAGES, fakeSourceFactory, fakeSpawn, workspacesAt, tempHive, claudePlan, claudePlanFailure, fakeLog } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// POST /plan-limits/refresh: the usage group's ↻ (#223), a reading on demand that replaces the held one instead of merging into it
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
  const { base, server } = await start(t, { readPlanLimits: async () => claudePlan(next) });
  await waitFor(() => server.getState()?.rateLimits?.claude?.at === HIGH.at); // the background read after the save
  next = AFTER_UPGRADE;
  await server.refreshPlanLimits();
  assert.equal(server.getState()?.rateLimits?.claude?.windows.seven_day.usedPercent, 95, 'the timer merges: the higher percent stands');
  const res = await postJson(`${base}/plan-limits/refresh`);
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(server.getState()?.rateLimits?.claude, AFTER_UPGRADE);
});

test('POST /plan-limits/refresh answers 502 with the reader\'s reason and keeps the held reading', async (t) => {
  let failWith: string | undefined;
  const { base, server } = await start(t, { readPlanLimits: async () => (failWith ? claudePlanFailure(failWith) : claudePlan(HIGH)) });
  await waitFor(() => server.getState()?.rateLimits !== undefined);
  failWith = 'HTTP 429';
  const res = await postJson(`${base}/plan-limits/refresh`);
  assert.deepEqual([res.status, await res.json()], [502, { error: 'HTTP 429' }]);
  assert.deepEqual(server.getState()?.rateLimits?.claude, HIGH);
});

test('POST /plan-limits/refresh answers 502 when the endpoint brings no plan window, and keeps the held reading', async (t) => {
  let next: RateLimits | undefined = HIGH;
  const { base, server } = await start(t, { readPlanLimits: async () => claudePlan(next) });
  await waitFor(() => server.getState()?.rateLimits !== undefined);
  next = undefined;
  const res = await postJson(`${base}/plan-limits/refresh`);
  assert.deepEqual([res.status, await res.json()], [502, { error: 'the usage endpoint answered no plan window' }]);
  assert.deepEqual(server.getState()?.rateLimits?.claude, HIGH);
});

test('POST /plan-limits/refresh is 501 without a reader and 409 before the settings', async (t) => {
  const bare = await start(t, {});
  assert.equal((await postJson(`${bare.base}/plan-limits/refresh`)).status, 501);
  const unset = await start(t, { readPlanLimits: async () => claudePlan(HIGH) }, false);
  assert.equal((await postJson(`${unset.base}/plan-limits/refresh`)).status, 409);
});

test('the refresh dispatches one reading per agent and answers ok while any agent gave one; a failing agent keeps its last reading (#929)', async (t) => {
  const codex: RateLimits = { at: HIGH.at, windows: { thirty_day: { usedPercent: 40, resetsAt: RESET } } };
  let report: PlanLimitsReport = { readings: [{ agent: 'claude', rateLimits: HIGH }, { agent: 'codex', rateLimits: codex }], failures: [] };
  const { base, server } = await start(t, { readPlanLimits: async () => report });
  await waitFor(() => server.getState()?.rateLimits?.codex !== undefined);
  assert.deepEqual(server.getState()?.rateLimits, { claude: HIGH, codex });
  const later: RateLimits = { ...codex, at: AFTER_UPGRADE.at };
  report = { readings: [{ agent: 'codex', rateLimits: later }], failures: [{ agent: 'claude', reason: 'HTTP 429' }] };
  const res = await postJson(`${base}/plan-limits/refresh`);
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(server.getState()?.rateLimits, { claude: HIGH, codex: later });
});

test('{ agent } reads that agent only and replaces only its reading; {} reads every agent (#223)', async (t) => {
  const codex: RateLimits = { at: HIGH.at, windows: { thirty_day: { usedPercent: 40, resetsAt: RESET } } };
  const codexLater: RateLimits = { at: AFTER_UPGRADE.at, windows: { thirty_day: { usedPercent: 12, resetsAt: RESET } } };
  let held: Record<AgentId, RateLimits> = { claude: HIGH, codex };
  const asked: (readonly AgentId[] | undefined)[] = [];
  const readPlanLimits = async (agents?: readonly AgentId[]): Promise<PlanLimitsReport> => {
    asked.push(agents);
    return { readings: (agents ?? (['claude', 'codex'] as const)).map((agent) => ({ agent, rateLimits: held[agent] })), failures: [] };
  };
  const { base, server } = await start(t, { readPlanLimits });
  await waitFor(() => server.getState()?.rateLimits?.codex !== undefined); // the background read after the save
  held = { claude: AFTER_UPGRADE, codex: codexLater };
  const one = await postJson(`${base}/plan-limits/refresh`, { agent: 'codex' });
  assert.deepEqual([one.status, await one.json()], [200, { ok: true }]);
  assert.deepEqual(asked.at(-1), ['codex']);
  assert.deepEqual(server.getState()?.rateLimits, { claude: HIGH, codex: codexLater }, 'claude keeps its held reading');
  const all = await postJson(`${base}/plan-limits/refresh`, {});
  assert.deepEqual([all.status, await all.json()], [200, { ok: true }]);
  assert.equal(asked.at(-1), undefined, 'no list: every agent with plan limits');
  assert.deepEqual(server.getState()?.rateLimits, { claude: AFTER_UPGRADE, codex: codexLater });
});

test('{ agent } that is not an agent with plan limits answers 400 and reads nothing (#223)', async (t) => {
  let reads = 0;
  const { base, server } = await start(t, { readPlanLimits: async () => { reads += 1; return claudePlan(HIGH); } });
  await waitFor(() => server.getState()?.rateLimits?.claude !== undefined);
  const before = reads;
  for (const agent of ['nope', 42, null]) {
    const res = await postJson(`${base}/plan-limits/refresh`, { agent });
    assert.deepEqual([res.status, await res.json()], [400, { error: 'agent has no plan limits' }], String(agent));
  }
  assert.equal(reads, before);
});

test('a one-agent refresh logs only that agent\'s reason: another agent\'s logged failure stays as it was (#223)', async (t) => {
  const { log, lines } = fakeLog();
  const codex: RateLimits = { at: HIGH.at, windows: { thirty_day: { usedPercent: 40, resetsAt: RESET } } };
  const readPlanLimits = async (agents?: readonly AgentId[]): Promise<PlanLimitsReport> => ({
    readings: [{ agent: 'codex', rateLimits: codex }],
    failures: agents === undefined || agents.includes('claude') ? [{ agent: 'claude', reason: 'HTTP 429' }] : [],
  });
  const { server } = await start(t, { readPlanLimits, log });
  const planLines = (): string[] => lines.filter((l) => l.includes('plan limits'));
  await waitFor(() => planLines().length > 0);
  await server.refreshPlanLimits(true, ['codex']);
  assert.deepEqual(planLines(), ['INFO plan limits claude: HTTP 429'], 'never "claude: ok" from a read that did not read claude');
});
