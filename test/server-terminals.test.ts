import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { localActivityId } from '../src/activities.js';
import { join } from 'node:path';
import { PROTOCOL_DIR } from '../src/hooks-settings.js';
import { createServer, type HiveServer } from '../src/server.js';
import type { Exec, OpenResult, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, WORKSPACE, workspacesAt, STAGES, fakeSourceFactory, fakeSpawn, type FakeWorker, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// A workspace's kept terminals end to end (#696): the routes, the reducer and the pool's launches. No worker (maxConcurrent 0).
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};
const LOCAL = encodeURIComponent(localActivityId(WORKSPACE));

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

const refused = async (res: Promise<Response>, status: number, error: string, why: string): Promise<void> => {
  const answer = await res;
  assert.deepEqual([answer.status, await answer.json()], [status, { error }], why);
};

interface Started { base: string; server: HiveServer; workers: FakeWorker[]; repo: string; calls: string[][]; home: string }

// A Hive whose one workspace is WORKSPACE at `repo`; every command is recorded, none runs
async function start(t: TestContext): Promise<Started> {
  const { home, repo } = await tempHive(t);
  const { spawn, workers } = fakeSpawn();
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: '' };
  };
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  return { base, server, workers, repo, calls, home };
}

// The local activity's new terminal: its pty id
const openShell = async (base: string): Promise<string> => ((await (await postJson(`${base}/activities/${LOCAL}/shell`)).json()) as OpenResult).ptyId ?? '';

// The shim's register (#696, #932): the form its curl posts, url-encoded
const register = (base: string, id: string, form: Record<string, string> = { agent: 'claude' }): Promise<Response> =>
  hiveFetch(`${base}/hooks/terminals/${id}/session`, { method: 'POST', body: new URLSearchParams(form) });

test('a terminal stopped sleeps, wakes in its own id where it was, and is forgotten on demand; a live or unknown one is refused (#696)', async (t) => {
  const { base, server, workers, repo } = await start(t);
  const id = await openShell(base);
  const asleep = (): boolean => server.getState()?.terminals[0]?.asleep === true;
  await refused(postJson(`${base}/terminals/${id}/wake`), 409, 'o terminal não está dormindo', 'a live terminal');
  assert.equal((await postJson(`${base}/ptys/${id}/stop`)).status, 200);
  await waitFor(asleep);
  workers[0].handlers.onExit(); // the pty's exit after the kill
  assert.equal((await postJson(`${base}/ptys/${id}/stop`)).status, 404, 'nothing live to stop');
  assert.deepEqual(await (await hiveFetch(`${base}/ptys`)).json(), { active: 0, ptys: [] }, 'the menu bar lists no sleeping terminal');
  const woken = (await (await postJson(`${base}/terminals/${id}/wake`)).json()) as OpenResult;
  assert.deepEqual([woken, workers[1].launch.ptyId, workers[1].launch.cwd, asleep()], [{ ok: true, ptyId: id }, id, repo, false]);
  assert.equal((await postJson(`${base}/ptys/${id}/stop`)).status, 200);
  await waitFor(asleep);
  workers[1].handlers.onExit();
  assert.equal((await postJson(`${base}/terminals/${id}/forget`)).status, 200);
  assert.deepEqual(server.getState()?.terminals, []);
  await refused(postJson(`${base}/terminals/${id}/forget`), 404, 'terminal desconhecido', 'forgotten');
});

test('a wake while the old pty is still dying is refused with 409, and goes through once its exit came (#696)', async (t) => {
  const { base, server, workers } = await start(t);
  const id = await openShell(base);
  assert.equal((await postJson(`${base}/ptys/${id}/stop`)).status, 200);
  await waitFor(() => server.getState()?.terminals[0]?.asleep === true);
  await refused(postJson(`${base}/terminals/${id}/wake`), 409, 'o terminal ainda está terminando', 'its pty has not exited yet');
  assert.equal(workers.length, 1, 'nothing spawned');
  workers[0].handlers.onExit();
  assert.deepEqual(await (await postJson(`${base}/terminals/${id}/wake`)).json(), { ok: true, ptyId: id });
});

test('a clean Quit sleeps every live terminal before its kills, so the next boot finds it asleep (#696)', async (t) => {
  const { base, server } = await start(t);
  await openShell(base);
  await server.close();
  assert.deepEqual([server.getState()?.terminals[0]?.asleep, server.getState()?.cleanStop], [true, true]);
});

