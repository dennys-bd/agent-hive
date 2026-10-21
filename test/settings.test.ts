import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { readCredentials } from '../src/credentials.js';
import type { LegacyStage } from '../src/config-migrate.js';
import { createServer, type HiveServer, type ServerDeps } from '../src/server.js';
import type { Source, SourceSpec, TaskFilter, Config, EffectiveLimits, GithubAuth, GithubAuthStatus, Gql, Language, SourceConfig, Workspace, SettingsBody, SettingsInfo, State } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS, REVIEWER_DEFAULTS, MCP_DEFAULTS, type McpSettings } from '../src/types.js';
import { isDeepStrictEqual } from 'node:util';
import { AUTH, STAGES, FILTER, FIXED, fakeSourceFactory, fakeGql, GITHUB_ENTRY, EPICS, onOwnStages, fakeSpawn, jsonResponse, move, OPTIONS, workspacesAt, tempHive, chained, WORKSPACE } from './fakes.js';
import { tempDir } from './temp-dir.js';
import { SECRET_HEADER } from '../src/secret.js';
import { hiveFetch, SECRET } from './secret-client.js';

const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE',
  auth: AUTH,
  sources: [GITHUB_ENTRY],
  stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system',
  terminalFont: '',
  consoleLines: 5000,
  trustedDomains: [],
  shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};

interface Started { home: string; repo: string; base: string; port: number; server: HiveServer; configs: SourceSpec[] }

// The workspace each server's saves name, by base URL: postSettings puts it in, so the tests keep posting BODY the way the form does with its
// folder field filled. A body with its own `workspace` wins.
const workspaces = new Map<string, string>();

// extra is spread straight into createServer: the language tests pass { systemLanguage: 'pt' }, the login tests { githubLogin: … }.
async function start(t: TestContext, resolveDelayMs = 0, extra?: Partial<ServerDeps>): Promise<Started> {
  const { home, repo } = await tempHive(t); // its state.json has zero workers: this file's launchPty is real, so nothing may ever spawn (#727: the cap left the config)
  const { factory, configs } = fakeSourceFactory(resolveDelayMs);
  const server = createServer({ secret: SECRET, home, sourceFactory: factory, ...extra });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  workspaces.set(base, repo);
  return { home, repo, base, port, server, configs };
}

const UI_HEADERS = { 'content-type': 'application/json', 'x-hive-ui': '1' }; // what the dashboard sends on every POST
const postSettings = (base: string, body: unknown): Promise<Response> =>
  hiveFetch(`${base}/settings`, { method: 'POST', headers: UI_HEADERS, body: JSON.stringify({ workspaces: workspacesAt(workspaces.get(base)!), ...(body as object) }) });
const postJson = (url: string): Promise<Response> => hiveFetch(url, { method: 'POST', headers: UI_HEADERS });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
const configFile = (home: string): string => join(home, 'hive.config.json');
// The first SSE event on /events. One read can carry several events when the server emits in quick succession, so only the
// text before the first blank line is parsed.
async function firstEvent<T>(base: string): Promise<T> {
  const reader = (await hiveFetch(`${base}/events`)).body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return JSON.parse(new TextDecoder().decode(value).split('\n\n')[0].replace(/^data: /, '')) as T;
}

// Polls `check` until it returns a truthy value, or fails after a 2 s deadline: what the settings screen's own poll needs a test double for.
async function waitFor<T>(check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('waitFor: deadline exceeded');
}

// hiveFetch()/undici always sets Host from the URL, so a spoofed Host header needs node:http directly.
function getWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/settings', headers: { Host: host, [SECRET_HEADER]: SECRET } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /settings reports configured: false and the home in setup mode', async (t) => {
  const { base, home } = await start(t);
  assert.deepEqual(await json<SettingsInfo>(hiveFetch(`${base}/settings`)), {
    configured: false, home, language: 'en',
    agents: [{ agent: 'claude', available: true }, { agent: 'codex', available: true }],
  }); // no systemLanguage injected: en. No proposal injected: no key.
});

test('the settings screen answers under /settings and no longer under /setup (#573)', async (t) => {
  const { base } = await start(t);
  assert.equal((await hiveFetch(`${base}/settings`)).status, 200);
  assert.equal((await hiveFetch(`${base}/setup`)).status, 404); // #573: the old route, on purpose
});

test('GET /settings answers the home, never a repo, and the proposed workspace folder only until the first save', async (t) => {
  const { base, home, repo } = await start(t, 0, { proposedWorkspace: '/work/app' });
  const unconfigured = await json<SettingsInfo>(hiveFetch(`${base}/settings`));
  assert.deepEqual([unconfigured.home, unconfigured.proposedWorkspace, 'repo' in unconfigured], [home, '/work/app', false]);
  assert.equal((await postSettings(base, BODY)).status, 200);
  const configured = await json<SettingsInfo>(hiveFetch(`${base}/settings`));
  assert.deepEqual([configured.home, configured.proposedWorkspace, configured.config?.comb.workspaces[0].path], [home, undefined, repo]);
});

test('POST /settings takes the workspace folder from the body and refuses, writing nothing, a relative path, a missing folder, a folder outside git and a subfolder of a repo', async (t) => {
  const { base, home, repo } = await start(t);
  const plain = await tempDir(t, 'plain-');
  await mkdir(join(repo, 'src'));
  const refusals: [string, RegExp][] = [
    ['relative/repo', /"comb\.workspaces\[0\]\.path" must be an absolute path/],
    [join(repo, 'missing'), /missing is not a git repository/],
    [plain, /is not a git repository/],
    [join(repo, 'src'), /src is not the top level of its git repository/],
  ];
  for (const [workspace, error] of refusals) {
    const res = await postSettings(base, { ...BODY, workspaces: workspacesAt(workspace) });
    assert.equal(res.status, 400, workspace);
    assert.match((await json<{ error: string }>(res)).error, error);
  }
  await assert.rejects(stat(configFile(home)), 'nothing written');
  assert.equal((await postSettings(base, BODY)).status, 200, 'the folder field as the form fills it');
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).comb.workspaces, workspacesAt(repo));
});

test('POST /settings refuses, writing nothing, two workspaces whose paths resolve to the same folder', async (t) => {
  const { base, home, repo } = await start(t);
  const same: Workspace[] = [{ name: 'a', path: repo, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }, { name: 'b', path: `${repo}/`, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }];
  const res = await postSettings(base, { ...BODY, workspaces: same, sources: [{ ...GITHUB_ENTRY, taskProps: { defaults: { workspace: 'a', auto: true }, rules: [] } }] });
  assert.equal(res.status, 400);
  assert.deepEqual(await json<{ error: string }>(res), { error: 'workspaces a and b point at the same folder' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
});

test('GET /events streams { configured: false } until setup is saved', async (t) => {
  const { base } = await start(t);
  const res = await hiveFetch(`${base}/events`);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  assert.match(new TextDecoder().decode(value), /^data: \{"configured":false\}\n\n/);
});

test('setup listings reject a missing owner, number or type with 400 naming the field', async (t) => {
  const { base } = await start(t);
  assert.equal((await hiveFetch(`${base}/settings/projects`)).status, 400);
  const noNumber = await hiveFetch(`${base}/settings/source-columns?type=github&owner=acme`);
  assert.equal(noNumber.status, 400);
  assert.match((await json<{ error: string }>(noNumber)).error, /source\.number/);
  const noType = await hiveFetch(`${base}/settings/source-columns?owner=acme&number=6`);
  assert.equal(noType.status, 400);
  assert.match((await json<{ error: string }>(noType)).error, /source\.type/);
});

test('dashboard routes answer 409 before setup', async (t) => {
  const { base } = await start(t);
  assert.equal((await hiveFetch(`${base}/sources/refresh`, { method: 'POST', headers: UI_HEADERS })).status, 409);
});

test('POST /settings writes the config with defaults and boots the runtime on the bound port, answering { ok: true } (#466)', async (t) => {
  const { base, home, repo, port, server } = await start(t);
  const res = await postSettings(base, BODY);
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  const { prefix, sources, stages, commands, hiveSource, createIn, ...rest } = BODY;
  assert.deepEqual(JSON.parse(await readFile(configFile(home), 'utf8')), { ...DEFAULT_CONFIG, ...rest, comb: { prefix, workspaces: workspacesAt(repo), sources, ...chained(stages ?? []), commands, hiveSource, createIn } }, 'setup writes the one workspace: the folder the body named');
  await server.poll(); // the first poll runs in the background (#59); wait for it before reading tasks
  const state = server.getState();
  assert.equal(state?.workers.length, 0);
  assert.deepEqual(state?.tasks.map((c) => c.item.title), ['from Ready']);
  assert.match(await readFile(join(home, 'hooks.json'), 'utf8'), new RegExp(`127\\.0\\.0\\.1:${port}/hooks/event`));
  const info = await json<SettingsInfo>(hiveFetch(`${base}/settings`));
  assert.equal(info.configured, true);
  assert.deepEqual(info.config?.comb.sources, BODY.sources);
});

test('a save writes hive.config.json without a terminal key, even over a file that still holds one (#378)', async (t) => {
  const { base, home } = await start(t);
  assert.equal((await postSettings(base, BODY)).status, 200);
  const file = configFile(home);
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), terminal: 'internal' })); // a file from before #378
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal('terminal' in JSON.parse(await readFile(file, 'utf8')), false);
});

