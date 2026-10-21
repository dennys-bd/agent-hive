import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { activityOf, taskOfWorker } from '../src/activities.js';
import { readyOn, workPath } from './fixtures/work.js';
import { createServer, type HiveServer } from '../src/server.js';
import { createConsoleStore } from '../src/console.js';
import { createPtyHost, NO_PTY } from '../src/pty-host.js';
import { deleteActivityOnDisk } from '../src/server-tasks.js';
import { LOCAL_BASES, LOCAL_MESSAGE, localOf, openPlace, startLocal } from '../src/server-local.js';
import type { Activity, Task, DeleteActivityScope, Exec, SettingsBody, Worker } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT, SPAWN_FAILED } from '../src/types.js';
import { transcriptDir } from '../src/agents/claude-transcript.js';
import { AUTH, fakeSourceFactory, fakeLog, fakeSpawn, type FakeWorker, GITHUB_ENTRY, workspacesAt, STAGES, tempHive } from './fakes.js';
import { tempDir } from './temp-dir.js';
import { hiveFetch, SECRET } from './secret-client.js';

// A task run in the workspace's checkout (#444) through the server: the fake source's one task, no worker of its own (maxConcurrent 0), started
// or opened by hand. The workspace's setup copies a file the repo does not have: a setup that ran would fail the run.
const BRANCH = 'hive/1-from-ready'; // what the default template renders for the fake source's task
const SHA = '0123456789abcdef0123456789abcdef01234567';
const SETUP = 'COPY .env';
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
const AT = '2026-09-27T10:00:00.000Z';
const ALL: DeleteActivityScope = { session: true, transcripts: true, nonAutoTasks: false };
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
  showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [], consoleLines: 5000,
};

interface CheckoutGit { exec: Exec; calls: string[][]; dirty(status: string): void }
interface Started { base: string; repo: string; server: HiveServer; workers: FakeWorker[]; git: CheckoutGit }

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
const task0 = (server: HiveServer): Task => server.getState()!.tasks[0];
// Its live activity (#629): the worktree, the branch, local, the setup and the mark
const work0 = (server: HiveServer): Activity | undefined => activityOf(server.getState()!, task0(server).item.itemId);
const runOf = (server: HiveServer): Worker | undefined => {
  const state = server.getState()!;
  return state.workers.find((s) => taskOfWorker(state, s)?.item.itemId === 'board:I1' && s.status !== 'empty');
};
// the git commands run in `dir`, without the `-C <dir>` prefix
const gitIn = (calls: string[][], dir: string): string[][] => calls.filter((a) => a[0] === '-C' && a[1] === dir).map((a) => a.slice(2));

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

// CLAUDE_CONFIG_DIR for one test: where removeTranscripts looks; the suite runs one file per process, and the value is put back after.
function claudeConfigDir(t: TestContext, dir: string): void {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
}

// git as a checkout task meets it: `status` answers what dirty() set (clean by default), `rev-parse HEAD` a sha (the stage-start record),
// everything else nothing, so the task's branch exists and the checkout is on another one. Every argv is recorded.
function checkoutGit(): CheckoutGit {
  const calls: string[][] = [];
  let status = '';
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    if (args[2] === 'status') return { stdout: status };
    if (args[2] === 'rev-parse' && args.at(-1) === 'HEAD') return { stdout: `${SHA}\n` };
    return { stdout: '' };
  };
  return { exec, calls, dirty: (next) => { status = next; } };
}

async function start(t: TestContext, deleteActivity: DeleteActivityScope = DELETE_ACTIVITY_DEFAULTS): Promise<Started> {
  const { home, repo } = await tempHive(t);
  const git = checkoutGit();
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec: git.exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { ...BODY, deleteActivity, workspaces: [{ ...workspacesAt(repo)[0], setup: SETUP }] })).status, 200);
  await server.poll();
  await server.dispatch({ type: 'setSignal', signal: 'green' });
  return { base, repo, server, workers, git };
}

test('localOf reads the popup\'s switch: only a literal true is on, any other value is off, absent keeps the task\'s (#444)', () => {
  assert.deepEqual(localOf({ local: true }), { local: true });
  for (const off of [false, 'true', 1, null]) assert.deepEqual(localOf({ local: off }), { local: false }, String(off));
  assert.deepEqual(localOf({ base: null }), {});
  assert.deepEqual(localOf(undefined), {});
});