test('a terminal spawns with its own history and ring files, and a woken one in the start dir once its held cwd is gone (#696)', async (t) => {
  const { base, server, workers, repo } = await start(t);
  const id = await openShell(base);
  assert.match(workers[0].launch.env?.HISTFILE ?? '', new RegExp(`/terminals/${id}\\.history$`));
  assert.match(workers[0].launch.keep?.log ?? '', new RegExp(`/terminals/${id}\\.log$`));
  await server.dispatch({ type: 'sleepTerminal', terminalId: id, cwd: `${repo}/gone` });
  workers[0].handlers.onExit();
  await server.dispatch({ type: 'wakeTerminal', terminalId: id });
  assert.equal(workers[1].launch.cwd, repo);
});

test('the shim\'s register refuses without the secret, captures a free session of the terminal\'s activity with the args claude gets, and Stop kills that claude by its run\'s MCP config path, never by its session id (#696)', async (t) => {
  const { base, server, calls } = await start(t);
  const id = await openShell(base);
  const url = `${base}/hooks/terminals/${id}/session`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 403, 'no secret');
  const [runId, ...argv] = (await (await register(base, id)).text()).split('\n');
  const worker = server.getState()?.workers.find((w) => w.runId === runId);
  assert.ok(worker?.sessionId);
  assert.deepEqual([worker.terminalId, worker.freeSession, worker.activityId], [id, true, localActivityId(WORKSPACE)]);
  assert.deepEqual([argv[0], argv[2], argv[4]], ['--mcp-config', '--settings', '--plugin-dir'], 'one arg per line, unquoted');
  assert.match(argv[1], /\.mcp\.json$/);
  assert.deepEqual(argv.slice(-2), ['--session-id', worker.sessionId]);
  assert.equal(argv.includes('--append-system-prompt-file'), false, 'no protocol on a local activity');
  await refused(register(base, crypto.randomUUID()), 409, 'nenhum terminal vivo com esse id', 'unknown terminal');
  assert.equal((await postJson(`${base}/ptys/${runId}/stop`)).status, 200);
  assert.deepEqual(calls.at(-1), ['pkill', '-f', '--', `${runId}\\.mcp\\.json`], 'the --mcp-config path in its argv, which a /clear keeps and no other process carries');
  assert.equal(server.getState()?.workers.some((w) => w.runId === runId), false, 'its run ended');
});

test('every terminal route answers 404 on an id that is not a uuid, before it reads or dispatches anything (#696)', async (t) => {
  const { base, server } = await start(t);
  await openShell(base);
  const before = server.getState();
  for (const [url, method] of [['/terminals/nope/wake', 'POST'], ['/terminals/nope/forget', 'POST'], ['/terminals/..%2F..%2Fx/agents', 'GET'], ['/hooks/terminals/nope/session', 'POST']]) {
    const answer = method === 'GET' ? hiveFetch(`${base}${url}`) : url.startsWith('/hooks/') ? hiveFetch(`${base}${url}`, { method }) : postJson(`${base}${url}`);
    await refused(answer, 404, 'terminal desconhecido', url);
  }
  assert.equal(server.getState(), before, 'nothing was dispatched');
});

test('GET /terminals/:id/agents answers a live terminal\'s stray agents, none under the fake spawner, and 404 once it sleeps (#696)', async (t) => {
  const { base, server, workers } = await start(t);
  const id = await openShell(base);
  assert.deepEqual(await (await hiveFetch(`${base}/terminals/${id}/agents`)).json(), { agents: [] }, 'no pty pid under the fake spawner: nothing to read');
  await server.dispatch({ type: 'sleepTerminal', terminalId: id });
  workers[0].handlers.onExit();
  await refused(hiveFetch(`${base}/terminals/${id}/agents`), 404, 'terminal desconhecido', 'a sleeping terminal runs nothing');
});