test('POST /settings with a column the source does not have answers 400 and writes nothing', async (t) => {
  const { base, home, server } = await start(t);
  const res = await postSettings(base, { ...BODY, stages: [{ ...STAGES[0], from: { board: ['Todo'] } }] });
  assert.equal(res.status, 400);
  assert.match((await json<{ error: string }>(res)).error, /"Todo" \(fila\.from\).*Ready, In progress, In review, Done/);
  await assert.rejects(stat(configFile(home)));
  await assert.rejects(stat(join(home, 'hooks.json')), 'the runtime files are never prepared');
  assert.equal(server.getState(), undefined);
  assert.equal((await json<SettingsInfo>(hiveFetch(`${base}/settings`))).configured, false);
});

test('POST /settings with an invalid body answers 400 naming the field', async (t) => {
  const { base, home } = await start(t);
  const res = await postSettings(base, { ...BODY, sources: [{ name: 'board', qualifyId: false, type: 'github', owner: 'acme' }] });
  assert.equal(res.status, 400);
  assert.match((await json<{ error: string }>(res)).error, /sources\[0\]\.number/);
  await assert.rejects(stat(configFile(home)));
});

test('a second POST /settings reconfigures in memory, keeps agentArgs and drops a leftover port (#466)', async (t) => {
  const { base, home, server, configs } = await start(t);
  assert.equal((await postSettings(base, BODY)).status, 200);
  const saved = JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
  await writeFile(configFile(home), JSON.stringify({ ...saved, port: 5000, agentArgs: { claude: ['--model', 'sonnet'] } })); // port: a key from before #466
  const res = await postSettings(base, { ...BODY, stages: [{ ...STAGES[0], from: { board: ['Done'] } }] });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  const rewritten = JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
  assert.equal(rewritten.comb.stages[0].from.board?.[0], 'Done');
  assert.equal('port' in rewritten, false, 'the parse ignores it, so the save drops it');
  assert.deepEqual(rewritten.agentArgs, { claude: ['--model', 'sonnet'], codex: [] });
  await server.poll(); // reconfigure's poll runs in the background (#59)
  assert.deepEqual(server.getState()?.tasks.map((c) => c.item.title), ['from Done']);
  assert.equal(configs.at(-1)?.stages[0].from.board?.[0], 'Done');
});

test('a second POST /settings with the same source and status keeps the live source instance', async (t) => {
  const { base, configs } = await start(t);
  assert.equal((await postSettings(base, BODY)).status, 200);
  const afterFirst = configs.length; // the one source this save resolves and activates
  assert.equal((await postSettings(base, { ...BODY, stages: [{ ...STAGES[0], prompt: 'só {title}' }] })).status, 200);
  assert.equal(configs.length, afterFirst, 'same board and status: the live board is reused, no new instance');
  assert.equal(
    (await postSettings(base, { ...BODY, stages: [{ ...STAGES[0], from: { board: ['Done'] } }] })).status,
    200,
  );
  assert.equal(configs.length, afterFirst + 1, 'a different status needs a new board');
});

// The fake's own resolveFields is wrapped so a test can count how many times a save resolves the source,
// separately from how many sources the factory created (`configs.length`, already tracked by fakeSourceFactory).
function countingSourceFactory(): { factory: (spec: SourceSpec) => Source; configs: SourceSpec[]; resolves(): number } {
  const { factory, configs } = fakeSourceFactory();
  let resolves = 0;
  const wrapped = (spec: SourceSpec): Source => {
    const board = factory(spec);
    return { ...board, resolveFields: () => { resolves += 1; return board.resolveFields(); } };
  };
  return { factory: wrapped, configs, resolves: () => resolves };
}

test('POST /settings responds before the first poll; the tasks land once it settles', async (t) => {
  const { home, repo } = await tempHive(t);
  const { factory } = fakeSourceFactory();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sourceFactory = (spec: SourceSpec): Source => {
    const board = factory(spec);
    return { ...board, listItems: async () => { await gate; return board.listItems(); } };
  };
  const server = createServer({ secret: SECRET, home, sourceFactory });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  workspaces.set(base, repo);
  const res = await postSettings(base, BODY); // answers even though listItems is still pending
  assert.equal(res.status, 200);
  assert.deepEqual(server.getState()?.tasks, [], 'the poll is still pending: no tasks yet');
  release();
  for (let i = 0; i < 200 && server.getState()?.tasks.length !== 1; i += 1) await sleep(5);
  assert.deepEqual(server.getState()?.tasks.map((c) => c.item.title), ['from Ready']);
});

test('a poll still in flight when a later save replaced the source is dropped, not mixed into the new source', async (t) => {
  const { home, repo } = await tempHive(t);
  const { factory } = fakeSourceFactory();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stale = { item: { itemId: 'X1', id: '9', title: 'from the old source', body: '', url: 'https://github.com/acme/r/issues/9' }, column: 'Ready' };
  const sourceFactory = (spec: SourceSpec): Source => {
    const board = factory(spec);
    if (spec.source?.type === 'github' && spec.source.owner === 'acme') return { ...board, listItems: async () => { await gate; return [stale]; } };
    return board;
  };
  const server = createServer({ secret: SECRET, home, sourceFactory });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  workspaces.set(base, repo);
  assert.equal((await postSettings(base, BODY)).status, 200); // save A: its poll hangs on the gate
  assert.equal((await postSettings(base, { ...BODY, sources: [{ ...GITHUB_ENTRY, owner: 'other', number: 1 }] })).status, 200); // save B: new source
  await server.poll();
  release();
  await sleep(20); // long enough for save A's poll to resolve and (wrongly) dispatch
  assert.deepEqual(server.getState()?.tasks.map((c) => c.item.title), ['from Ready'], 'only the new board\'s tasks are in the state');
});

test('a poll still in flight when the Hive closes is dropped: no worker is spawned after killAll', async (t) => {
  const { home, repo } = await tempHive(t, 1); // one worker: the task would be spawned
  const { factory } = fakeSourceFactory();
  const { spawn, workers } = fakeSpawn();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sourceFactory = (spec: SourceSpec): Source => {
    const board = factory(spec);
    return { ...board, listItems: async () => { await gate; return board.listItems(); } };
  };
  const server = createServer({ secret: SECRET, home, sourceFactory, launchPty: spawn });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  workspaces.set(base, repo);
  assert.equal((await postSettings(base, BODY)).status, 200);
  await server.dispatch({ type: 'setSignal', signal: 'green' }); // boot leaves the signal off green; the poll's task needs green to start
  await server.close();
  release();
  await sleep(20);
  assert.equal(workers.length, 0, 'the poll that outlived close() spawned nothing');
});

test('a save resolves the source exactly once, and only builds a new one when the source actually changed', async (t) => {
  const { home, repo } = await tempHive(t);
  const { factory, configs, resolves } = countingSourceFactory();
  const server = createServer({ secret: SECRET, home, sourceFactory: factory });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  workspaces.set(base, repo);
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal(resolves(), 1, 'the first save (configure) resolves the board once');
  assert.equal(configs.length, 1, 'and builds exactly one board');
  const afterFirst = resolves();
  assert.equal((await postSettings(base, { ...BODY, stages: [{ ...STAGES[0], from: { board: ['Done'] } }] })).status, 200); // a different board
  assert.equal(resolves(), afterFirst + 1, 'a reconfigure onto a changed board still resolves it once, not twice');
  assert.equal(configs.length, 2, 'a changed board needs a new instance, still just one');
});

