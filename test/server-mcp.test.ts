import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialsPath, readCredentials, writeCredentials } from '../src/credentials.js';
import { createServer } from '../src/server.js';
import { lockedMessage, VALUE_MESSAGE } from '../src/server-mcp.js';
import type { Config, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, STAGES, fakeSourceFactory, tempHive, WORKSPACE, workspacesAt } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// The MCP routes (#333) end to end: the route, the settings chain, hive.config.json and credentials.json. No worker (cap 0); the probe is
// injected, so nothing is spawned or called.
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000,
  trustedDomains: [],
  shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};

const DOCS = { name: 'docs', url: 'https://mcp.example.com/mcp', authHeader: 'Authorization', workspace: null, on: true };
const UP = { name: 'up', command: 'npx', args: ['up-mcp'], workspace: WORKSPACE, on: true };
const IDLE = { name: 'idle', command: 'npx', args: [], workspace: null, on: false };
const LOCKED = ['hive_done', 'hive_ask', 'hive_stop', 'hive_pr', 'hive_reply', 'hive_conventions'];

interface Started { base: string; home: string; env: NodeJS.ProcessEnv; probed: string[] }

async function start(t: TestContext, configured = true): Promise<Started> {
  const { home, repo } = await tempHive(t);
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'cred-') };
  const probed: string[] = [];
  const probeMcp = async (server: { name: string }) => { probed.push(JSON.stringify(server)); return server.name === 'up' ? 'connected' as const : 'no_answer' as const; };
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, credentialsEnv: env, probeMcp });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  if (configured) assert.equal((await send('POST', `${base}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  return { base, home, env, probed };
}

const send = (method: string, url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method, headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const answer = async (res: Promise<Response>): Promise<[number, unknown]> => { const done = await res; return [done.status, await done.json()]; };
const configFile = (home: string): string => join(home, 'hive.config.json');
const savedMcp = async (home: string): Promise<Config['mcp']> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).mcp;
// The saved file rewritten compact: every save writes it back indented, so an unchanged text proves nothing was written
async function compact(home: string): Promise<string> {
  const text = JSON.stringify(JSON.parse(await readFile(configFile(home), 'utf8')));
  await writeFile(configFile(home), text);
  return text;
}

test('GET /api/mcp answers every tool, locked first, and each server with hasValue and its state: probed when on, off never probed; the value never leaves (#333)', async (t) => {
  const { base, probed } = await start(t);
  for (const server of [UP, DOCS, IDLE]) assert.deepEqual(await answer(send('POST', `${base}/api/mcp/servers`, server)), [200, { ok: true }]);
  assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/servers/docs/value`, { value: 'Bearer t0k' })), [200, { ok: true }]);
  const text = await (await hiveFetch(`${base}/api/mcp`)).text();
  assert.equal(text.includes('t0k'), false);
  assert.deepEqual(JSON.parse(text), {
    tools: [...LOCKED.map((name) => ({ name, locked: true, on: true })), ...['hive_remember', 'hive_applied', 'hive_create_task', 'hive_task'].map((name) => ({ name, locked: false, on: true }))],
    servers: [{ ...UP, hasValue: false, state: 'connected' }, { ...DOCS, hasValue: true, state: 'no_answer' }, { ...IDLE, hasValue: false, state: 'off' }],
  });
  assert.equal(probed.some((s) => s.includes('"idle"')), false, 'a server switched off is never probed');
  assert.ok(probed.some((s) => s.includes('Bearer t0k')), 'the probe sends the stored header');
});