test('a claude typed in a task\'s terminal is told the session protocol of the task\'s workspace, its memory under it (#696, #797)', async (t) => {
  const { base, server, home } = await start(t);
  await server.dispatch({ type: 'createTask', title: 'T', body: '', stage: STAGES[0].name, prefix: 'HIVE', workspace: WORKSPACE, auto: false });
  const opened = (await (await postJson(`${base}/tasks/local:1/open`, { kind: 'terminal' })).json()) as OpenResult;
  assert.ok(opened.ptyId, 'the task\'s terminal runs');
  const [, ...argv] = (await (await register(base, opened.ptyId ?? '')).text()).split('\n');
  assert.equal(argv[argv.indexOf('--append-system-prompt-file') + 1], join(home, PROTOCOL_DIR, 'workspaces', WORKSPACE, 'session.md'));
});

test('a claude captured in a task\'s terminal records the stage start first when the stage has none, as a free session\'s open does (#812)', async (t) => {
  const { base, server, calls } = await start(t);
  await server.dispatch({ type: 'createTask', title: 'T', body: '', stage: STAGES[0].name, prefix: 'HIVE', workspace: WORKSPACE, auto: false });
  const opened = (await (await postJson(`${base}/tasks/local:1/open`, { kind: 'terminal' })).json()) as OpenResult;
  const before = calls.length;
  assert.equal((await register(base, opened.ptyId ?? '')).status, 200);
  assert.ok(calls.slice(before).some((c) => c.includes('rev-parse') && c.includes('HEAD')), JSON.stringify(calls.slice(before))); // the fake git prints no sha: nothing is kept
});

test('a codex register answers codex\'s launch argv with the posted folder trusted and no resume; its worker is codex\'s with no session id (#932)', async (t) => {
  const { base, server, repo } = await start(t);
  const id = await openShell(base);
  const cwd = join(repo, 'src');
  const reply = await (await register(base, id, { agent: 'codex', cwd })).text();
  const [runId, ...argv] = reply.split('\n');
  const worker = server.getState()?.workers.find((w) => w.runId === runId);
  assert.deepEqual([worker?.agent, worker?.sessionId, worker?.freeSession, worker?.terminalId], ['codex', undefined, true, id]);
  assert.equal(argv[0], '-c', 'a new conversation: no resume');
  assert.ok(argv.includes(`projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`), argv.join(' '));
  assert.equal(argv.some((arg) => arg.startsWith('mcp_servers.hive')), false, 'a local activity: no Hive MCP');
  assert.equal(reply.includes(SECRET), false);
});

test('a register whose folder is missing, relative, split or outside the terminal\'s trusts the terminal\'s own; an unknown or missing agent is refused and captures nothing (#932)', async (t) => {
  const { base, server, repo } = await start(t);
  const id = await openShell(base);
  const trusted = `projects={${JSON.stringify(repo)}={trust_level="trusted"}}`;
  const forms: Record<string, string>[] = [{ agent: 'codex' }, { agent: 'codex', cwd: 'src' }, { agent: 'codex', cwd: `${repo}/a\nb` }, { agent: 'codex', cwd: '/elsewhere' }];
  for (const form of forms) {
    const [, ...argv] = (await (await register(base, id, form)).text()).split('\n');
    assert.ok(argv.includes(trusted), JSON.stringify(form));
  }
  const before = server.getState()?.workers.length;
  const message = 'agent precisa ser um destes agentes: claude, codex';
  await refused(register(base, id, { agent: 'gemini' }), 400, message, 'an unknown agent');
  await refused(hiveFetch(`${base}/hooks/terminals/${id}/session`, { method: 'POST' }), 400, message, 'no form at all');
  assert.equal(server.getState()?.workers.length, before);
});

test('a codex typed in a task\'s terminal gets the Hive\'s MCP server under its run id and the session protocol as text; the secret stays out of the reply (#932)', async (t) => {
  const { base, server } = await start(t);
  await server.dispatch({ type: 'createTask', title: 'T', body: '', stage: STAGES[0].name, prefix: 'HIVE', workspace: WORKSPACE, auto: false });
  const opened = (await (await postJson(`${base}/tasks/local:1/open`, { kind: 'terminal' })).json()) as OpenResult;
  const reply = await (await register(base, opened.ptyId ?? '', { agent: 'codex', cwd: '/w' })).text();
  const [runId, ...argv] = reply.split('\n');
  assert.ok(argv.includes(`mcp_servers.hive.http_headers={"x-hive-pty"="${runId}"}`), 'what Stop\'s pkill matches');
  assert.ok(argv.some((arg) => arg.startsWith('developer_instructions=')), 'the session protocol, as text');
  assert.equal(reply.includes(SECRET), false);
});