test('POST /settings saves the filter rules; unchanged rules keep the adapter, changed ones build a new one, the old object is a 400 (#245)', async (t) => {
  const { home, repo } = await tempHive(t);
  const { factory, configs } = countingSourceFactory();
  const server = createServer({ secret: SECRET, home, sourceFactory: factory });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  workspaces.set(base, repo);
  const withFilter = (filter: TaskFilter): Omit<SettingsBody, 'workspaces'> => ({ ...BODY, sources: [{ name: 'board', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter, taskProps: FIXED, ...EPICS }] });
  const mine = withFilter([{ field: 'assignee', op: 'any', values: ['@me'] }]);
  assert.equal((await postSettings(base, mine)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).comb.sources, mine.sources);
  assert.equal((await postSettings(base, mine)).status, 200);
  assert.equal(configs.length, 1, 'same rules: same adapter');
  const blocked = withFilter([{ field: 'assignee', op: 'any', values: ['@me'] }, { field: 'label', op: 'none', values: ['blocked'] }]);
  assert.equal((await postSettings(base, blocked)).status, 200);
  assert.equal(configs.length, 2, 'the rules are baked into the adapter: sameSource sees the change');
  assert.deepEqual(configs.at(-1)?.source, blocked.sources![0]);
  const old = await postSettings(base, { ...BODY, sources: [{ name: 'board', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: { assignees: [], labels: [], milestones: [] } }] });
  assert.equal(old.status, 400);
  assert.match((await json<{ error: string }>(old)).error, /"comb\.sources\[0\]\.filter" must be an array of rules \(the assignees\/labels\/milestones object is gone, see #245\)/);
});

test('concurrent POST /settings calls run one at a time and the last one wins on disk and in memory', async (t) => {
  const { base, home } = await start(t, 30);
  const [first, second] = await Promise.all([
    postSettings(base, BODY),
    postSettings(base, { ...BODY, stages: [{ ...STAGES[0], from: { board: ['Done'] } }] }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const onDisk = JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
  assert.equal(onDisk.comb.stages[0].from.board?.[0], 'Done');
  assert.equal((await json<SettingsInfo>(hiveFetch(`${base}/settings`))).config?.comb.stages[0].from.board?.[0], 'Done');
});

test('POST /settings never writes maxConcurrent: the state keeps its own cap across saves (#727)', async (t) => {
  const { base, home, server } = await start(t);
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal('maxConcurrent' in (JSON.parse(await readFile(configFile(home), 'utf8')) as Record<string, unknown>), false);
  assert.equal(server.getState()?.maxConcurrent, 0, 'start() seeded the state with 0');
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal(server.getState()?.maxConcurrent, 0);
});

test('POST /settings without defaultAgent keeps the one already in hive.config.json (#516)', async (t) => {
  const { base, home } = await start(t);
  assert.equal((await postSettings(base, BODY)).status, 200);
  const { defaultAgent: _omitted, ...withoutAgent } = BODY;
  assert.equal((await postSettings(base, withoutAgent)).status, 200);
  assert.equal((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).defaultAgent, 'claude');
});

test('a hive.config.json from before #924 keeps its claudeArgs as agentArgs.claude, and the next save writes agentArgs without claudeArgs (#924)', async (t) => {
  const { base, home } = await start(t);
  assert.equal((await postSettings(base, BODY)).status, 200);
  const { agentArgs: _gone, ...saved } = JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
  await writeFile(configFile(home), JSON.stringify({ ...saved, claudeArgs: ['--permission-mode', 'auto'] }));
  assert.equal((await postSettings(base, BODY)).status, 200);
  const rewritten = JSON.parse(await readFile(configFile(home), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(rewritten.agentArgs, { claude: ['--permission-mode', 'auto'], codex: [] });
  assert.equal('claudeArgs' in rewritten, false, 'the retired key is gone from the file');
});

test('POST /settings takes agentArgs from the body and keeps the saved ones when the body has none (#924)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).agentArgs;
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.deepEqual(await onDisk(), { claude: [], codex: [] }, 'a first setup without the key starts with none');
  assert.equal((await postSettings(base, { ...BODY, agentArgs: { claude: ['--verbose'], codex: [] } })).status, 200);
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.deepEqual(await onDisk(), { claude: ['--verbose'], codex: [] }, 'an API caller that omits it keeps the saved lists');
  assert.equal((await postSettings(base, { ...BODY, agentArgs: { claude: [], codex: [] } })).status, 200);
  assert.deepEqual(await onDisk(), { claude: [], codex: [] });
});

// POST /config with a non-zero maxConcurrent is skipped here: this file's start() uses the real
// launchPty (no fake), and a fake source task under a non-zero maxConcurrent would risk spawning
// an actual `claude` process. See test/server.test.ts, which fakes launchPty, for that coverage.

test('requests with a Host header that does not match the bound address get 403', async (t) => {
  const { port } = await start(t);
  assert.equal(await getWithHost(port, `evil.example:${port}`), 403);
});

// A form on another site can post at the local port with a matching Host and no JSON: only the x-hive-ui header, which a
// form cannot set, tells the dashboard apart. Hook routes are exempt (a worker's curl never sends it).
test('a dashboard POST without x-hive-ui gets 403 and changes nothing; hook routes do not need it', async (t) => {
  const { base, server } = await start(t);
  assert.equal((await postSettings(base, BODY)).status, 200);
  const form = await hiveFetch(`${base}/sources/refresh`, { method: 'POST', body: new URLSearchParams({ x: '1' }) });
  assert.equal(form.status, 403);
  assert.deepEqual(await form.json(), { error: 'origem não permitida' });
  const bare = await hiveFetch(`${base}/signal`, { method: 'POST' });
  assert.equal(bare.status, 403);
  assert.equal(server.getState()?.signal, 'yellow');
  assert.equal((await hiveFetch(`${base}/hooks/exit`, { method: 'POST' })).status, 200);
});

test('requests with a matching Host header are not rejected by the allowlist', async (t) => {
  const { port } = await start(t);
  assert.equal(await getWithHost(port, `127.0.0.1:${port}`), 200);
});

test('POST /settings with stages persists them, GET /settings returns them, an omitted key keeps them and a bad one answers 400 naming the index', async (t) => {
  const { base, home } = await start(t);
  const posted: LegacyStage[] = [{ name: 'spec', from: { board: ['Ready'] }, onFinish: { board: [move('In review')] }, prompt: '/hive-spec {url}', session: 'new' }, { name: 'review', from: { board: ['In review'] } }];
  const { stages } = chained(posted); // #134: onFinish is saved as the transitions' sources
  assert.equal((await postSettings(base, onOwnStages({ ...BODY, stages: posted }))).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).comb.stages, stages);
  assert.deepEqual((await json<SettingsInfo>(hiveFetch(`${base}/settings`))).config?.comb.stages, stages);
  const { stages: _omitted, ...withoutStages } = BODY;
  assert.equal((await postSettings(base, { ...withoutStages, sources: [{ ...GITHUB_ENTRY, switchAt: 'spec' }] })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).comb.stages, stages, 'an API caller that omits it keeps the saved ones');
  const bad = await postSettings(base, { ...BODY, stages: [{ name: 'a', from: { board: ['Ready'] }, session: 'resume' }] });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /stages\[0\]\.session/);
});

test('GET /settings/source-columns builds the source from the query and answers its settingsOptions', async (t) => {
  const { base, configs } = await start(t);
  assert.deepEqual(await json(hiveFetch(`${base}/settings/source-columns?type=github&owner=acme&number=6`)), OPTIONS);
  assert.deepEqual(configs.at(-1)?.source, { name: 'setup', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: { defaults: { workspace: 'setup', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'Build' }, 'the query carries no filter, no routing and no epics keys: listing Status options gets the empty filter, a placeholder workspace and a new source\'s epics keys');
});

test('GET /settings/source-columns carries the transport: auth=api is honoured, anything else is cli', async (t) => {
  const { base, configs } = await start(t);
  assert.deepEqual(await json(hiveFetch(`${base}/settings/source-columns?type=github&owner=acme&number=6&auth=api`)), OPTIONS);
  assert.deepEqual(configs.at(-1)?.auth, { github: 'api' });
  assert.deepEqual(await json(hiveFetch(`${base}/settings/source-columns?type=github&owner=acme&number=6`)), OPTIONS);
  assert.deepEqual(configs.at(-1)?.auth, { github: 'cli' }, 'absent means cli: an unauthenticated setup still lists a gh-visible GitHub Project');
  assert.deepEqual(await json(hiveFetch(`${base}/settings/source-columns?type=github&owner=acme&number=6&auth=nonsense`)), OPTIONS);
  assert.deepEqual(configs.at(-1)?.auth, { github: 'cli' });
});

// One source as GitHub answers it for the filter options (#245): one issue, the Status field and one other single-select field.
const optionsGql = (): Gql => fakeGql({
  items: { repositoryOwner: { projectV2: { items: { pageInfo: { hasNextPage: false }, nodes: [
    { id: 'I1', content: { __typename: 'Issue', assignees: { nodes: [{ login: 'ana' }] }, labels: { nodes: [{ name: 'hive' }] }, milestone: null, repository: { nameWithOwner: 'acme/app' } } },
  ] } } } },
  selectFields: { repositoryOwner: { projectV2: { fields: { nodes: [{ name: 'Status', options: [{ name: 'Ready' }] }, { name: 'Priority', options: [{ name: 'P0' }, { name: 'P1' }] }, {}] } } } },
}).gql;

test('GET /settings/filter-options answers the source\'s options through the transport the query names; /settings/source-columns still answers its Status options (#245)', async (t) => {
  const auths: GithubAuth[] = [];
  const { base } = await start(t, 0, { settingsGql: (auth) => { auths.push(auth); return optionsGql(); } });
  assert.deepEqual(await json(hiveFetch(`${base}/settings/filter-options?owner=acme&number=6&auth=api`)), {
    assignees: ['@me', 'ana'], labels: ['hive'], milestones: [], repositories: ['acme/app'], projectFields: [{ name: 'Priority', options: ['P0', 'P1'] }], linkedRepositories: [],
  });
  assert.equal((await hiveFetch(`${base}/settings/filter-options?owner=acme&number=6`)).status, 200);
  assert.deepEqual(auths, ['api', 'cli'], 'absent means cli, as on the sibling routes');
  assert.deepEqual(await json(hiveFetch(`${base}/settings/source-columns?type=github&owner=acme&number=6`)), OPTIONS);
});

test('GET /settings/filter-options answers 400 without an owner or a numeric number, and 502 with the message when GitHub fails (#245)', async (t) => {
  const { base } = await start(t, 0, { settingsGql: () => fakeGql({}).gql });
  for (const query of ['', 'owner=acme', 'number=6', 'owner=&number=6', 'owner=acme&number=x']) {
    const res = await hiveFetch(`${base}/settings/filter-options?${query}`);
    assert.equal(res.status, 400, query);
    assert.deepEqual(await res.json(), { error: 'owner e number obrigatórios' });
  }
  const failed = await hiveFetch(`${base}/settings/filter-options?owner=acme&number=6`);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'unexpected graphql call: items' });
});

test('POST /signal answers 409 before setup, 400 for an unknown value, then 200 and the state carries it', async (t) => {
  const { base, home, server } = await start(t);
  const postSignal = (body: unknown): Promise<Response> =>
    hiveFetch(`${base}/signal`, { method: 'POST', headers: UI_HEADERS, body: JSON.stringify(body) });
  assert.equal((await postSignal({ signal: 'red' })).status, 409);
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal(server.getState()?.signal, 'yellow', 'setup boots, and every boot opens under yellow');
  const bad = await postSignal({ signal: 'blue' });
  assert.equal(bad.status, 400);
  assert.equal((await json<{ error: string }>(bad)).error, 'signal must be one of: green, yellow, red');
  const ok = await postSignal({ signal: 'red' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await json(ok), { ok: true });
  const streamed = await firstEvent<State & { effective: EffectiveLimits }>(base);
  assert.equal(streamed.signal, 'red');
  assert.deepEqual(streamed.effective, { signal: 'red', floor: { signal: 'green' }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} }, 'no usage rules configured: the manual signal alone, nothing fired');
  // persisted with the rest of the state, so a Hive closed under red reopens under red
  assert.equal((JSON.parse(await readFile(join(home, 'state.json'), 'utf8')) as State).signal, 'red');
});

test('POST /settings with a budget writes it to hive.config.json, GET /settings returns it and the State carries it', async (t) => {
  const { base, home, server } = await start(t);
  const budget = { maxTokensPerHour: 50_000, maxTokensPerDay: 400_000 };
  assert.equal((await postSettings(base, { ...BODY, budget })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).budget, budget);
  assert.deepEqual((await json<SettingsInfo>(hiveFetch(`${base}/settings`))).config?.budget, budget);
  assert.deepEqual(server.getState()?.budget, budget);
  const streamed = await firstEvent<State>(base);
  assert.deepEqual(streamed.budget, budget);
  assert.deepEqual(streamed.usage, []);
  // a save without budget keeps the file's; a save with {} clears it (the form always sends budget)
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).budget, budget);
  assert.equal((await postSettings(base, { ...BODY, budget: {} })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).budget, {});
  assert.deepEqual(server.getState()?.budget, {});
  const bad = await postSettings(base, { ...BODY, budget: { maxTokensPerHour: -5 } });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /budget\.maxTokensPerHour/);
});

test('POST /hooks/event Stop with a transcript_path for an unknown worker answers 204, reads nothing and keeps serving', async (t) => {
  const { base, repo, server } = await start(t);
  assert.equal((await postSettings(base, BODY)).status, 200);
  const transcript = join(repo, 'transcript.jsonl');
  await writeFile(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } } })}\n`);
  const postHook = (body: unknown): Promise<Response> =>
    hiveFetch(`${base}/hooks/event`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-pty': 'ghost' }, body: JSON.stringify(body),
    });
  assert.equal((await postHook({ hook_event_name: 'Stop', transcript_path: transcript })).status, 204);
  assert.equal((await postHook({ hook_event_name: 'SessionEnd', transcript_path: join(repo, 'missing.jsonl') })).status, 204);
  assert.equal((await postHook({ hook_event_name: 'Stop', transcript_path: 'relative.jsonl' })).status, 204);
  await sleep(20); // the route answers before dispatching; let the handlers finish
  assert.deepEqual(server.getState()?.usage, [], 'no occupied worker matches, so nothing is read or recorded');
  assert.equal((await hiveFetch(`${base}/settings`)).status, 200, 'the server is still up');
});

test('POST /settings with usageRules writes them to hive.config.json, GET /settings and the State carry them, an absent key keeps them and [] clears them', async (t) => {
  const { base, home, server } = await start(t);
  const usageRules = [
    { source: 'day', percent: 50, maxWorkers: 3 }, { source: 'hour', percent: 80, signal: 'yellow' },
    { source: 'session', percent: 80, maxWorkers: 1, signal: 'yellow' }, { source: 'week', percent: 90, signal: 'red' },
  ];
  assert.equal((await postSettings(base, { ...BODY, usageRules })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).usageRules, usageRules);
  assert.deepEqual((await json<SettingsInfo>(hiveFetch(`${base}/settings`))).config?.usageRules, usageRules);
  assert.deepEqual(server.getState()?.usageRules, usageRules);
  // a save without the key keeps the file's; a save with [] clears them (the form always sends the table)
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).usageRules, usageRules);
  assert.deepEqual(server.getState()?.usageRules, usageRules);
  assert.equal((await postSettings(base, { ...BODY, usageRules: [] })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).usageRules, []);
  assert.deepEqual(server.getState()?.usageRules, []);
});

test('POST /settings with an invalid usage rule answers 400 naming the rule and writes nothing', async (t) => {
  const { base, home, server } = await start(t);
  const usageRules = [{ source: 'hour', percent: 80, signal: 'yellow' }];
  assert.equal((await postSettings(base, { ...BODY, usageRules })).status, 200);
  const outOfRange = await postSettings(base, { ...BODY, usageRules: [{ source: 'hour', percent: 101, signal: 'red' }] });
  assert.equal(outOfRange.status, 400);
  assert.match((await json<{ error: string }>(outOfRange)).error, /usageRules\[0\]\.percent/);
  const noEffect = await postSettings(base, { ...BODY, usageRules: [{ source: 'session', percent: 50 }] });
  assert.equal(noEffect.status, 400);
  assert.match((await json<{ error: string }>(noEffect)).error, /"usageRules\[0\]" must set "maxWorkers" or "signal"/);
  const noSource = await postSettings(base, { ...BODY, usageRules: [{ percent: 50, signal: 'red' }] });
  assert.equal(noSource.status, 400);
  assert.match((await json<{ error: string }>(noSource)).error, /"usageRules\[0\]\.source" must be one of: hour, day, session, week, month/);
  // both rejected before the write: the file and the State still carry the valid rule
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).usageRules, usageRules);
  assert.deepEqual(server.getState()?.usageRules, usageRules);
});

const STATUS_PAYLOAD = {
  model: { id: 'claude-opus' }, // the rest of the status line JSON rides along and is ignored
  rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 1759744800 }, seven_day: { used_percentage: 41, resets_at: 1760263200 } },
};
const postStatus = (base: string, body: unknown, worker?: string): Promise<Response> =>
  hiveFetch(`${base}/hooks/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(worker ? { 'x-hive-pty': worker } : {}) },
    body: JSON.stringify(body),
  });

