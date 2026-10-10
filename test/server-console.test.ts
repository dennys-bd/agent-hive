import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ChannelView, timeoutLine } from '../src/console.js';
import { createServer, type HiveServer } from '../src/server.js';
import type { Exec, OpenResult, Command, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, WORKSPACE, STAGES, fakeSourceFactory, fakePtys, type FakePty, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { workPath } from './fixtures/work.js';

// The console end to end (#353): no launchPty is injected, so every terminal runs in the server's own pty host over a fake pty, and a run
// command's output reaches its channel the way it does in the daemon.
const TEST: Command = { name: 'test', impls: [{ workspace: WORKSPACE, command: 'pnpm test' }], menu: true, env: {} };

const TASK = 'board:I1'; // the fake board's task, #1
const CHANNEL = 'command:hive:test';
const BODY: Omit<SettingsBody, 'workspaces' | 'commands'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} },
};
const noGit: Exec = async () => ({ stdout: '' }); // the worktree step's git answers nothing: the task still gets its path
const HEADER = /^── #1 · \d\d:\d\d:\d\d ──\r\n$/;
const SETUP = { id: 'setup', kind: 'setup', label: 'Setup worktree', status: 'done' }; // start()'s first open prepared the worktree (#576)

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const getJson = async (url: string): Promise<[number, unknown]> => {
  const res = await hiveFetch(url);
  return [res.status, await res.json()];
};
const channelUrl = (base: string, id: string): string => `${base}/console/${encodeURIComponent(id)}`;

// A Hive whose one workspace runs `command` (TEST unless given), with the task's worktree made by a plain terminal (ptys[0])
async function start(t: TestContext, command: Command = TEST): Promise<{ base: string; ptys: FakePty[]; server: HiveServer }> {
  const { home, repo } = await tempHive(t);
  const { spawnPty, ptys } = fakePtys();
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, spawnPty, exec: noGit });
  const port = await server.listen(0);
  t.after(async () => {
    for (const pty of ptys) pty.exit(); // a fake pty's kill exits nothing, and close() awaits every run's exit
    await server.close();
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: [{ name: WORKSPACE, path: repo, env: {}, fork: null }], commands: [command] })).status, 200);
  await server.poll();
  assert.equal((await postJson(`${base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200);
  return { base, ptys, server };
}

test('GET /console is 409 before a setup; once configured it lists no channel, a plain terminal feeds none, and an unknown channel is a 404 (#353)', async (t) => {
  const { home } = await tempHive(t);
  const bare = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory });
  const port = await bare.listen(0);
  t.after(() => bare.close());
  assert.equal((await hiveFetch(`http://127.0.0.1:${port}/console`)).status, 409);
  const { base, ptys } = await start(t);
  ptys[0].emit('a plain terminal prints\r\n');
  assert.deepEqual(await getJson(`${base}/console`), [200, [SETUP]], 'a plain terminal feeds no channel');
  assert.deepEqual(await getJson(channelUrl(base, 'command:hive:nope')), [404, { error: 'canal desconhecido' }]);
});

test('a run command\'s pty feeds its channel: live with its header while it runs, then in the history, header first, once the pty exits (#353)', async (t) => {
  const { base, ptys, server } = await start(t);
  const run = (await (await postJson(`${base}${workPath(server, TASK)}/run`, { command: 'test' })).json()) as OpenResult;
  const pty = ptys[1];
  pty.emit('ok 1\r\n');
  assert.deepEqual(await getJson(`${base}/console`), [200, [{ id: CHANNEL, kind: 'command', label: 'hive · test', status: 'running' }, SETUP]]);
  const [, live] = (await getJson(channelUrl(base, CHANNEL))) as [number, ChannelView];
  assert.deepEqual([live.history, live.live.map((r) => r.ptyId)], ['', [run.ptyId]]);
  assert.match(live.live[0].header, HEADER);
  pty.exit();
  const [, ended] = (await getJson(channelUrl(base, CHANNEL))) as [number, ChannelView];
  assert.deepEqual([ended.history, ended.live], [`${live.live[0].header}ok 1\r\n`, []]);
});

test('a run command that exits non-zero leaves its channel failed; POST /console/:id/clear empties its history, and an unknown channel is a 404 (#537)', async (t) => {
  const { base, ptys, server } = await start(t);
  await postJson(`${base}${workPath(server, TASK)}/run`, { command: 'test' });
  ptys[1].emit('boom\r\n');
  ptys[1].exit(1);
  const [, listed] = (await getJson(`${base}/console`)) as [number, { status: string }[]];
  assert.equal(listed[0].status, 'failed');
  assert.equal((await postJson(`${channelUrl(base, CHANNEL)}/clear`)).status, 200);
  const [, cleared] = (await getJson(channelUrl(base, CHANNEL))) as [number, ChannelView];
  assert.deepEqual([cleared.history, cleared.live], ['', []]);
  assert.equal((await postJson(`${channelUrl(base, 'command:hive:nope')}/clear`)).status, 404);
});

// A timer fires on its own schedule: poll until the check holds, up to 3 s.
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i += 1) await sleep(10);
  assert.ok(check(), 'condition not met in time');
}

test('a run command with a timeout is stopped when it runs out, and its console run says so (#511)', async (t) => {
  const { base, ptys, server } = await start(t, { ...TEST, timeout: '1s' });
  const run = (await (await postJson(`${base}${workPath(server, TASK)}/run`, { command: 'test' })).json()) as OpenResult;
  const pty = ptys[1];
  await waitFor(() => pty.killed > 0);
  pty.exit();
  const [, ended] = (await getJson(channelUrl(base, CHANNEL))) as [number, ChannelView];
  assert.ok(ended.history.endsWith(timeoutLine('1s')), JSON.stringify(ended.history));
  const [, listed] = (await getJson(`${base}/console`)) as [number, { status: string }[]];
  assert.equal(listed[0].status, 'failed', 'a timeout reads as a failure, whatever the kill exited with (#537)');
  await waitFor(() => !server.getState()?.terminals.some((s) => s.terminalId === run.ptyId));
});

test('a run that ends before its timeout is never stopped by it; a command without a timeout is never stopped (#511)', async (t) => {
  const quick = await start(t, { ...TEST, timeout: '1s' });
  await postJson(`${quick.base}${workPath(quick.server, TASK)}/run`, { command: 'test' });
  quick.ptys[1].exit();
  const open = await start(t);
  await postJson(`${open.base}${workPath(open.server, TASK)}/run`, { command: 'test' });
  await sleep(1_300);
  assert.deepEqual([quick.ptys[1].killed, open.ptys[1].killed], [0, 0]);
});
