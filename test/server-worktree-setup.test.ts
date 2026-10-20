import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { activityOf, taskOfWorker } from '../src/activities.js';
import { shortId } from '../src/log.js';
import { createServer, type HiveServer } from '../src/server.js';
import type { ChannelView } from '../src/console.js';
import type { Activity, Task, Exec, OpenResult, SettingsBody, Worker } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT, SPAWN_FAILED } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { SETUP_MARKER } from '../src/worktree-setup.js';
import { TEARDOWN_MARKER } from '../src/worktree-teardown.js';
import { AUTH, fakeSourceFactory, fakeLog, fakeSpawn, type FakeWorker, GITHUB_ENTRY, workspacesAt, STAGES, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { workPath } from './fixtures/work.js';

// The worktree setup (#299) through the server: the fake source's one task, no worker of its own (maxConcurrent 0), started or opened by hand.
const SLUG = 'hive-1-from-ready';
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
  showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};

interface Started { base: string; repo: string; gitDir: string; server: HiveServer; workers: FakeWorker[]; lines: string[] }

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
const marked = (gitDir: string): Promise<boolean> => access(join(gitDir, SETUP_MARKER)).then(() => true, () => false);
// A run's text made readable (#576): ESC stands for \x1b, since Biome refuses a control character in a pattern
const shown = (text: string): string => text.replaceAll('\x1b', 'ESC');
const CMD = (source: string): string => String.raw`ESC\[97m> ${source}ESC\[0m\r\n`;
const FAILED = (source: string): string => String.raw`ESC\[31m${source}ESC\[0m\r\n`;
const OK_MS = String.raw`ESC\[32mok \d+msESC\[0m\r\n`;
const SETUP_OK = String.raw`ESC\[32msetup ok · \d+ steps · \d+msESC\[0m\r\n`;
const COPIED = String.raw`copied 1 files to \.env\r\n`;
// A run's git (#351): each command, then ok and its time; the worktree's git dir is the last one when the workspace has steps
const GIT = `(${CMD(String.raw`git [^\r]*`)}${OK_MS})*${CMD(String.raw`git -C [^\r ]+ rev-parse --absolute-git-dir`)}${OK_MS}`;
const RUN_HEADER = String.raw`── #1 · setup · \d\d:\d\d:\d\d ──\r\n`;
const firstIndex = (lines: string[], prefix: string): number => lines.findIndex((l) => l.startsWith(prefix));

// The one Setup worktree channel as GET /console/:id answers it (#351); the fake source has one task, so every run in it is that task's
async function channel(base: string, _task: Task): Promise<[number, ChannelView]> {
  const res = await hiveFetch(`${base}/console/setup`);
  return [res.status, (await res.json()) as ChannelView];
}

// The task's setup events and the open, in order, from the lines the log got since `from`
const trail = (lines: string[], from: number): string[] =>
  lines.slice(from).filter((l) => /^DEBUG (setup\w+|worktreeReady|openSession|openTerminal) /.test(l)).map((l) => l.split(' ')[1]);

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

// git answers nothing, except the worktree's git dir: a temp folder standing in for <repo>/.git/worktrees/<slug>. `worktree add` makes the
// worktree's folder, as git would: a RUN needs it as its cwd, and a folder already there is what makes a start check its marker first (#351).
async function start(t: TestContext, setup: string, gitHeld?: Promise<void>): Promise<Started> {
  const { home, repo } = await tempHive(t);
  const gitDir = join(repo, '.git', 'worktrees', SLUG);
  await mkdir(gitDir, { recursive: true });
  const { log, lines } = fakeLog();
  const exec: Exec = async (_file, args) => {
    lines.push(`GIT ${args.join(' ')}`);
    await gitHeld; // a test holds the spawn in its git
    if (args.includes('worktree') && args.includes('add')) await mkdir(args[args.indexOf('--') + 1], { recursive: true });
    if (args.includes('--git-common-dir')) return { stdout: `${join(repo, '.git')}\n` };
    return { stdout: args.includes('--absolute-git-dir') ? `${gitDir}\n` : '' };
  };
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec, log });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: [{ ...workspacesAt(repo)[0], setup }] })).status, 200);
  await server.poll();
  await server.dispatch({ type: 'setSignal', signal: 'green' });
  return { base, repo, gitDir, server, workers, lines };
}