test('POST /hooks/status answers the limits line for a valid payload, an empty body otherwise, and an unknown worker changes nothing', async (t) => {
  const { base, server } = await start(t);
  assert.equal((await postSettings(base, BODY)).status, 200);
  const ok = await postStatus(base, STATUS_PAYLOAD, 'ghost');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(await ok.text(), 'session 23% · week 41%'); // no systemLanguage injected: en
  const noHeader = await postStatus(base, STATUS_PAYLOAD);
  assert.equal(noHeader.status, 200);
  assert.equal(await noHeader.text(), '');
  const noLimits = await postStatus(base, { model: { id: 'claude-opus' } }, 'ghost');
  assert.equal(noLimits.status, 200);
  assert.equal(await noLimits.text(), '');
  const noValid = await postStatus(base, { rate_limits: { five_hour: { used_percentage: 'x' } } }, 'ghost');
  assert.equal(await noValid.text(), '');
  await sleep(20); // the route answers before dispatching; let the handlers finish
  assert.equal(server.getState()?.rateLimits, undefined, 'no occupied worker matches, so nothing is stored');
  assert.equal((await hiveFetch(`${base}/settings`)).status, 200, 'the server is still up');
});

test('POST /settings carries each source\'s epics keys: written inside the source, a change rebuilds it, and a missing key, an unknown mode or a switchAt off the flow answers 400 before the write (#30)', async (t) => {
  const { base, home, configs } = await start(t);
  const saved = async (): Promise<SourceConfig> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).comb.sources[0];
  const epicsOf = ({ epics, epicFollows, switchAt }: SourceConfig) => ({ epics, epicFollows, switchAt });
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.deepEqual(epicsOf(await saved()), EPICS);
  const before = configs.length;
  assert.equal((await postSettings(base, { ...BODY, sources: [{ ...GITHUB_ENTRY, epics: 'hide', epicFollows: 'behind' }] })).status, 200);
  assert.deepEqual(epicsOf(await saved()), { epics: 'hide', epicFollows: 'behind', switchAt: 'fila' });
  assert.equal(configs.at(-1)?.source.epics, 'hide', 'the live source is built with the new mode');
  assert.equal(configs.length, before + 1, 'a different mode needs a new source, resolved once');
  const refused = async (source: unknown, error: RegExp): Promise<void> => {
    const bad = await postSettings(base, { ...BODY, sources: [source] });
    assert.equal(bad.status, 400);
    assert.match((await json<{ error: string }>(bad)).error, error);
  };
  const { switchAt: _missing, ...noSwitchAt } = GITHUB_ENTRY;
  await refused(noSwitchAt, /"comb\.sources\[0\]\.switchAt" is required/);
  await refused({ ...GITHUB_ENTRY, epics: 'queue' }, /"comb\.sources\[0\]\.epics" must be one of: ignore, show, hide/);
  await refused({ ...GITHUB_ENTRY, switchAt: 'Build' }, /"comb\.sources\[0\]\.switchAt" is "Build", which is not a stage of the flow/);
  assert.equal((await saved()).epics, 'hide', 'rejected before the write');
});