test('PUT /api/mcp/tools/:name turns an optional tool off and on; a locked one is a 400 that writes nothing, an unknown one a 404 (#333)', async (t) => {
  const { base, home } = await start(t);
  assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/tools/hive_remember`, { on: false })), [200, { ok: true }]);
  assert.deepEqual((await savedMcp(home)).off, ['hive_remember']);
  const before = await compact(home);
  assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/tools/hive_done`, { on: false })), [400, { error: lockedMessage('hive_done') }]);
  assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/tools/hive_nope`, { on: false })), [404, { error: 'unknown tool' }]);
  assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/tools/hive_applied`, { on: 'no' })), [400, { error: 'on must be true or false' }]);
  assert.equal(await readFile(configFile(home), 'utf8'), before, 'no write');
  assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/tools/hive_remember`, { on: true })), [200, { ok: true }]);
  assert.deepEqual((await savedMcp(home)).off, []);
});

test('POST /api/mcp/servers refuses what parseMcp refuses with its sentence and writes nothing (#333)', async (t) => {
  const { base, home } = await start(t);
  assert.equal((await send('POST', `${base}/api/mcp/servers`, DOCS)).status, 200);
  const before = await compact(home);
  const refused: [unknown, string][] = [
    [DOCS, '"mcp.servers[1].name" must be unique'],
    [{ ...DOCS, name: 'hive' }, '"mcp.servers[1].name" must be 1 to 32 lowercase letters, digits, _ or -, start with a letter, and not be hive'],
    [{ ...DOCS, name: 'b', workspace: 'gone' }, '"mcp.servers": b is scoped to gone, which no longer exists'],
    [{ ...DOCS, name: 'c', command: 'npx' }, '"mcp.servers[1]" must have exactly one of command or url'],
  ];
  for (const [server, error] of refused) assert.deepEqual(await answer(send('POST', `${base}/api/mcp/servers`, server)), [400, { error }], JSON.stringify(server));
  assert.equal(await readFile(configFile(home), 'utf8'), before, 'no write');
});

test('PUT /api/mcp/servers/:name changes a server and a rename moves its stored value; DELETE removes the server and its value; unknown names are 404 (#333)', async (t) => {
  const { base, home, env } = await start(t);
  assert.equal((await send('POST', `${base}/api/mcp/servers`, DOCS)).status, 200);
  assert.equal((await send('PUT', `${base}/api/mcp/servers/docs/value`, { value: 'Bearer t0k' })).status, 200);
  assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/servers/docs`, { ...DOCS, name: 'wiki', on: false })), [200, { ok: true }]);
  assert.deepEqual((await savedMcp(home)).servers, [{ ...DOCS, name: 'wiki', on: false }]);
  assert.deepEqual((await readCredentials(env)).mcp, { wiki: { value: 'Bearer t0k' } }, 'the value followed the rename');
  assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/servers/docs`, DOCS)), [404, { error: 'unknown server' }]);
  assert.deepEqual(await answer(send('DELETE', `${base}/api/mcp/servers/docs`)), [404, { error: 'unknown server' }]);
  assert.deepEqual(await answer(send('DELETE', `${base}/api/mcp/servers/wiki`)), [200, { ok: true }]);
  assert.deepEqual([(await savedMcp(home)).servers, (await readCredentials(env)).mcp], [[], {}]);
});

test('PUT /api/mcp/servers/:name drops the stored value when the url or authHeader changes or the server becomes a command; a toggle keeps it; POST of a new server drops a stale one (#333)', async (t) => {
  const { base, env } = await start(t);
  const stored = async (): Promise<unknown> => (await readCredentials(env)).mcp?.docs;
  await writeCredentials({ mcp: { docs: { value: 'stale' } } }, env);
  assert.equal((await send('POST', `${base}/api/mcp/servers`, DOCS)).status, 200);
  assert.equal(await stored(), undefined, 'a new server never inherits a value stored under its name');
  const edits: [string, unknown][] = [
    ['url', { ...DOCS, url: 'https://other.example.com/mcp' }], ['authHeader', { ...DOCS, authHeader: 'X-Key' }], ['command', { name: 'docs', command: 'npx', args: [], workspace: null, on: true }],
  ];
  for (const [what, edit] of edits) {
    assert.equal((await send('PUT', `${base}/api/mcp/servers/docs`, DOCS)).status, 200);
    assert.equal((await send('PUT', `${base}/api/mcp/servers/docs/value`, { value: 'Bearer t0k' })).status, 200);
    assert.equal((await send('PUT', `${base}/api/mcp/servers/docs`, { ...DOCS, on: false })).status, 200);
    assert.deepEqual(await stored(), { value: 'Bearer t0k' }, 'a toggle keeps it');
    assert.equal((await send('PUT', `${base}/api/mcp/servers/docs`, edit)).status, 200, what);
    assert.equal(await stored(), undefined, `${what} changed: the value is dropped`);
  }
});

test('DELETE /api/mcp/servers/:name/value answers 404 for an unknown server (#333)', async (t) => {
  const { base } = await start(t);
  assert.deepEqual(await answer(send('DELETE', `${base}/api/mcp/servers/ghost/value`)), [404, { error: 'unknown server' }]);
});

test('a stored value that cannot be updated after the config was written is a 500 that says so and never carries the value (#333)', async (t) => {
  const { base, home, env } = await start(t);
  assert.equal((await send('POST', `${base}/api/mcp/servers`, DOCS)).status, 200);
  assert.equal((await send('PUT', `${base}/api/mcp/servers/docs/value`, { value: 'Bearer t0k' })).status, 200);
  await rm(credentialsPath(env));
  await mkdir(credentialsPath(env)); // a directory where the file was: the write fails
  const [status, body] = await answer(send('DELETE', `${base}/api/mcp/servers/docs`));
  assert.equal(status, 500);
  assert.equal((body as { error: string }).error, 'the config was saved, but the stored value could not be updated');
  assert.deepEqual((await savedMcp(home)).servers, [], 'the config was written');
});

test('PUT /api/mcp/servers/:name/value stores the value in credentials.json and never in hive.config.json; DELETE removes it (#333)', async (t) => {
  const { base, home, env } = await start(t);
  for (const server of [DOCS, UP, { ...DOCS, name: 'open', authHeader: undefined }]) assert.equal((await send('POST', `${base}/api/mcp/servers`, server)).status, 200);
  for (const value of ['', 'a\nb', 'x'.repeat(4097), 7]) {
    assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/servers/docs/value`, { value })), [400, { error: VALUE_MESSAGE }], JSON.stringify(value).slice(0, 20));
  }
  assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/servers/ghost/value`, { value: 'v' })), [404, { error: 'unknown server' }]);
  for (const name of ['up', 'open']) {
    assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/servers/${name}/value`, { value: 'v' })), [400, { error: `${name} takes no header value: only a url server with authHeader has one` }]);
  }
  assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/servers/docs/value`, { value: 'Bearer t0k' })), [200, { ok: true }]);
  assert.deepEqual((await readCredentials(env)).mcp, { docs: { value: 'Bearer t0k' } });
  assert.equal((await readFile(configFile(home), 'utf8')).includes('t0k'), false);
  assert.deepEqual(await answer(send('DELETE', `${base}/api/mcp/servers/docs/value`)), [200, { ok: true }]);
  assert.deepEqual((await readCredentials(env)).mcp, {});
});

test('the MCP routes before a setup answer as every live route does, and write nothing (#333)', async (t) => {
  const { base, home } = await start(t, false);
  assert.deepEqual(await answer(send('PUT', `${base}/api/mcp/tools/hive_remember`, { on: false })), [409, { error: 'Hive não configurado: salve as configurações primeiro' }]);
  assert.equal((await hiveFetch(`${base}/api/mcp`)).status, 409);
  await assert.rejects(readFile(configFile(home)), 'no file');
});