test('startLocal takes the switch only while the task has no place to run: the popup never opens on one that has (#444)', () => {
  assert.deepEqual(startLocal({ local: true }, {}), { local: true });
  assert.deepEqual(startLocal({ local: true }, { worktree: '/repo/.hive/worktrees/x', worktreeGone: true }), { local: true }, 'a gone worktree reopens the popup');
  assert.deepEqual(startLocal({ local: true }, { worktree: '/repo/.hive/worktrees/x' }), {}, 'a worktree with work in it is never orphaned');
  assert.deepEqual(startLocal({ local: false }, { worktree: '/repo', local: true }), {}, 'a checkout task keeps its choice');
});

test('a manual start with checkout true runs the stage in the workspace\'s checkout: switched to the task\'s branch, no setup, the stage start read there, no worktree command (#444)', async (t) => {
  const { base, repo, server, workers, git } = await start(t);
  const before = git.calls.length;
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`, { base: null, local: true })), { ok: true });
  assert.equal(work0(server)?.local, true);
  assert.equal(workers.length, 1, 'COPY .env would have failed the start: the setup was skipped');
  assert.equal(workers[0].launch.cwd, repo);
  const ran = gitIn(git.calls.slice(before), repo);
  assert.deepEqual(ran.slice(0, 4), [['branch', '--show-current'], ['status', '--porcelain'], ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`], ['switch', BRANCH]]);
  assert.ok(ran.some((c) => c[0] === 'rev-parse' && c.at(-1) === 'HEAD'), 'recordStart reads HEAD in the checkout');
  assert.equal(git.calls.slice(before).some((a) => a.includes('worktree')), false);
  assert.deepEqual(work0(server)?.stageStart, { stage: 'fila', commit: SHA });
});