test('GET /settings carries the effective language: the system one until a save sets it, then the file; an omitted key keeps it; a bad value is 400', async (t) => {
  const { base, home } = await start(t, 0, { systemLanguage: 'pt' });
  const language = async (): Promise<Language> => (await json<SettingsInfo>(hiveFetch(`${base}/settings`))).language;
  const saved = async (): Promise<Config> => JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
  assert.equal(await language(), 'pt');
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal(await language(), 'pt', 'no language in the body: still the system one');
  assert.equal('language' in (await saved()), false, 'and the file has no language key');
  assert.equal((await postSettings(base, { ...BODY, language: 'en' })).status, 200);
  assert.equal(await language(), 'en');
  assert.equal((await saved()).language, 'en');
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal(await language(), 'en', 'an API caller that omits it keeps the saved one');
  const bad = await postSettings(base, { ...BODY, language: 'fr' });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /"language" must be one of: pt, en/);
  assert.equal((await saved()).language, 'en', 'nothing written');
});

test('POST /settings writes baseBranch, clears it with an empty string and keeps the saved one when the key is omitted', async (t) => {
  const { base, home } = await start(t);
  const saved = async (): Promise<Config> => JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal('baseBranch' in (await saved()), false, 'nothing in the body: the file stays clean');
  assert.equal((await postSettings(base, { ...BODY, baseBranch: 'develop' })).status, 200);
  assert.equal((await saved()).baseBranch, 'develop');
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal((await saved()).baseBranch, 'develop', 'an API caller that omits it keeps the saved one');
  assert.equal((await postSettings(base, { ...BODY, baseBranch: '' })).status, 200);
  assert.equal('baseBranch' in (await saved()), false, 'the form clearing the field goes back to automatic');
  const bad = await postSettings(base, { ...BODY, baseBranch: 7 });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /"baseBranch"/);
});

test('POST /settings writes onClose, an omitted key keeps the saved value, and a first setup without it is a 400 naming onClose (#513)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<Config> => JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
  const { onClose: _onClose, ...withoutOnClose } = BODY;
  const first = await postSettings(base, withoutOnClose);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "onClose" must be one of: menuBar, quit' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  assert.equal((await postSettings(base, { ...BODY, onClose: 'quit' })).status, 200);
  assert.equal((await onDisk()).onClose, 'quit');
  assert.equal((await postSettings(base, withoutOnClose)).status, 200);
  assert.equal((await onDisk()).onClose, 'quit', 'an API caller that omits it keeps the saved value');
  const bad = await postSettings(base, { ...BODY, onClose: 'yes' });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /"onClose" must be one of/);
  assert.equal((await onDisk()).onClose, 'quit', 'rejected before the write');
  const written = await onDisk();
  assert.equal('menuBar' in written, false);
  assert.equal('stopOnClose' in written, false);
});

test('POST /settings writes deleteActivity, an omitted key keeps the saved scope, and a first setup without it or with transcripts and no sessions is a 400 (#236, #573)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).deleteActivity;
  const { deleteActivity: _deleteActivity, ...withoutScope } = BODY;
  const first = await postSettings(base, withoutScope);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "deleteActivity" must be an object with session, transcripts, nonAutoTasks' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  const scope = { session: true, transcripts: true, nonAutoTasks: false };
  assert.equal((await postSettings(base, { ...BODY, deleteActivity: scope })).status, 200);
  assert.deepEqual(await onDisk(), scope);
  assert.equal((await postSettings(base, withoutScope)).status, 200);
  assert.deepEqual(await onDisk(), scope, 'an API caller that omits it keeps the saved one');
  const bad = await postSettings(base, { ...BODY, deleteActivity: { ...scope, session: false } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error: 'hive.config.json: "deleteActivity.transcripts" needs "deleteActivity.session"' });
  assert.deepEqual(await onDisk(), scope, 'rejected before the write');
});

test('POST /settings writes shutdownIdleMinutes, an omitted key keeps the saved value, and a first setup without it or out of range is a 400 (#233)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).shutdownIdleMinutes;
  const { shutdownIdleMinutes: _minutes, ...withoutWindow } = BODY;
  const first = await postSettings(base, withoutWindow);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "shutdownIdleMinutes" must be an integer from 1 to 1440' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  assert.equal((await postSettings(base, { ...BODY, shutdownIdleMinutes: 45 })).status, 200);
  assert.equal(await onDisk(), 45);
  assert.equal((await postSettings(base, withoutWindow)).status, 200);
  assert.equal(await onDisk(), 45, 'an API caller that omits it keeps the saved one');
  const bad = await postSettings(base, { ...BODY, shutdownIdleMinutes: 1441 });
  assert.equal(bad.status, 400);
  assert.equal(await onDisk(), 45, 'rejected before the write');
});

test('POST /settings writes approvalMinutes, an omitted key keeps the saved value, and a first setup without it or out of range is a 400 (#268)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).approvalMinutes;
  const { approvalMinutes: _minutes, ...withoutWindow } = BODY;
  const first = await postSettings(base, withoutWindow);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "approvalMinutes" must be an integer from 1 to 120' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  assert.equal((await postSettings(base, { ...BODY, approvalMinutes: 30 })).status, 200);
  assert.equal(await onDisk(), 30);
  assert.equal((await postSettings(base, withoutWindow)).status, 200);
  assert.equal(await onDisk(), 30, 'an API caller that omits it keeps the saved one');
  const bad = await postSettings(base, { ...BODY, approvalMinutes: 121 });
  assert.equal(bad.status, 400);
  assert.equal(await onDisk(), 30, 'rejected before the write');
});

test('POST /settings writes rateLimitWaitMinutes, an omitted key keeps the saved value, and a first setup without it or out of range is a 400 (#805)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).rateLimitWaitMinutes;
  const { rateLimitWaitMinutes: _minutes, ...withoutWait } = BODY;
  const first = await postSettings(base, withoutWait);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "rateLimitWaitMinutes" must be an integer from 1 to 10080' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  assert.equal((await postSettings(base, { ...BODY, rateLimitWaitMinutes: 600 })).status, 200);
  assert.equal(await onDisk(), 600);
  assert.equal((await postSettings(base, withoutWait)).status, 200);
  assert.equal(await onDisk(), 600, 'an API caller that omits it keeps the saved one');
  const bad = await postSettings(base, { ...BODY, rateLimitWaitMinutes: 10_081 });
  assert.equal(bad.status, 400);
  assert.equal(await onDisk(), 600, 'rejected before the write');
});

test('POST /settings with an ide from before #818 saves, and the file it writes has no ide (#818)', async (t) => {
  const { base, home } = await start(t);
  assert.equal((await postSettings(base, { ...BODY, ide: 'zed' } as typeof BODY)).status, 200);
  assert.equal('ide' in (JSON.parse(await readFile(configFile(home), 'utf8')) as Record<string, unknown>), false);
});

test('POST /settings writes closeSessionTab, closeStageTab and their notice switches, an omitted key keeps the saved value, and a first setup without them is a 400 (#614)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown[]> => {
    const saved = JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
    return [saved.closeSessionTab, saved.closeStageTab, saved.closeSessionTabNotice, saved.closeStageTabNotice];
  };
  const { closeSessionTab: _session, closeStageTab: _stage, closeSessionTabNotice: _sessionNotice, closeStageTabNotice: _stageNotice, ...without } = BODY;
  const first = await postSettings(base, without);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "closeSessionTab" must be one of: keep, sleep' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  assert.equal((await postSettings(base, { ...BODY, closeSessionTab: 'sleep', closeStageTab: 'sleep', closeSessionTabNotice: false, closeStageTabNotice: false })).status, 200);
  assert.deepEqual(await onDisk(), ['sleep', 'sleep', false, false]);
  assert.equal((await postSettings(base, without)).status, 200);
  assert.deepEqual(await onDisk(), ['sleep', 'sleep', false, false], 'an API caller that omits them keeps the saved values');
  const bad = await postSettings(base, { ...BODY, closeStageTab: 'end' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await onDisk(), ['sleep', 'sleep', false, false], 'rejected before the write');
});

test('POST /settings with the prefix and one notice switch, the notice checkbox\'s body, changes that key alone (#614)', async (t) => {
  const { base, home } = await start(t);
  const saved = async (): Promise<Config> => JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
  assert.equal((await postSettings(base, BODY)).status, 200);
  const before = await saved();
  // Straight to the route, not postSetup: no workspaces, only what the checkbox sends. configFrom has no fallback for the prefix, as
  // POST /trusted-domains knows, so the checkbox sends it too
  const res = await hiveFetch(`${base}/settings`, { method: 'POST', headers: UI_HEADERS, body: JSON.stringify({ prefix: before.comb.prefix, closeStageTabNotice: false }) });
  assert.deepEqual(await json(res), { ok: true });
  assert.deepEqual(await saved(), { ...before, closeStageTabNotice: false });
});