test('a stage spawn marks the task before its git and runs the git and the workspace\'s setup in the Setup worktree channel before the worker: the task is free of it once the worker starts, and the next start on the set-up worktree emits no setupStarted and adds no run (#299, #351)', async (t) => {
  const { base, repo, gitDir, server, workers, lines } = await start(t, 'COPY .env');
  await writeFile(join(repo, '.env'), 'TOKEN=x\n');
  const from = lines.length;
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  const after = lines.slice(from);
  assert.ok(firstIndex(after, 'DEBUG setupStarted') < firstIndex(after, 'GIT '), 'marked before the git');
  assert.ok(!lines.some((l) => l.includes('> git')), 'the run\'s git lines never reach the log');
  assert.equal(workers.length, 1, 'the spawn and its setup ran inside the dispatch');
  assert.equal(await readFile(join(worktreePath(repo, SLUG), '.env'), 'utf8'), 'TOKEN=x\n');
  assert.equal(work0(server)?.setup, undefined, 'setupEnded dropped it');
  const [status, view] = await channel(base, task0(server));
  assert.equal(status, 200);
  assert.match(shown(view.history), new RegExp(`^${RUN_HEADER}${GIT}${CMD(String.raw`COPY \.env`)}${COPIED}${OK_MS}${SETUP_OK}$`));
  assert.deepEqual(view.live, []);
  assert.deepEqual(await json(hiveFetch(`${base}/console`)), [{ id: 'setup', kind: 'setup', label: 'Setup worktree', status: 'done' }]);
  assert.equal(await marked(gitDir), true);
  workers[0].handlers.onExit();
  await waitFor(() => runOf(server) === undefined);
  await rm(join(repo, '.env')); // a setup that ran again would now fail
  const second = lines.length;
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  assert.ok(!lines.slice(second).some((l) => l.startsWith('DEBUG setupStarted')), 'no mark for a worktree already set up');
  assert.deepEqual([workers.length, work0(server)?.error], [2, undefined], 'set up already: skipped');
  assert.equal((await channel(base, task0(server)))[1].history, view.history, 'no second run in the channel');
});

test('a setup that fails in a spawn is a spawnFailed: no worker starts, the worker frees, the task keeps the reason, its console run ends with it, and no marker is written (#299, #351)', async (t) => {
  const { base, gitDir, server, workers } = await start(t, '# nothing copied yet\nCOPY .env');
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  const reason = 'setup failed at line 2 (COPY .env): not found in hive';
  assert.equal(workers.length, 0);
  assert.deepEqual([work0(server)?.error, work0(server)?.setup], [SPAWN_FAILED + reason, undefined]);
  assert.match(shown((await channel(base, task0(server)))[1].history), new RegExp(`\\r\\n${CMD(String.raw`COPY \.env`)}${FAILED(String.raw`setup failed at line 2 \(COPY \.env\): not found in hive`)}$`));
  assert.equal(runOf(server), undefined, 'the worker is free again');
  assert.equal(await marked(gitDir), false);
});

test('a Stop during a stage spawn\'s setup kills the running step: the task showed the step, the console run ends stopped, no worker starts and no marker is written (#299, #351)', async (t) => {
  const { base, gitDir, server, workers } = await start(t, 'RUN sleep 30');
  const began = Date.now();
  const starting = postJson(`${base}/tasks/board:I1/start`); // not awaited: the setup holds the spawn
  await waitFor(() => work0(server)?.setup?.step === 'RUN sleep 30');
  assert.equal(work0(server)?.setup?.consoleId, 'setup:board:I1');
  const { runId: ptyId } = runOf(server)!;
  assert.equal((await postJson(`${base}/ptys/${ptyId}/stop`)).status, 200);
  await starting;
  assert.ok(Date.now() - began < 10_000, 'the sleep died with its group instead of running 30 s');
  assert.match(shown((await channel(base, task0(server)))[1].history), new RegExp(`\\r\\n${FAILED(String.raw`setup failed at line 1 \(RUN sleep 30\): stopped`)}$`));
  assert.deepEqual([workers.length, runOf(server), work0(server)?.setup, await marked(gitDir)], [0, undefined, undefined, false]);
});

