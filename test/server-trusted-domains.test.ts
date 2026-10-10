import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { HOST_MESSAGE } from '../src/server-trusted-domains.js';
import type { Config, SettingsBody, SettingsInfo } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, STAGES, fakeSourceFactory, workspacesAt, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// POST /trusted-domains (#404), the terminal link dialog's "always trust", end to end: the route, the POST /settings chain and the file.
// No worker (maxConcurrent 0): nothing ever spawns.
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000,
  trustedDomains: ['github.com'],
  shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const answer = async (res: Promise<Response>): Promise<[number, unknown]> => {
  const done = await res;
  return [done.status, await done.json()];
};
const configFile = (home: string): string => join(home, 'hive.config.json');
const saved = async (home: string): Promise<Config> => JSON.parse(await readFile(configFile(home), 'utf8')) as Config;

interface Started { base: string; home: string; repo: string }

// A Hive saved with BODY, or left in setup mode; resolveDelayMs slows every save's source check, so two saves overlap.
async function start(t: TestContext, { configured = true, resolveDelayMs = 0 } = {}): Promise<Started> {
  const { home, repo } = await tempHive(t);
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory(resolveDelayMs).factory });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  if (configured) assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  return { base, home, repo };
}

// The saved file rewritten compact: every save writes it back indented, so an unchanged text proves nothing was written.
async function compact(home: string): Promise<string> {
  const text = JSON.stringify(JSON.parse(await readFile(configFile(home), 'utf8')));
  await writeFile(configFile(home), text);
  return text;
}

test('POST /trusted-domains adds the host, trimmed and lowercased, to hive.config.json and GET /settings; a host already on the list answers ok and writes nothing (#404)', async (t) => {
  const { base, home } = await start(t);
  assert.deepEqual(await answer(postJson(`${base}/trusted-domains`, { host: ' Docs.Example.com ' })), [200, { ok: true }]);
  assert.deepEqual((await saved(home)).trustedDomains, ['github.com', 'docs.example.com']);
  const info = (await (await hiveFetch(`${base}/settings`)).json()) as SettingsInfo;
  assert.deepEqual(info.config?.trustedDomains, ['github.com', 'docs.example.com'], 'the running Hive has it: a page reading GET /settings trusts it');
  const before = await compact(home);
  assert.deepEqual(await answer(postJson(`${base}/trusted-domains`, { host: 'github.com' })), [200, { ok: true }]);
  assert.equal(await readFile(configFile(home), 'utf8'), before, 'no write');
});

test('POST /trusted-domains refuses what is not a bare host with a 400 and writes nothing (#404)', async (t) => {
  const { base, home } = await start(t);
  const before = await compact(home);
  for (const host of [undefined, 42, '', '  ', 'https://github.com', 'github.com:443', 'github.com/issues', '*.github.com', '-github.com']) {
    assert.deepEqual(await answer(postJson(`${base}/trusted-domains`, { host })), [400, { error: HOST_MESSAGE }], JSON.stringify(host));
  }
  assert.equal(await readFile(configFile(home), 'utf8'), before, 'no write');
});

test('POST /trusted-domains before a setup answers as every live route does, and writes nothing (#404)', async (t) => {
  const { base, home } = await start(t, { configured: false });
  assert.deepEqual(await answer(postJson(`${base}/trusted-domains`, { host: 'github.com' })), [409, { error: 'Hive não configurado: salve as configurações primeiro' }]);
  await assert.rejects(readFile(configFile(home)), 'no file');
});

test('a trust sent while a Settings save is still running waits for it and lands on the list that save wrote (#404)', async (t) => {
  const { base, home, repo } = await start(t, { resolveDelayMs: 30 });
  // arrival order, as the concurrent POST /settings test in settings.test.ts relies on
  const [settings, trust] = await Promise.all([
    postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt(repo), theme: 'dark', trustedDomains: ['gitlab.com'] }),
    postJson(`${base}/trusted-domains`, { host: 'docs.example.com' }),
  ]);
  assert.deepEqual([settings.status, trust.status], [200, 200]);
  const config = await saved(home);
  assert.deepEqual([config.theme, config.trustedDomains], ['dark', ['gitlab.com', 'docs.example.com']], 'both saves, in order: the trust read the list on the chain');
});