test('POST /settings writes theme, an omitted key keeps the saved one, and a first setup without it or with an unknown one is a 400 (#296)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).theme;
  const { theme: _theme, ...withoutTheme } = BODY;
  const error = 'hive.config.json: "theme" must be one of: system, light, dark';
  const first = await postSettings(base, withoutTheme);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  assert.equal((await postSettings(base, { ...BODY, theme: 'light' })).status, 200);
  assert.equal(await onDisk(), 'light');
  assert.equal((await postSettings(base, withoutTheme)).status, 200);
  assert.equal(await onDisk(), 'light', 'an API caller that omits it keeps the saved one');
  const bad = await postSettings(base, { ...BODY, theme: 'sepia' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error });
  assert.equal(await onDisk(), 'light', 'rejected before the write');
});

test('POST /settings writes fileIcons, an omitted key keeps the saved one, and a first setup without it is a 400 (#754)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).fileIcons;
  const { fileIcons: _icons, ...withoutIcons } = BODY;
  const first = await postSettings(base, withoutIcons);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "fileIcons" must be an object with set, scope, muted' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  const icons = { set: 'vscode', scope: 'folders', muted: true } as const;
  assert.equal((await postSettings(base, { ...BODY, fileIcons: icons })).status, 200);
  assert.deepEqual(await onDisk(), icons);
  assert.equal((await postSettings(base, withoutIcons)).status, 200);
  assert.deepEqual(await onDisk(), icons, 'an API caller that omits it keeps the saved one');
  const bad = await postSettings(base, { ...BODY, fileIcons: { ...icons, scope: 'files' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error: 'hive.config.json: "fileIcons.scope" must be one of: all, folders' });
  assert.deepEqual(await onDisk(), icons, 'rejected before the write');
});

test('POST /settings writes sidebarsPerView, an omitted key keeps the saved one, and a first setup without it is a 400 (#821)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).sidebarsPerView;
  const { sidebarsPerView: _sides, ...withoutSides } = BODY;
  const first = await postSettings(base, withoutSides);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "sidebarsPerView" must be an object with left, right, rightTab' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  const sides = { left: false, right: true, rightTab: false };
  assert.equal((await postSettings(base, { ...BODY, sidebarsPerView: sides })).status, 200);
  assert.deepEqual(await onDisk(), sides);
  assert.equal((await postSettings(base, withoutSides)).status, 200);
  assert.deepEqual(await onDisk(), sides, 'an API caller that omits it keeps the saved one');
  const bad = await postSettings(base, { ...BODY, sidebarsPerView: { ...sides, rightTab: 'no' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error: 'hive.config.json: "sidebarsPerView.rightTab" must be true or false' });
  assert.deepEqual(await onDisk(), sides, 'rejected before the write');
});

test('POST /settings writes notifications, an omitted key keeps the saved one, and a first setup without it is a 400 (#199)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).notifications;
  const { notifications: _notifications, ...withoutNotifications } = BODY;
  const first = await postSettings(base, withoutNotifications);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "notifications" must be an object with waiting, approval, pr, failed' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  const some = { waiting: false, approval: true, pr: true, failed: false };
  assert.equal((await postSettings(base, { ...BODY, notifications: some })).status, 200);
  assert.deepEqual(await onDisk(), some);
  assert.equal((await postSettings(base, withoutNotifications)).status, 200);
  assert.deepEqual(await onDisk(), some, 'an API caller that omits it keeps the saved one');
  const bad = await postSettings(base, { ...BODY, notifications: { ...some, pr: 'no' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error: 'hive.config.json: "notifications.pr" must be true or false' });
  assert.deepEqual(await onDisk(), some, 'rejected before the write');
});

test('POST /settings saves signals: a first setup without it is a 400, an omitted key keeps the saved one, a change reaches the state (#727)', async (t) => {
  const { base, home, server } = await start(t);
  const { signals: _omitted, ...withoutSignals } = BODY;
  const refused = await postSettings(base, withoutSignals);
  assert.equal(refused.status, 400);
  assert.match((await json<{ error: string }>(refused)).error, /"signals" must be an object with green, yellow, red, onOpen/);
  assert.equal((await postSettings(base, BODY)).status, 200);
  const looser = { ...SIGNALS_DEFAULTS, yellow: { ...SIGNALS_DEFAULTS.yellow, newTasks: 'always' } };
  assert.equal((await postSettings(base, { ...BODY, signals: looser })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).signals, looser);
  assert.equal((await postSettings(base, withoutSignals)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(home), 'utf8')) as Config).signals, looser, 'an omitted key keeps the saved one');
  await waitFor(async () => (isDeepStrictEqual(server.getState()?.signals, looser) ? true : undefined)); // reconfigure copies it into the state
});

test('the first save boots on the config\'s signals: onOpen green opens green, the default opens yellow (#727)', async (t) => {
  const plain = await start(t);
  assert.equal((await postSettings(plain.base, BODY)).status, 200);
  assert.equal(plain.server.getState()?.signal, 'yellow');
  const open = await start(t);
  assert.equal((await postSettings(open.base, { ...BODY, signals: { ...SIGNALS_DEFAULTS, onOpen: 'green' } })).status, 200);
  assert.equal(open.server.getState()?.signal, 'green');
});

test('POST /settings writes editor, an omitted key keeps the saved one, a first setup without it is a 400, and a scope naming a workspace the body lacks is refused (#780)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).editor;
  const { editor: _editor, ...withoutEditor } = BODY;
  const first = await postSettings(base, withoutEditor);
  assert.equal(first.status, 400);
  assert.match(String((await json(first) as { error: string }).error), /^hive\.config\.json: editor is required/);
  await assert.rejects(stat(configFile(home)), 'nothing written');
  const editor = { formatOnSave: { enabled: false, workspaces: 'all' }, languages: { python: { formatters: { ruff: { enabled: false, args: ['--x'], workspaces: 'all' } } } } } as const;
  assert.equal((await postSettings(base, { ...BODY, editor })).status, 200);
  assert.deepEqual(await onDisk(), editor);
  assert.equal((await postSettings(base, withoutEditor)).status, 200);
  assert.deepEqual(await onDisk(), editor, 'an API caller that omits it keeps the saved one');
  const bad = await postSettings(base, { ...BODY, editor: { ...editor, formatOnSave: { enabled: true, workspaces: ['ghost'] } } });
  assert.equal(bad.status, 400);
  assert.match(String((await json(bad) as { error: string }).error), /editor\.formatOnSave\.workspaces names workspace ghost/);
  assert.deepEqual(await onDisk(), editor, 'rejected before the write');
});

test('POST /settings writes the reviewer defaults on a first save, keeps the saved reviewer when the body has none, and refuses a malformed one naming the key (#328)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).reviewer;
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.deepEqual(await onDisk(), REVIEWER_DEFAULTS, 'a body without it, as the Settings form sends, writes the defaults');
  const mine = { on: false, when: 'demand', agent: 'codex', model: 'opus', version: 'strict' } as const;
  assert.equal((await postSettings(base, { ...BODY, reviewer: mine })).status, 200);
  assert.deepEqual(await onDisk(), mine);
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.deepEqual(await onDisk(), mine, 'a Settings save without reviewer keeps the saved one');
  const bad = await postSettings(base, { ...BODY, reviewer: { ...mine, when: 'always' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error: 'hive.config.json: "reviewer.when" must be one of: type, save, demand' });
  assert.deepEqual(await onDisk(), mine, 'refused before the write');
});

test('POST /settings writes terminalFont trimmed, "" included; an omitted key keeps the saved one, and a first setup without it or a name with a quote is a 400 (#376)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).terminalFont;
  const { terminalFont: _terminalFont, ...withoutFont } = BODY;
  const first = await postSettings(base, withoutFont);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "terminalFont" must be a string ("" = the system monospace)' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  assert.equal((await postSettings(base, { ...BODY, terminalFont: '  MesloLGS NF ' })).status, 200);
  assert.equal(await onDisk(), 'MesloLGS NF');
  assert.equal((await postSettings(base, withoutFont)).status, 200);
  assert.equal(await onDisk(), 'MesloLGS NF', 'an API caller that omits it keeps the saved one');
  const bad = await postSettings(base, { ...BODY, terminalFont: 'Meslo"NF' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error: 'hive.config.json: "terminalFont" must be one font family name, without ", \\ or control characters' });
  assert.equal(await onDisk(), 'MesloLGS NF', 'rejected before the write');
  assert.equal((await postSettings(base, { ...BODY, terminalFont: '' })).status, 200);
  assert.equal(await onDisk(), '', 'a cleared field is the system monospace, saved as such');
});

test('POST /settings writes consoleLines; an omitted key keeps the saved value, and a first setup without it or one out of 100..100000 is a 400 (#353)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).consoleLines;
  const { consoleLines: _consoleLines, ...withoutLines } = BODY;
  const error = 'hive.config.json: "consoleLines" must be an integer from 100 to 100000';
  const first = await postSettings(base, withoutLines);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  assert.equal((await postSettings(base, { ...BODY, consoleLines: 20_000 })).status, 200);
  assert.equal(await onDisk(), 20_000);
  assert.equal((await postSettings(base, withoutLines)).status, 200);
  assert.equal(await onDisk(), 20_000, 'an API caller that omits it keeps the saved value');
  const bad = await postSettings(base, { ...BODY, consoleLines: 99 });
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error });
  assert.equal(await onDisk(), 20_000, 'rejected before the write');
});

