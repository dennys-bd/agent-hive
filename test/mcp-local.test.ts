import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { localActivityId } from '../src/activities.js';
import { workspaceProtocolPaths } from '../src/hooks-settings.js';
import { FORGET_DESCRIPTION, RECALL_DESCRIPTION, REMEMBER_DESCRIPTION, REVISE_DESCRIPTION } from '../src/mcp-optional.js';
import { MEMORY_FULL_MESSAGE, memoryPath } from '../src/memory.js';
import { SECRET_HEADER } from '../src/secret.js';
import { createServer } from '../src/server.js';
import type { MemoryFile, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { bodyFlows, AUTH, GITHUB_ENTRY, STAGES, WORKSPACE, fakeSourceFactory, fakeSpawn, tempHive, workspacesAt } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// The Hive's MCP as a local session meets it (#256), end to end: a workspace's local activity, a claude session opened there, no task. No
// worker (maxConcurrent 0): the only run is the session the test opened
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], flows: bodyFlows(STAGES),
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
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['benchmark_draft', 'benchmark_get', 'benchmark_list', 'hive_ask', 'hive_conventions', 'hive_create_task', 'hive_forget', 'hive_recall', 'hive_remember', 'hive_reply', 'hive_revise', 'hive_task']);
});

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const [first] = result.content;
  return { text: first?.type === 'text' ? first.text : '', isError: result.isError === true };
}

test('hive_remember from a local session saves a lesson with origin local in its activity\'s workspace, capped by its memoryCap, and local.md carries it; hive_recall reads a lesson and records the use with no task (#256, #681)', async (t) => {
  const { client, home } = await startLocal(t, 500);
  const remember = (n: string) => call(client, 'hive_remember', { kind: 'fact', description: `${n} ${'y'.repeat(140)}`, body: 'b'.repeat(4000) });
  assert.deepEqual(await remember('one'), { text: 'saved as m-1', isError: false });
  assert.deepEqual(await remember('two'), { text: 'saved as m-2', isError: false });
  assert.deepEqual(await remember('three'), { text: 'saved as m-3', isError: false }, 'the bodies count for nothing: 434 of 500');
  assert.deepEqual(await remember('four'), { text: MEMORY_FULL_MESSAGE, isError: true }, 'the workspace\'s cap of 500');
  const recalled = await call(client, 'hive_recall', { id: 'm-1' });
  assert.deepEqual([recalled.isError, JSON.parse(recalled.text)], [false, { id: 'm-1', kind: 'fact', description: `one ${'y'.repeat(140)}`, body: 'b'.repeat(4000) }]);
  const { entries } = JSON.parse(await readFile(memoryPath(home, WORKSPACE), 'utf8')) as MemoryFile;
  assert.deepEqual(entries.map((e) => e.origin), ['local', 'local', 'local']);
  const { at, ...use } = entries[0].lastUsed ?? { at: '' };
  assert.deepEqual([entries[0].uses, use], [1, {}], 'a local session\'s use names no task and no stage');
  assert.match(at, /^\d{4}-\d{2}-\d{2}T/);
  const local = await readFile(workspaceProtocolPaths(home, WORKSPACE).local, 'utf8');
  assert.ok(local.includes('## Workspace memory') && local.includes('- [m-1] one '), local);
});

test('hive_remember tells every run in the workspace gets the lesson, a local session\'s included (#256)', async (t) => {
  const { client } = await startLocal(t);
  const remember = (await client.listTools()).tools.find((tool) => tool.name === 'hive_remember');
  assert.equal(remember?.description, REMEMBER_DESCRIPTION);
  assert.match(REMEMBER_DESCRIPTION, /which the Hive gives every later run in this workspace\./);
  assert.match(REMEMBER_DESCRIPTION, /description: one line of at most 150 characters/);
  assert.match(REMEMBER_DESCRIPTION, /body: up to 4,000 characters/);
  assert.equal((await client.listTools()).tools.find((tool) => tool.name === 'hive_recall')?.description, RECALL_DESCRIPTION);
  assert.match(RECALL_DESCRIPTION, /pass its id \(m-<n>, as the memory section lists it\)/);
  assert.match(RECALL_DESCRIPTION, /the description only names the subject, the body holds the lesson\.$/);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find((tool) => tool.name === 'hive_revise')?.description, REVISE_DESCRIPTION);
  assert.equal(tools.find((tool) => tool.name === 'hive_forget')?.description, FORGET_DESCRIPTION);
  assert.match(REVISE_DESCRIPTION, /description: one line of at most 150 characters naming what the lesson is about, short and direct/);
  for (const description of [REVISE_DESCRIPTION, FORGET_DESCRIPTION]) assert.match(description, /goes to the memory's history, where the user can restore it\./);
});

test('hive_revise and hive_forget from a local session record the change as by local (#256, #683)', async (t) => {
  const { client, home } = await startLocal(t);
  await call(client, 'hive_remember', { kind: 'fact', description: 'pnpm test is the gate', body: 'the lesson' });
  assert.deepEqual(await call(client, 'hive_revise', { id: 'm-1', kind: 'pref', why: 'it is how the user wants it' }), { text: 'revised m-1', isError: false });
  assert.deepEqual(await call(client, 'hive_forget', { id: 'm-1', why: 'the user said so' }), { text: 'removed m-1', isError: false });
  const { entries, history } = JSON.parse(await readFile(memoryPath(home, WORKSPACE), 'utf8')) as MemoryFile;
  assert.deepEqual([entries, history.map((c) => [c.id, c.action, c.by, c.entry.kind])], [[], [['h-1', 'revised', 'local', 'fact'], ['h-2', 'removed', 'local', 'pref']]]);
});