test('a first /open whose workspace has a setup marks the task before any git, runs the setup in its console channel, then opens the session and answers it to attach (#351)', async (t) => {
  const { base, repo, server, workers, lines } = await start(t, 'RUN sleep 0.3\nCOPY .env');
  await writeFile(join(repo, '.env'), 'TOKEN=x\n');
  const from = lines.length;
  const opening = postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' }); // the dialog waits
  await waitFor(() => work0(server)?.setup?.step === 'RUN sleep 0.3');
  assert.deepEqual([work0(server)?.setup?.consoleId, workers.length], ['setup:board:I1', 0], 'the task shows the setup while the request is pending');
  const answer = await opening;
  assert.equal(answer.status, 200);
  assert.equal(((await answer.json()) as OpenResult).ptyId, workers[0].launch.ptyId, 'the page attaches it at once, as before (#249)');
  assert.deepEqual(trail(lines, from), ['setupStarted', 'setupStep', 'setupStep', 'setupStep', 'setupStep', 'setupStep', 'setupStep', 'worktreeReady', 'setupEnded', 'openTerminal']);
  const after = lines.slice(from);
  assert.ok(after.findIndex((l) => l.startsWith('DEBUG setupStarted')) < after.findIndex((l) => l.startsWith('GIT ')), 'marked before the git');
  assert.deepEqual([work0(server)?.setup, work0(server)?.worktree, work0(server)?.error], [undefined, worktreePath(repo, SLUG), undefined]);
  assert.equal(await readFile(join(worktreePath(repo, SLUG), '.env'), 'utf8'), 'TOKEN=x\n');
  assert.match(shown((await channel(base, task0(server)))[1].history), new RegExp(`^${RUN_HEADER}${GIT}${CMD(String.raw`RUN sleep 0\.3`)}${OK_MS}${CMD(String.raw`COPY \.env`)}${COPIED}${OK_MS}${SETUP_OK}$`));
});

test('a first /open whose setup fails answers the 500 as before, puts the reason on the task and in its console run, and opens nothing; the next /open drops the reason and opens (#299, #351)', async (t) => {
  const { base, repo, server, workers, lines } = await start(t, 'COPY .env');
  const reason = 'setup failed at line 1 (COPY .env): not found in hive';
  const from = lines.length;
  const failed = await postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: reason });
  assert.deepEqual(trail(lines, from), ['setupStarted', 'setupStep', 'setupStep', 'setupStep', 'setupStep', 'setupEnded']);
  assert.ok(lines.includes(`DEBUG setupEnded activity=${shortId(work0(server)?.id)} failed`), 'the error reached the task, not the log; the event names the activity (#629)');
  assert.deepEqual([work0(server)?.error, work0(server)?.setup, work0(server)?.worktree, workers.length], [reason, undefined, undefined, 0], 'no worktreeReady, no shell');
  assert.match(shown((await channel(base, task0(server)))[1].history), new RegExp(`\\r\\n${CMD(String.raw`COPY \.env`)}${FAILED(String.raw`setup failed at line 1 \(COPY \.env\): not found in hive`)}$`));
  await writeFile(join(repo, '.env'), 'TOKEN=x\n');
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' })).status, 200);
  assert.deepEqual([work0(server)?.error, work0(server)?.worktree, workers.length], [undefined, worktreePath(repo, SLUG), 1]);
});

test('while a task\'s setup runs, a second /open, Start, Continue and Restart answer 409; a bad /open is still refused before anything is marked (#351)', async (t) => {
  const { base, server } = await start(t, 'RUN sleep 0.5');
  const bad = await postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal', workspace: 'nope' });
  assert.deepEqual([bad.status, work0(server)?.setup], [400, undefined], 'refused before the mark');
  const opening = postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' }); // pending while the setup runs
  await waitFor(() => work0(server)?.setup !== undefined);
  for (const path of ['open', 'start', 'continue', 'restart']) {
    const owner = path === 'open' || path === 'start' ? '/tasks/board:I1' : workPath(server, 'board:I1'); // #629: continue and restart act on the activity
    const res = await postJson(`${base}${owner}/${path}`, path === 'open' ? { kind: 'terminal' } : {});
    assert.deepEqual([res.status, await res.json()], [409, { error: 'o setup desta tarefa ainda está em andamento' }], path);
  }
  assert.equal((await opening).status, 200, 'the first open goes on and answers its run');
});

test('a first /open while a stage spawn is still making the task\'s worktree answers 409 and starts no second maker: the spawn marks the task before its git, with or without setup steps (#351, #576)', async (t) => {
  for (const setup of ['RUN true', '# nothing yet\n']) {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { base, server, workers } = await start(t, setup, held);
    const starting = postJson(`${base}/tasks/board:I1/start`); // held in its first git: marked, no worktree on the task
    await waitFor(() => work0(server)?.setup !== undefined);
    const res = await postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' });
    assert.deepEqual([res.status, await res.json()], [409, { error: 'o setup desta tarefa ainda está em andamento' }], setup);
    release();
    assert.equal((await starting).status, 200);
    assert.equal(workers.length, 1, 'one worker');
  }
});