test('POST /settings writes trustedDomains trimmed, lowercased and without duplicates; an omitted key keeps the saved list, and a first setup without it or an entry with a scheme is a 400 (#404)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).trustedDomains;
  const { trustedDomains: _trustedDomains, ...withoutDomains } = BODY;
  const first = await postSettings(base, withoutDomains);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "trustedDomains" must be an array of host names ([] = every link asks)' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  assert.equal((await postSettings(base, { ...BODY, trustedDomains: [' GitHub.com ', 'github.com', 'docs.example.com'] })).status, 200);
  assert.deepEqual(await onDisk(), ['github.com', 'docs.example.com']);
  assert.equal((await postSettings(base, withoutDomains)).status, 200);
  assert.deepEqual(await onDisk(), ['github.com', 'docs.example.com'], 'an API caller that omits it keeps the saved list');
  const bad = await postSettings(base, { ...BODY, trustedDomains: ['https://github.com'] });
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error: 'hive.config.json: "trustedDomains" holds "https://github.com", which is not a host name (like github.com: no scheme, port, path or *)' });
  assert.deepEqual(await onDisk(), ['github.com', 'docs.example.com'], 'rejected before the write');
  assert.equal((await postSettings(base, { ...BODY, trustedDomains: [] })).status, 200);
  assert.deepEqual(await onDisk(), [], 'an emptied list is saved as such: every link asks');
});

test('POST /settings writes shortcuts normalized; an omitted key keeps the saved map, and a first setup without it or a collision is a 400 (#449)', async (t) => {
  const { base, home } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).shortcuts;
  const { shortcuts: _shortcuts, ...withoutShortcuts } = BODY;
  const first = await postSettings(base, withoutShortcuts);
  assert.equal(first.status, 400);
  assert.deepEqual(await json(first), { error: 'hive.config.json: "shortcuts" must be an object of shortcut ids to a key binding or null ({} = every default)' });
  await assert.rejects(stat(configFile(home)), 'nothing written');
  const changed = { toggleRight: 'CmdOrCtrl+Shift+Y', clear: null };
  assert.equal((await postSettings(base, { ...BODY, shortcuts: { toggleRight: 'Shift+CmdOrCtrl+Y', clear: null } })).status, 200);
  assert.deepEqual(await onDisk(), changed);
  assert.equal((await postSettings(base, withoutShortcuts)).status, 200);
  assert.deepEqual(await onDisk(), changed, 'an API caller that omits it keeps the saved map');
  const clash = await postSettings(base, { ...BODY, shortcuts: { close: 'CmdOrCtrl+1' } }); // viewActivities' on every platform (#585, #746)
  assert.equal(clash.status, 400);
  assert.deepEqual(await json(clash), { error: 'hive.config.json: "shortcuts.viewActivities" and "shortcuts.close" are both CmdOrCtrl+1' });
  assert.deepEqual(await onDisk(), changed, 'rejected before the write');
  assert.equal((await postSettings(base, { ...BODY, shortcuts: {} })).status, 200);
  assert.deepEqual(await onDisk(), {}, 'Restaurar todos: every default');
});

test('POST /hooks/status answers in the effective language: the system one first, the saved one after', async (t) => {
  const { base } = await start(t, 0, { systemLanguage: 'pt' });
  assert.equal(await (await postStatus(base, STATUS_PAYLOAD, 'ghost')).text(), 'sessão 23% · semana 41%', 'setup mode: the system language');
  assert.equal((await postSettings(base, { ...BODY, language: 'en' })).status, 200);
  assert.equal(await (await postStatus(base, STATUS_PAYLOAD, 'ghost')).text(), 'session 23% · week 41%');
});

const DEVICE = { device_code: 'DC1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };

/** A server whose GitHub login talks to `tokenAnswers` instead of github.com, in its own config home. */
async function withLogin(t: TestContext, tokenAnswers: unknown[]): Promise<{ base: string; env: NodeJS.ProcessEnv }> {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'setup-cred-'), HIVE_GITHUB_CLIENT_ID: 'Ov23liTEST' };
  const doFetch = (async (url: string | URL) => {
    const target = String(url);
    if (target.endsWith('/login/device/code')) return jsonResponse(DEVICE);
    if (target.endsWith('/access_token')) return jsonResponse(tokenAnswers.shift() ?? { error: 'authorization_pending' });
    return jsonResponse({ data: { viewer: { login: 'ana' } } });
  }) as unknown as typeof fetch;
  const started = await start(t, undefined, { githubLogin: { fetch: doFetch, sleep: async () => {}, env } });
  return { base: started.base, env };
}

test('POST /settings/github/login answers the code at once and the auth route reports the flow, then the account, without ever showing the token', async (t) => {
  const { base, env } = await withLogin(t, [{ error: 'authorization_pending' }, { access_token: 'gho_secret' }]);
  assert.deepEqual(await json<GithubAuthStatus>(hiveFetch(`${base}/settings/github/auth`)), { connected: false });
  const started = await postJson(`${base}/settings/github/login`);
  assert.equal(started.status, 200);
  assert.deepEqual(await json(started), { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900 });
  const connected = await waitFor(async () => {
    const status = await json<GithubAuthStatus>(hiveFetch(`${base}/settings/github/auth`));
    return status.connected ? status : undefined;
  });
  assert.deepEqual(connected, { connected: true, login: 'ana' });
  assert.deepEqual(await readCredentials(env), { github: { token: 'gho_secret', login: 'ana' } });
  const body = await (await hiveFetch(`${base}/settings/github/auth`)).text();
  assert.ok(!body.includes('gho_secret'), body);
});

test('a login that fails leaves its reason on the auth route and nothing in the store; a device code that cannot be had is a 502', async (t) => {
  const { base, env } = await withLogin(t, [{ error: 'access_denied', error_description: 'the user cancelled the authorization' }]);
  assert.equal((await postJson(`${base}/settings/github/login`)).status, 200);
  const failed = await waitFor(async () => {
    const status = await json<GithubAuthStatus>(hiveFetch(`${base}/settings/github/auth`));
    return status.error ? status : undefined;
  });
  assert.equal(failed.connected, false);
  assert.match(failed.error as string, /the user cancelled the authorization/);
  assert.deepEqual(await readCredentials(env), {});
  const refusing = await start(t, undefined, {
    githubLogin: { fetch: (async () => jsonResponse({ error: 'device_flow_disabled' })) as unknown as typeof fetch, sleep: async () => {}, env },
  });
  const res = await postJson(`${refusing.base}/settings/github/login`);
  assert.equal(res.status, 502);
  assert.match((await json<{ error: string }>(res)).error, /device_flow_disabled/);
});

test('a second login replaces the first: its poll stops (no further calls) and a token that lands after the abort is never stored', async (t) => {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'setup-cred-'), HIVE_GITHUB_CLIENT_ID: 'Ov23liTEST' };
  let deviceCalls = 0;
  let firstTokenCalls = 0;
  let secondTokenCalls = 0;
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const doFetch = (async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    if (target.endsWith('/login/device/code')) {
      deviceCalls += 1;
      return jsonResponse({ device_code: deviceCalls === 1 ? 'DC1' : 'DC2', user_code: deviceCalls === 1 ? 'ONE-CODE' : 'TWO-CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    }
    if (target.endsWith('/access_token')) {
      const { device_code: deviceCode } = Object.fromEntries(new URLSearchParams(String(init.body)));
      if (deviceCode === 'DC1') {
        firstTokenCalls += 1;
        if (firstTokenCalls === 1) return jsonResponse({ error: 'authorization_pending' });
        await firstGate; // stuck here, simulating a slow poll still in flight when the second login starts
        return jsonResponse({ access_token: 'gho_first' });
      }
      secondTokenCalls += 1;
      return jsonResponse({ access_token: 'gho_second' });
    }
    return jsonResponse({ data: { viewer: { login: 'ana' } } });
  }) as unknown as typeof fetch;
  const started = await start(t, undefined, { githubLogin: { fetch: doFetch, sleep: async () => {}, env } });
  assert.equal((await postJson(`${started.base}/settings/github/login`)).status, 200);
  await waitFor(async () => (firstTokenCalls === 2 ? true : undefined)); // the first flow is now parked on firstGate, mid-poll
  assert.equal((await postJson(`${started.base}/settings/github/login`)).status, 200); // replaces the first flow and aborts its controller
  const connected = await waitFor(async () => {
    const status = await json<GithubAuthStatus>(hiveFetch(`${started.base}/settings/github/auth`));
    return status.connected ? status : undefined;
  });
  assert.deepEqual(connected, { connected: true, login: 'ana' });
  assert.equal(secondTokenCalls, 1, 'the second flow authorized on its first poll, undelayed by the first');
  assert.deepEqual(await readCredentials(env), { github: { token: 'gho_second', login: 'ana' } }, 'the second flow, not the first, won the store');
  releaseFirst?.(); // let the first flow's stuck fetch resolve, arriving after its own abort
  await sleep(50); // give its .then a turn to (not) run
  assert.equal(firstTokenCalls, 2, 'the aborted flow made no further poll after the second login started');
  assert.deepEqual(await readCredentials(env), { github: { token: 'gho_second', login: 'ana' } }, 'the late, aborted token never overwrote the store');
  assert.deepEqual(await json<GithubAuthStatus>(hiveFetch(`${started.base}/settings/github/auth`)), { connected: true, login: 'ana' }, 'nor the reported status');
});