test('a checkout with uncommitted changes refuses the spawn before any switch: spawnFailed with the reason, no worker, the choice kept (#444)', async (t) => {
  const { base, repo, server, workers, git } = await start(t);
  git.dirty(' M src/app.ts\n');
  const before = git.calls.length;
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`, { base: null, local: true })), { ok: true });
  assert.equal(workers.length, 0);
  const refusal = `${repo} has changes that are not committed:\n M src/app.ts`;
  assert.equal(work0(server)?.error, SPAWN_FAILED + refusal);
  assert.equal(server.getState()?.error, refusal, '#945: the bar keeps the raw message');
  assert.equal(runOf(server), undefined, 'the worker is free again');
  assert.equal(git.calls.slice(before).some((a) => a[2] === 'switch'), false);
  assert.equal(work0(server)?.local, true, 'a retry keeps running in the checkout');
});

test('Restart is refused with 409 on a checkout task, preview and post alike: it would reset the user\'s checkout (#444)', async (t) => {
  const { base, server, workers } = await start(t);
  await postJson(`${base}/tasks/board:I1/start`, { base: null, local: true });
  assert.deepEqual([work0(server)?.local, work0(server)?.stageStart], [true, { stage: 'fila', commit: SHA }]);
  workers[0].handlers.onExit();
  await waitFor(() => work0(server)?.stopped === true);
  for (const res of [await hiveFetch(`${base}${workPath(server, 'board:I1')}/restart`), await postJson(`${base}${workPath(server, 'board:I1')}/restart`)]) {
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'reinício indisponível para essa etapa' });
  }
});

test('openPlace: a body with the switch decides; with no checkout key a checkout task keeps its choice and its saved base, since no popup is shown on it (#444)', () => {
  const saved = { ref: 'hive/41-parent', tellWorker: true };
  assert.deepEqual(openPlace({ kind: 'terminal', base: 'feature-x', local: true }, {}), { local: true, base: { ref: 'feature-x', tellWorker: false } });
  assert.deepEqual(openPlace({ kind: 'terminal', base: null, local: false }, { local: true, base: saved }), { local: false });
  assert.deepEqual(openPlace({ kind: 'terminal' }, { local: true, base: saved }), { local: true, base: saved });
  assert.deepEqual(openPlace({ kind: 'terminal' }, {}), { local: false });
});

test('POST /tasks/:id/open with checkout true puts the checkout on the task\'s branch with no setup, marks the task, and its terminal and claude session run in the checkout (#444)', async (t) => {
  const { base, repo, server, workers, git } = await start(t);
  const before = git.calls.length;
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal', base: null, local: true })).status, 200);
  assert.deepEqual([work0(server)?.local, work0(server)?.worktree, work0(server)?.branch], [true, repo, BRANCH]);
  assert.ok(gitIn(git.calls.slice(before), repo).some((c) => c[0] === 'switch'));
  assert.equal(workers[0].launch.cwd, repo, 'the terminal');
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'claude' })).status, 200);
  assert.equal(workers[1].launch.cwd, repo, 'the session');
});

test('a claude session opened on a checkout task records no stage start: no stage-start ref in the user\'s own checkout, which Restart never resets (#812, #444)', async (t) => {
  const { base, server, git } = await start(t);
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal', base: null, local: true })).status, 200);
  const before = git.calls.length;
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'claude' })).status, 200);
  assert.deepEqual([work0(server)?.stageStart, git.calls.slice(before).filter((c) => c.includes('update-ref'))], [undefined, []]);
});

test('POST /tasks/:id/open with no checkout in the body keeps a checkout task\'s choice: a start that failed on a dirty checkout, retried through a session, opens in the checkout (#444)', async (t) => {
  const { base, repo, server, workers, git } = await start(t);
  git.dirty(' M a.txt\n');
  await postJson(`${base}/tasks/board:I1/start`, { base: null, local: true });
  assert.deepEqual([work0(server)?.local, work0(server)?.worktree], [true, undefined]);
  git.dirty('');
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' })).status, 200);
  assert.deepEqual([work0(server)?.local, work0(server)?.worktree, workers[0].launch.cwd], [true, repo, repo]);
});

test('GET /tasks/:id/bases answers hasWorktree on a checkout task, so neither popup reopens and a start goes straight through (#444)', async (t) => {
  const { base, server } = await start(t);
  assert.equal((await json<{ hasWorktree: boolean }>(hiveFetch(`${base}/tasks/board:I1/bases`))).hasWorktree, false, 'before the choice: the popup');
  await readyOn(server, 'board:I1', { path: '/elsewhere', branch: BRANCH, base: null, local: true });
  assert.deepEqual(await json(hiveFetch(`${base}/tasks/board:I1/bases`)), LOCAL_BASES);
});

test('POST /activities/:id/delete answers 409 on a checkout task and runs no git: there is no worktree to remove (#444)', async (t) => {
  const { base, repo, server, git } = await start(t);
  await readyOn(server, 'board:I1', { path: repo, branch: BRANCH, base: null, local: true });
  const before = git.calls.length;
  const res = await postJson(`${base}${workPath(server, 'board:I1')}/delete`, { force: true });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: LOCAL_MESSAGE });
  assert.deepEqual([git.calls.length, work0(server)?.deleting], [before, undefined]);
});

test('deleteActivityOnDisk on a local task runs no git whatever the scope and deletes its sessions\' transcripts under the workspace\'s own dir, so the deleteActivity effect answers cleaned (#444)', async (t) => {
  claudeConfigDir(t, await tempDir(t, 'claude-'));
  const repo = await tempDir(t, 'repo-');
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => { calls.push(args); return { stdout: '' }; };
  const task: Task = {
    item: { itemId: 'I1', id: '1', title: 'T', body: '', url: '' }, stage: 'fila', boardColumn: 'Ready', auto: true,
  };
  const activity: Activity = { id: 'a-I1', kind: 'task', workspace: 'hive', slug: 'hive-1-t', local: true, worktree: repo, branch: BRANCH, stageStart: { stage: 'fila', commit: SHA } }; // #629: the activity's
  const dir = transcriptDir(repo);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${SESSION}.jsonl`), '{}\n');
  const deps = { log: fakeLog().log, exec, ptys: createPtyHost(NO_PTY), consoleStore: createConsoleStore(() => 1000) };
  await deleteActivityOnDisk({ workspace: { name: 'hive', path: repo, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }, activity, task, sessions: [{ id: SESSION, startedAt: AT, stages: ['fila'], agent: 'claude', lastUsedAt: AT }], branch: BRANCH, scope: ALL }, deps);
  assert.deepEqual(calls, [], 'no worktree, no branch -d, no left-behind branches, no stage-start ref');
  assert.deepEqual(await readdir(dir), []);
});

test('the worktree-gone check after a poll skips a checkout task: its folder is the workspace itself (#444)', async (t) => {
  const { server } = await start(t);
  await readyOn(server, 'board:I1', { path: '/nowhere/on/disk', branch: BRANCH, base: null, local: true });
  await server.poll();
  assert.equal(work0(server)?.worktreeGone, undefined);
});

test('clearing a checkout task\'s session deletes its transcript from the workspace\'s own transcript dir (#444)', async (t) => {
  claudeConfigDir(t, await tempDir(t, 'claude-'));
  const { base, repo, server, workers } = await start(t, { ...DELETE_ACTIVITY_DEFAULTS, session: true, transcripts: true }); // transcripts needs session
  await postJson(`${base}/tasks/board:I1/start`, { base: null, local: true });
  const session = work0(server)!.sessionId!;
  workers[0].handlers.onExit();
  await waitFor(() => work0(server)?.stopped === true);
  const dir = transcriptDir(repo);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${session}.jsonl`), '{}\n');
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/sessions/${session}/clear`)), { ok: true });
  assert.deepEqual(await readdir(dir), []);
});
