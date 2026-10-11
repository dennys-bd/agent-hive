import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { activityOf, localActivityId, taskOfActivity } from '../src/activities.js';
import { shimDir } from '../src/claude-shim.js';
import { createServer, type HiveServer } from '../src/server.js';
import { ptyCommand } from '../src/spawn.js';
import type { Exec, OpenResult, Command, SettingsBody, WorkspaceFork } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, WORKSPACE, STAGES, fakeSourceFactory, fakeSpawn, type FakeWorker, tempHive } from './fakes.js';
import { tempDir } from './temp-dir.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { workId, workPath } from './fixtures/work.js';

// A workspace's run commands on a task (#300), end to end through the server: the route, the reducer's Terminal and the pool's launch.
const FRONT_LINE = 'pnpm run dev -- --port $PORT';
const FRONT: Command = { name: 'Run Frontend', impls: [{ workspace: WORKSPACE, command: FRONT_LINE }], menu: true, env: { PORT: '5173' } };
const TASK = 'board:I1'; // the fake board's task
// No worker: the fake source's task waits in fila, so every run below is a terminal the test opened.
const BODY: Omit<SettingsBody, 'workspaces' | 'commands'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} },
};
const noGit: Exec = async () => ({ stdout: '' }); // the worktree step's git answers nothing: the task still gets its path

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });

// A spawn failure is dispatched without awaiting, like a real process event: poll the state until it settles.
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

// A Hive whose one workspace runs FRONT, with `env` as the workspace's own (#348). The task has no worktree yet: POST /open { kind: 'terminal' }
// makes it, with a plain terminal. `extra` adds workspaces and commands beside them (#511).
async function start(t: TestContext, env: Record<string, string> = {}, extra: Pick<SettingsBody, 'workspaces' | 'commands'> = { workspaces: [], commands: [] }): Promise<{ base: string; server: HiveServer; workers: FakeWorker[]; home: string }> {
  const { home, repo } = await tempHive(t);
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec: noGit });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: [{ name: WORKSPACE, path: repo, env, fork: null, memoryCap: 4000 }, ...extra.workspaces], commands: [FRONT, ...(extra.commands ?? [])] })).status, 200);
  await server.poll();
  return { base, server, workers, home };
}