test('a login attempt that fails to get a device code leaves an already-running flow alone', async (t) => {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'setup-cred-'), HIVE_GITHUB_CLIENT_ID: 'Ov23liTEST' };
  let deviceCalls = 0;
  let tokenCalls = 0;
  let releaseSleep: (() => void) | undefined;
  const sleepGate = new Promise<void>((resolve) => { releaseSleep = resolve; });
  const doFetch = (async (url: string | URL) => {
    const target = String(url);
    if (target.endsWith('/login/device/code')) {
      deviceCalls += 1;
      // the first login gets a real device code; the second (the one under test) fails to get one at all
      return deviceCalls === 1 ? jsonResponse(DEVICE) : jsonResponse({ error: 'device_flow_disabled' }, 400);
    }
    if (target.endsWith('/access_token')) {
      tokenCalls += 1;
      return jsonResponse({ error: 'authorization_pending' });
    }
    return jsonResponse({ data: { viewer: { login: 'ana' } } });
  }) as unknown as typeof fetch;
  // Parks the running flow right before its second poll: a wrongly-set abort flag (the old bug: abort() ran
  // unconditionally before requestDeviceCode, even one that goes on to fail) would surface the moment it wakes.
  // Every call also yields to a real macrotask (setImmediate): a sleep that resolves instantly would let the loop
  // spin purely on microtasks against the real, unmocked deadline and starve the event loop until it crashes.
  const sleep = async () => {
    if (tokenCalls === 1) await sleepGate;
    await new Promise((resolve) => setImmediate(resolve));
  };
  const started = await start(t, undefined, { githubLogin: { fetch: doFetch, sleep, env } });
  assert.equal((await postJson(`${started.base}/settings/github/login`)).status, 200);
  await waitFor(async () => (tokenCalls === 1 ? true : undefined)); // first poll landed; now parked before the second
  const res = await postJson(`${started.base}/settings/github/login`); // the second attempt: fails before ever reaching the flow worker
  assert.equal(res.status, 502);
  releaseSleep?.();
  const status = await waitFor(async () => {
    const s = await json<GithubAuthStatus>(hiveFetch(`${started.base}/settings/github/auth`));
    return s.pending || s.error ? s : undefined;
  });
  assert.ok(status.pending, `the running flow must still be pending, not cancelled by the failed second attempt: ${JSON.stringify(status)}`);
  assert.equal(status.error, undefined);
});

test('the delete-activity scope reaches the state from the config: the first save boots with it and a later save that changes it replaces it (#236)', async (t) => {
  const { base, server } = await start(t);
  const scope = { session: true, transcripts: true, nonAutoTasks: false };
  assert.equal((await postSettings(base, { ...BODY, deleteActivity: scope })).status, 200);
  assert.deepEqual(server.getState()?.deleteActivity, scope, 'configure seeds it, whatever state.json saved');
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.deepEqual(server.getState()?.deleteActivity, DELETE_ACTIVITY_DEFAULTS, 'reconfigure dispatches setCleanup');
});

test('the shutdown window reaches the state from the config: the first save boots with it and a later save that changes it replaces it (#233)', async (t) => {
  const { base, server } = await start(t);
  assert.equal((await postSettings(base, { ...BODY, shutdownIdleMinutes: 45 })).status, 200);
  assert.equal(server.getState()?.shutdownIdleMinutes, 45, 'configure seeds it, whatever state.json saved');
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal(server.getState()?.shutdownIdleMinutes, SHUTDOWN_IDLE_DEFAULT, 'reconfigure dispatches setShutdownIdle');
});

test('the approval window reaches the state from the config: the first save boots with it and a later save that changes it replaces it (#268)', async (t) => {
  const { base, server } = await start(t);
  assert.equal((await postSettings(base, { ...BODY, approvalMinutes: 30 })).status, 200);
  assert.equal(server.getState()?.approvalMinutes, 30, 'configure seeds it, whatever state.json saved');
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal(server.getState()?.approvalMinutes, APPROVAL_MINUTES_DEFAULT, 'reconfigure dispatches setApprovalMinutes');
});

test('the rate-limit wait reaches the state from the config: the first save boots with it and a later save that changes it replaces it (#805)', async (t) => {
  const { base, server } = await start(t);
  assert.equal((await postSettings(base, { ...BODY, rateLimitWaitMinutes: 600 })).status, 200);
  assert.equal(server.getState()?.rateLimitWaitMinutes, 600, 'configure seeds it, whatever state.json saved');
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.equal(server.getState()?.rateLimitWaitMinutes, RATE_LIMIT_WAIT_DEFAULT, 'reconfigure dispatches setRateLimitWait');
});

test('POST /settings keeps each workspace\'s setup and timeout, and answers 400 naming the workspace and the line of the first setup line it cannot parse, saving nothing (#299)', async (t) => {
  const { base, home, repo } = await start(t);
  const saved = async (): Promise<Config> => JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
  const workspace = { name: 'hive', path: repo, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, color: 'oklch(0.72 0.12 25)', setup: '# the worktree\nCOPY .env\nRUN pnpm install', setupTimeout: '10m' };
  assert.equal((await postSettings(base, { ...BODY, workspaces: [workspace] })).status, 200);
  assert.deepEqual((await saved()).comb.workspaces, [workspace]);
  const bad = await postSettings(base, { ...BODY, workspaces: [{ ...workspace, setup: 'COPY .env\nRUN\nCOPY ../x' }] });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'hive: line 2: RUN needs an argument' }, 'the first bad line, named after its workspace');
  assert.deepEqual((await saved()).comb.workspaces, [workspace], 'nothing saved');
});

test('POST /settings keeps each workspace\'s teardown and its timeout, and answers 400 naming the workspace and the teardown line it cannot parse, saving nothing (#654)', async (t) => {
  const { base, home, repo } = await start(t);
  const saved = async (): Promise<Config> => JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
  const workspace = { name: 'hive', path: repo, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, color: 'oklch(0.72 0.12 25)', teardown: 'RUN docker compose down\nDEL tmp/', teardownTimeout: '2m' };
  assert.equal((await postSettings(base, { ...BODY, workspaces: [workspace] })).status, 200);
  assert.deepEqual((await saved()).comb.workspaces, [workspace]);
  const bad = await postSettings(base, { ...BODY, workspaces: [{ ...workspace, teardown: 'RUN true\nCOPY a b c' }] });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'hive: teardown line 2: COPY takes a source and at most one destination' });
  assert.deepEqual((await saved()).comb.workspaces, [workspace], 'nothing saved');
});

test('POST /settings writes the four sleep notice switches, and the prefix with one of them, a notice checkbox\'s body, changes that one alone (#672)', async (t) => {
  const { base, home } = await start(t);
  const saved = async (): Promise<Config> => JSON.parse(await readFile(configFile(home), 'utf8')) as Config;
  assert.equal((await postSettings(base, { ...BODY, sleepNotice: false, sleepAllNotice: false })).status, 200);
  const before = await saved();
  assert.deepEqual([before.sleepNotice, before.sleepAutoNotice, before.sleepIdleNotice, before.sleepAllNotice], [false, true, true, false]);
  const res = await hiveFetch(`${base}/settings`, { method: 'POST', headers: UI_HEADERS, body: JSON.stringify({ prefix: before.comb.prefix, sleepIdleNotice: false }) });
  assert.deepEqual(await json(res), { ok: true });
  assert.deepEqual(await saved(), { ...before, sleepIdleNotice: false });
});

test('POST /settings writes mcp\'s defaults on a first save, keeps the saved mcp when the body has none, and refuses a workspace rename under a scoped server, naming it (#333)', async (t) => {
  const { base, home, repo } = await start(t);
  const onDisk = async (): Promise<unknown> => (JSON.parse(await readFile(configFile(home), 'utf8')) as Config).mcp;
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.deepEqual(await onDisk(), MCP_DEFAULTS, 'a body without it, as the Settings form sends, writes the defaults');
  const mcp: McpSettings = { off: ['hive_remember'], servers: [{ name: 'figma', url: 'http://127.0.0.1:3845/mcp', workspace: WORKSPACE, on: true }] };
  assert.equal((await postSettings(base, { ...BODY, mcp })).status, 200);
  assert.equal((await postSettings(base, BODY)).status, 200);
  assert.deepEqual(await onDisk(), mcp, 'the Settings form never sends mcp: the saved one stays');
  // the source's default workspace follows the rename, so the server's scope is the one problem left
  const renamed = await postSettings(base, {
    ...BODY, workspaces: workspacesAt(repo).map((w) => ({ ...w, name: 'renamed' })),
    sources: [{ ...GITHUB_ENTRY, taskProps: { ...FIXED, defaults: { ...FIXED.defaults, workspace: 'renamed' } } }],
  });
  assert.equal(renamed.status, 400);
  assert.deepEqual(await json(renamed), { error: `hive.config.json: "mcp.servers": figma is scoped to ${WORKSPACE}, which no longer exists` });
  assert.deepEqual(await onDisk(), mcp, 'refused before the write');
});