test('a first /open on a worktree folder already there and set up emits no setup event and opens no console run (#351)', async (t) => {
  const { base, repo, gitDir, server, workers, lines } = await start(t, 'RUN false');
  await mkdir(worktreePath(repo, SLUG), { recursive: true });
  await writeFile(join(gitDir, SETUP_MARKER), '');
  const from = lines.length;
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' })).status, 200);
  assert.deepEqual([trail(lines, from), workers.length, work0(server)?.setup], [['worktreeReady', 'openTerminal'], 1, undefined]);
  assert.deepEqual(await json(hiveFetch(`${base}/console`)), []);
});

test('a first /open on a workspace with no setup steps marks the task, runs the worktree\'s git in the Setup worktree channel, then opens the session (#576)', async (t) => {
  const { base, server, workers, lines } = await start(t, '# nothing yet\n');
  const from = lines.length;
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' })).status, 200);
  assert.deepEqual([trail(lines, from), workers.length, work0(server)?.setup], [['setupStarted', 'setupStep', 'worktreeReady', 'setupEnded', 'openTerminal'], 1, undefined]);
  assert.ok(!lines.some((l) => l.includes('> git')), 'the run\'s git lines never reach the log');
  assert.deepEqual(await json(hiveFetch(`${base}/console`)), [{ id: 'setup', kind: 'setup', label: 'Setup worktree', status: 'done' }]);
  assert.match(shown((await channel(base, task0(server)))[1].history), new RegExp(`^${RUN_HEADER}(${CMD(String.raw`git [^\r]*`)}${OK_MS})+${SETUP_OK}$`));
});

test('a first /open on a worktree folder already there deletes its teardown marker (#654)', async (t) => {
  const { base, repo, gitDir } = await start(t, 'RUN false');
  await mkdir(worktreePath(repo, SLUG), { recursive: true });
  await writeFile(join(gitDir, SETUP_MARKER), '');
  await writeFile(join(gitDir, TEARDOWN_MARKER), '');
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' })).status, 200);
  assert.equal(await access(join(gitDir, TEARDOWN_MARKER)).then(() => true, () => false), false);
});

test('the grid a first /open sends survives the worktree setup and is the one its terminal is spawned at (#808)', async (t) => {
  const { base, repo, workers } = await start(t, 'COPY .env');
  await writeFile(join(repo, '.env'), 'TOKEN=x\n');
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal', size: { cols: 132, rows: 41 } })).status, 200);
  assert.deepEqual(workers.map((w) => w.launch.size), [{ cols: 132, rows: 41 }]);
});

test('a start through the worktree setup spawns its worker at the grid the start sent; the next start with none leaves its launch without one (#808)', async (t) => {
  const { base, repo, server, workers } = await start(t, 'COPY .env');
  await writeFile(join(repo, '.env'), 'TOKEN=x\n');
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`, { size: { cols: 132, rows: 41 } })), { ok: true });
  workers[0].handlers.onExit();
  await waitFor(() => runOf(server) === undefined);
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  assert.deepEqual(workers.map((w) => w.launch.size), [{ cols: 132, rows: 41 }, undefined]);
});

test('a stage spawn whose setup fails keeps its rows on the task as lastSetup; the next start resumes from the failed step, skipping the one that passed, and drops them (#390)', async (t) => {
  const { base, repo, server, workers } = await start(t, 'COPY .env\nCOPY seed.sql');
  await writeFile(join(repo, '.env'), 'TOKEN=x\n');
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  assert.equal(work0(server)?.lastSetup?.consoleId, 'setup:board:I1');
  assert.deepEqual((work0(server)?.lastSetup?.rows ?? []).map((r) => [r.kind, r.status]), [['worktree', 'done'], ['branch', 'done'], ['step', 'done'], ['step', 'failed']]);
  await rm(join(repo, '.env')); // the first step, run again, would now fail
  await writeFile(join(repo, 'seed.sql'), 'select 1;\n');
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  assert.deepEqual([workers.length, work0(server)?.lastSetup, work0(server)?.error], [1, undefined, undefined]);
});