test('a run command launches with the workspace\'s env and exports only its own over it, so the command wins a shared name; a plain terminal gets the workspace\'s env too (#348, #738)', async (t) => {
  const { base, server, workers } = await start(t, { PORT: '3000', NODE_ENV: 'development' });
  assert.equal((await postJson(`${base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200);
  assert.deepEqual([workers[0].launch.run, workers[0].launch.env?.PORT], [undefined, '3000']);
  await server.dispatch({ type: 'openTerminal', activityId: workId(server.getState()!, TASK), command: FRONT.name });
  await waitFor(() => workers.length === 2);
  assert.deepEqual([workers[1].launch.env, workers[1].launch.run], [{ PORT: '3000', NODE_ENV: 'development' }, { command: FRONT_LINE, env: { PORT: '5173' } }]);
  assert.match(ptyCommand(workers[1].launch), /export PORT='5173' && /, 'the command\'s export runs after the pty\'s env is set');
});

const ENV = { NODE_ENV: 'development', API_BASE: '/api' };
const hasEnv = (worker: FakeWorker): boolean => Object.entries(ENV).every(([name, value]) => worker.launch.env?.[name] === value);

test('a stage run launches with the workspace\'s env (#738)', async (t) => {
  const { base, workers } = await start(t, ENV);
  assert.deepEqual(await (await postJson(`${base}/tasks/${TASK}/start`, { base: null })).json(), { ok: true });
  await waitFor(() => workers.length === 1);
  assert.deepEqual([workers[0].launch.terminal, workers[0].launch.env], [undefined, ENV]);
});

test('a task\'s terminal and session, the workspace\'s local session and its shell all launch with the workspace\'s env (#738)', async (t) => {
  const { base, server, workers } = await start(t, ENV);
  assert.equal((await postJson(`${base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200);
  assert.equal((await postJson(`${base}/tasks/${TASK}/open`, { kind: 'claude' })).status, 200);
  await server.dispatch({ type: 'newLocalSession', activityId: localActivityId(WORKSPACE) });
  assert.equal((await postJson(`${base}/activities/${encodeURIComponent(localActivityId(WORKSPACE))}/shell`)).status, 200);
  await waitFor(() => workers.length === 4);
  assert.deepEqual(workers.map(hasEnv), [true, true, true, true], 'task terminal, task session, local session, workspace shell');
  assert.deepEqual([workers[1].launch.env, workers[2].launch.env], [ENV, ENV], 'a session gets the workspace\'s env and nothing else');
});

test('a kept terminal puts the shim dir before the workspace\'s PATH, or before the Hive\'s when the workspace sets none, and its own HISTFILE wins (#696, #738)', async (t) => {
  const { base, workers, home } = await start(t, { PATH: '/ws/bin', HISTFILE: '/elsewhere/shared.history', NODE_ENV: 'development' });
  assert.equal((await postJson(`${base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200);
  const env = workers[0].launch.env;
  assert.deepEqual([env?.PATH, env?.NODE_ENV], [`${shimDir(home)}:/ws/bin`, 'development']);
  assert.match(env?.HISTFILE ?? '', /\/terminals\/[^/]+\.history$/);
  const plain = await start(t);
  assert.equal((await postJson(`${plain.base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200);
  assert.equal(plain.workers[0].launch.env?.PATH, `${shimDir(plain.home)}:${process.env.PATH ?? ''}`);
});

test('POST /tasks/:id/open with kind terminal opens a Terminal through openTerminal and answers its pty id; the retired kind shell is 400 and opens nothing (#570)', async (t) => {
  const { base, server, workers } = await start(t);
  const bad = await postJson(`${base}/tasks/${TASK}/open`, { kind: 'shell' });
  assert.deepEqual([bad.status, await bad.json(), workers.length], [400, { error: 'kind precisa ser terminal ou claude' }, 0]);
  const answer = (await (await postJson(`${base}/tasks/${TASK}/open`, { kind: 'terminal' })).json()) as OpenResult;
  const terminal = server.getState()?.terminals[0];
  assert.ok(terminal);
  assert.deepEqual([answer, taskOfActivity(server.getState()!, terminal.activityId)?.item.itemId, terminal.command, workers[0].launch.terminal], [{ ok: true, ptyId: terminal.terminalId }, TASK, undefined, true]);
  assert.equal(server.getState()?.workers.some((w) => w.freeSession), false, 'no session opened');
});

test('a terminal opened with a command runs the workspace\'s command in the task\'s worktree: the launch carries its line and env, the state only its name; a name the config no longer has ends in spawnFailed and runs nothing (#300)', async (t) => {
  const { base, server, workers } = await start(t);
  assert.deepEqual(server.getState()?.commands, { hive: ['Run Frontend'] }, 'the save carried the names into the state');
  assert.equal((await postJson(`${base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200); // the worktree, and workers[0]: a plain terminal
  assert.equal(workers[0].launch.run, undefined, 'a plain terminal runs no command');
  await server.dispatch({ type: 'openTerminal', activityId: workId(server.getState()!, TASK), command: FRONT.name });
  await waitFor(() => workers.length === 2);
  const { launch } = workers[1];
  assert.deepEqual([launch.terminal, launch.run, launch.cwd], [true, { command: FRONT_LINE, env: FRONT.env }, workers[0].launch.cwd]);
  assert.equal(launch.protocolPath, undefined, 'a command runs no agent: no protocol (#167)');
  assert.equal(server.getState()?.terminals.at(-1)?.command, FRONT.name);
  await server.dispatch({ type: 'openTerminal', activityId: workId(server.getState()!, TASK), command: 'Gone' }); // a click a save raced
  await waitFor(() => server.getState()?.error !== undefined);
  assert.equal(server.getState()?.error, 'comando "Gone" não está habilitado no workspace hive');
  assert.deepEqual([workers.length, server.getState()?.terminals.length], [2, 2], 'nothing else ran, and the failed terminal left the state');
});

test('POST /activities/:id/run: 404 an unknown activity or none yet, 409 tarefa sem worktree once gone from disk, 400 comando desconhecido; a known name answers the run\'s ptyId like /open (#300)', async (t) => {
  const { base, server } = await start(t);
  const run = (id: string, command: unknown): Promise<Response> => postJson(`${base}${workPath(server, id)}/run`, { command });
  const refused = async (res: Promise<Response>, status: number, error: string, why: string): Promise<void> => {
    const answer = await res;
    assert.deepEqual([answer.status, await answer.json()], [status, { error }], why);
  };
  await refused(run('nope', FRONT.name), 404, 'atividade desconhecida', 'unknown activity (#629)');
  await refused(run(TASK, FRONT.name), 404, 'atividade desconhecida', 'no activity yet (#629): /run never creates one');
  assert.equal((await postJson(`${base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200);
  for (const command of ['Nope', undefined, 7]) await refused(run(TASK, command), 400, 'comando desconhecido', String(command));
  const answer = (await (await run(TASK, FRONT.name)).json()) as OpenResult;
  const terminal = server.getState()?.terminals.at(-1);
  assert.deepEqual([answer.ok, answer.ptyId, 'session' in answer, terminal?.command], [true, terminal?.terminalId, false, FRONT.name]);
  await server.dispatch({ type: 'worktreeGone', activityId: activityOf(server.getState()!, TASK)!.id }); // #629: the activity's
  await refused(run(TASK, FRONT.name), 409, 'tarefa sem worktree', 'gone from disk (#208)');
});

test('a command runs only in the workspaces it is enabled for: /run answers 400 and a raced openSession fails the spawn when it is not enabled for the task\'s workspace (#511)', async (t) => {
  const other = await tempDir(t, 'other-');
  await promisify(execFile)('git', ['init', '--quiet', other]);
  const ELSE: Command = { name: 'Else', impls: [{ workspace: 'other', command: 'true' }], menu: true, env: {} };

  const { base, server, workers } = await start(t, {}, { workspaces: [{ name: 'other', path: other, env: {}, fork: null, memoryCap: 4000 }], commands: [ELSE] });
  assert.deepEqual(server.getState()?.commands, { hive: ['Run Frontend'], other: ['Else'] });
  assert.equal((await postJson(`${base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200);
  const answer = await postJson(`${base}${workPath(server, TASK)}/run`, { command: 'Else' });
  assert.deepEqual([answer.status, await answer.json()], [400, { error: 'comando desconhecido' }]);
  await server.dispatch({ type: 'openTerminal', activityId: workId(server.getState()!, TASK), command: 'Else' }); // a click a save raced
  await waitFor(() => server.getState()?.error !== undefined);
  assert.equal(server.getState()?.error, 'comando "Else" não está habilitado no workspace hive');
  assert.equal(workers.length, 1, 'only the plain terminal ran');
});

test('a stages-only command is offered nowhere: State.commands leaves it out and /run answers 400 (#755)', async (t) => {
  const HIDDEN: Command = { name: 'Hidden', impls: [{ workspace: null, command: 'true' }], menu: false, env: {} };
  const { base, server } = await start(t, {}, { workspaces: [], commands: [HIDDEN] });
  assert.deepEqual(server.getState()?.commands, { hive: ['Run Frontend'] });
  assert.equal((await postJson(`${base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200);
  const answer = await postJson(`${base}${workPath(server, TASK)}/run`, { command: 'Hidden' });
  assert.deepEqual([answer.status, await answer.json()], [400, { error: 'comando desconhecido' }]);
});

const URLS: Record<string, string> = { upstream: 'https://github.com/acme/app.git\n', origin: 'git@github.com:me/app.git\n' };
// git answering the two remotes' URLs and nothing else (#854)
const remotesGit: Exec = async (file, args) => ({ stdout: file === 'git' && args.includes('get-url') ? (URLS[args.at(-1) ?? ''] ?? '') : '' });

async function startFork(t: TestContext, fork: WorkspaceFork | false | null, env: Record<string, string> = {}): Promise<{ base: string; workers: FakeWorker[] }> {
  const { home, repo } = await tempHive(t);
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec: remotesGit });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: [{ name: WORKSPACE, path: repo, env, fork, memoryCap: 4000 }], commands: [FRONT] })).status, 200);
  await server.poll();
  return { base, workers };
}

test('every run of a fork workspace gets GH_REPO, its base repository: the original with PRs to it, the fork with PRs to the fork; the workspace\'s own GH_REPO wins; a workspace that is not a fork gets none (#854)', async (t) => {
  const original = await startFork(t, { remote: 'upstream', pr: 'original' });
  assert.equal((await postJson(`${original.base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200);
  assert.equal((await postJson(`${original.base}/tasks/${TASK}/open`, { kind: 'claude' })).status, 200);
  await waitFor(() => original.workers.length === 2);
  assert.deepEqual(original.workers.map((w) => w.launch.env?.GH_REPO), ['acme/app', 'acme/app'], 'a terminal and a session');
  const fork = await startFork(t, { remote: 'upstream', pr: 'fork', sync: 'manual' });
  assert.deepEqual(await (await postJson(`${fork.base}/tasks/${TASK}/start`, { base: null })).json(), { ok: true });
  await waitFor(() => fork.workers.length === 1);
  assert.equal(fork.workers[0].launch.env?.GH_REPO, 'me/app', 'a stage run');
  const own = await startFork(t, { remote: 'upstream', pr: 'original' }, { GH_REPO: 'acme/other' });
  assert.equal((await postJson(`${own.base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200);
  assert.equal(own.workers[0].launch.env?.GH_REPO, 'acme/other');
  const plain = await startFork(t, false);
  assert.equal((await postJson(`${plain.base}/tasks/${TASK}/open`, { kind: 'terminal' })).status, 200);
  assert.equal(plain.workers[0].launch.env?.GH_REPO, undefined);
});
