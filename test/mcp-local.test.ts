import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { localActivityId } from '../src/activities.js';
import { SECRET_HEADER } from '../src/secret.js';
import { createServer } from '../src/server.js';
import type { SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, STAGES, WORKSPACE, fakeSourceFactory, fakeSpawn, tempHive, workspacesAt } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// The Hive's MCP as a local session meets it (#256), end to end: a workspace's local activity, a claude session opened there, no task. No
// worker (maxConcurrent 0): the only run is the session the test opened
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};

interface Local { client: Client; home: string }

// A Hive whose one workspace has `memoryCap` and a local claude session running; the client speaks as that session
async function startLocal(t: TestContext, memoryCap = 4000): Promise<Local> {
  const { home, repo } = await tempHive(t);
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, exec: async () => ({ stdout: '' }) });
  const base = `http://127.0.0.1:${await server.listen(0)}`;
  t.after(() => server.close());
  const workspaces = workspacesAt(repo).map((w) => ({ ...w, memoryCap })); // what the workspace card saves (#73)
  const saved = await hiveFetch(`${base}/settings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify({ ...BODY, workspaces }) });
  assert.equal(saved.status, 200);
  await server.dispatch({ type: 'newLocalSession', activityId: localActivityId(WORKSPACE) });
  const local = server.getState()?.workers.find((w) => w.activityId === localActivityId(WORKSPACE) && w.status !== 'empty');
  assert.ok(local?.runId !== undefined, 'the local session runs');
  const client = new Client({ name: 'hive-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/hooks/mcp`), { requestInit: { headers: { [SECRET_HEADER]: SECRET, 'x-hive-pty': local.runId } } }));
  t.after(() => client.close());
  return { client, home };
}

test('a local session is offered every tool but hive_done, hive_pr and hive_stop: its tools match its protocol, and it cannot stop a session the user drives (#256)', async (t) => {
  const { client } = await startLocal(t);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['hive_applied', 'hive_ask', 'hive_conventions', 'hive_create_task', 'hive_remember', 'hive_reply']);
});
