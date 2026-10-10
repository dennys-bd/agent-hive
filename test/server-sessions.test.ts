import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, localActivityId } from '../src/activities.js';
import { localSessionsOf } from '../src/local-sessions.js';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, type HiveServer, killStrays } from '../src/server.js';
import type { Exec, OpenResult, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { transcriptDir } from '../src/usage.js';
import { FOLDER_BODY_MESSAGE } from '../src/server-sessions.js';
import { FOLDER_MISSING_MESSAGE, OUTSIDE_MESSAGE } from '../src/tree-paths.js';
import { AUTH, GITHUB_ENTRY, WORKSPACE, workspacesAt, STAGES, fakeSourceFactory, fakeSpawn, type FakeWorker, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// A workspace's local activity (#292, #590), end to end through the server: the route, the reducer's Terminal and the pool's launch.
// No worker (maxConcurrent 0): every run below is one the test opened.
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });

// A spawn failure is dispatched without awaiting, like a real process event: poll the state until it settles.
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

interface Started { base: string; server: HiveServer; workers: FakeWorker[]; repo: string; git: string[][] }

// A Hive whose one workspace is WORKSPACE at `repo`; every git call is recorded, none runs.
async function start(t: TestContext, stdout: (args: string[]) => string = () => ''): Promise<Started> {
  const { home, repo } = await tempHive(t);
  const { spawn, workers } = fakeSpawn();
  const git: string[][] = [];
  const exec: Exec = async (file, args) => {
    git.push([file, ...args]);
    return { stdout: stdout(args) };
  };
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  return { base, server, workers, repo, git };
}

const refused = async (res: Promise<Response>, status: number, error: string, why: string): Promise<void> => {
  const answer = await res;
  assert.deepEqual([answer.status, await answer.json()], [status, { error }], why);
};

test('POST /activities/local:<name>/shell opens a terminal in the workspace\'s checkout, with no task, no worktree and no worker, and answers the run like /open; an unknown workspace is 404 (#292, #590, #629)', async (t) => {
  const { base, server, workers, repo, git } = await start(t);
  await refused(postJson(`${base}/activities/${encodeURIComponent(localActivityId('nope'))}/shell`), 404, 'atividade desconhecida', 'not a workspace of the Comb: no local activity (#629)');
  const before = git.length;
  const answer = (await (await postJson(`${base}/activities/${encodeURIComponent(localActivityId(WORKSPACE))}/shell`)).json()) as OpenResult;
  const terminal = server.getState()?.terminals[0];
  assert.ok(terminal);
  assert.deepEqual(answer, { ok: true, ptyId: terminal.terminalId });
  assert.equal(terminal.activityId, localActivityId(WORKSPACE), 'the workspace\'s local activity (#629)');
  const { launch } = workers[0];
  assert.deepEqual(
    [launch.slug, launch.cwd, launch.terminal, launch.run, launch.args, launch.promptPath, launch.mcpPath],
    ['workspace', repo, true, undefined, [], undefined, undefined],
  );
  assert.deepEqual(git.slice(before), [], 'no git: no worktree, no checkout, no setup');
});

test('a workspace the config no longer holds ends the shell in spawnFailed with the reason in the bar: a first open that never ran goes, and nothing runs (#292, #696)', async (t) => {
  const { server, workers } = await start(t);
  await server.dispatch({ type: 'setWorkspaces', workspaces: [WORKSPACE, 'gone'], sourceWorkspaces: {}, commands: {} }); // a save raced the click
  await server.dispatch({ type: 'openProjectShell', project: 'gone', cwd: '/gone' });
  await waitFor(() => server.getState()?.error !== undefined);
  assert.deepEqual([server.getState()?.error, server.getState()?.terminals.map((t) => t.asleep), workers.length], ['workspace "gone" não existe mais', [], 0]);
});

test('GET /ptys counts a workspace terminal and lists it with the workspace as its label and no taskId; killStrays leaves it alone (#292)', async (t) => {
  const { base, server } = await start(t);
  assert.equal((await postJson(`${base}/activities/${encodeURIComponent(localActivityId(WORKSPACE))}/shell`)).status, 200);
  const state = server.getState();
  const terminal = state?.terminals[0];
  assert.ok(state && terminal);
  assert.deepEqual(await (await hiveFetch(`${base}/ptys`)).json(), { active: 1, ptys: [{ id: terminal.terminalId, status: 'terminal', label: WORKSPACE }] });
  const calls: string[][] = [];
  await killStrays(state, async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: '' };
  });
  assert.deepEqual(calls, [], 'no worker id in an argv: a pty of the daemon\'s dies with it');
});

test('GET /workspaces/branches answers each workspace with the branch its checkout has out, null when git names none (redesign 08)', async (t) => {
  const { base, repo, git } = await start(t, (args) => (args.includes('--show-current') ? 'feature/x\n' : ''));
  const answer = await (await hiveFetch(`${base}/workspaces/branches`, { headers: { 'x-hive-ui': '1' } })).json();
  assert.deepEqual(answer, [{ name: WORKSPACE, branch: 'feature/x' }]);
  assert.deepEqual(git.at(-1), ['git', '-C', repo, 'branch', '--show-current'], 'argv, no shell');
});

test('GET /workspaces/branches answers null for a detached checkout or one git fails to read (redesign 08)', async (t) => {
  const { base } = await start(t);
  const answer = await (await hiveFetch(`${base}/workspaces/branches`, { headers: { 'x-hive-ui': '1' } })).json();
  assert.deepEqual(answer, [{ name: WORKSPACE, branch: null }]);
});

// The one local claude session a test opened (#590)
const localWorker = (server: HiveServer) => {
  const worker = server.getState()?.workers.find((s) => s.activityId === localActivityId(WORKSPACE));
  assert.ok(worker?.runId !== undefined && worker.sessionId !== undefined);
  return { ptyId: worker.runId, sessionId: worker.sessionId };
};

test('a new local claude session runs claude in the workspace\'s checkout with its own session id, and no git; a continued one resumes it (#590)', async (t) => {
  const { server, workers, repo, git } = await start(t);
  const before = git.length;
  await server.dispatch({ type: 'newLocalSession', activityId: localActivityId(WORKSPACE) });
  const { ptyId, sessionId } = localWorker(server);
  const { launch } = workers[0];
  assert.deepEqual([launch.slug, launch.cwd, launch.terminal, launch.promptPath, launch.protocolPath], ['workspace', repo, undefined, undefined, undefined], 'no Hive tools, no protocol (#167)');
  assert.ok(launch.mcpPath?.endsWith(`${ptyId}.mcp.json`), 'the worker id in claude\'s argv');
  assert.deepEqual(launch.args.slice(-2), ['--session-id', sessionId]);
  assert.deepEqual(git.slice(before), [], 'no worktree, no checkout, no setup');
  await server.dispatch({ type: 'hook', ptyId, payload: { hook_event_name: 'SessionStart', session_id: sessionId } });
  await server.dispatch({ type: 'exit', ptyId });
  await server.dispatch({ type: 'openLocalSession', activityId: localActivityId(WORKSPACE), sessionId });
  assert.deepEqual(workers[1].launch.args.slice(-2), ['--resume', sessionId]);
});

test('a local claude session whose workspace a save removed ends in spawnFailed with the reason in the bar; its worker leaves (#590)', async (t) => {
  const { server, workers } = await start(t);
  await server.dispatch({ type: 'setWorkspaces', workspaces: [WORKSPACE, 'gone'], sourceWorkspaces: {}, commands: {} }); // a save raced the click
  await server.dispatch({ type: 'newLocalSession', activityId: localActivityId('gone') });
  await waitFor(() => server.getState()?.error !== undefined);
  assert.deepEqual([server.getState()?.error, server.getState()?.workers.some((s) => s.activityId === localActivityId('gone')), workers.length], ['workspace "gone" não existe mais', false, 0]);
});

test('GET /ptys lists a local claude session with its workspace as its label and no taskId (#590)', async (t) => {
  const { base, server } = await start(t);
  await server.dispatch({ type: 'newLocalSession', activityId: localActivityId(WORKSPACE) });
  const { ptyId } = localWorker(server);
  assert.deepEqual(await (await hiveFetch(`${base}/ptys`)).json(), { active: 1, ptys: [{ id: ptyId, status: 'working', label: WORKSPACE }] });
});

test('GET /ptys lists a worker\'s run and a terminal by the id stop goes by, and POST /ptys/:id/stop stops each; an unknown id is 404 (#570)', async (t) => {
  const { base, server, workers } = await start(t);
  assert.equal((await postJson(`${base}/activities/${encodeURIComponent(localActivityId(WORKSPACE))}/shell`)).status, 200); // workers[0]: the terminal
  await server.dispatch({ type: 'newLocalSession', activityId: localActivityId(WORKSPACE) }); // workers[1]: the session's run
  const terminal = server.getState()?.terminals[0];
  assert.ok(terminal);
  const { ptyId: runId } = localWorker(server);
  assert.deepEqual(await (await hiveFetch(`${base}/ptys`)).json(), {
    active: 2,
    ptys: [{ id: runId, status: 'working', label: WORKSPACE }, { id: terminal.terminalId, status: 'terminal', label: WORKSPACE }],
  });
  await refused(postJson(`${base}/ptys/nope/stop`), 404, 'nenhuma execução viva com esse id', 'no live pty with that id');
  assert.deepEqual(await (await postJson(`${base}/ptys/${runId}/stop`)).json(), { ok: true });
  assert.deepEqual(await (await postJson(`${base}/ptys/${terminal.terminalId}/stop`)).json(), { ok: true });
  assert.deepEqual(workers.map((w) => w.killed), [1, 1], 'each got its kill');
});

test('a local session\'s turn end reads only its own transcript in the checkout\'s transcript folder, and its entry keeps the total; a path elsewhere or a sibling session\'s is not read (#590)', async (t) => {
  const config = await tempDir(t, 'claude-');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config; // where transcriptDir looks; put back after
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  const { base, server, repo } = await start(t);
  await server.dispatch({ type: 'newLocalSession', activityId: localActivityId(WORKSPACE) });
  const { ptyId, sessionId } = localWorker(server);
  const line = `${JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 100, output_tokens: 20 } } })}\n`;
  await mkdir(transcriptDir(repo), { recursive: true });
  const own = join(transcriptDir(repo), `${sessionId}.jsonl`);
  const elsewhere = join(config, 'elsewhere.jsonl');
  const sibling = join(transcriptDir(repo), 'another-session.jsonl');
  await writeFile(own, line);
  await writeFile(elsewhere, line);
  await writeFile(sibling, line);
  const post = (payload: unknown): Promise<Response> =>
    hiveFetch(`${base}/hooks/event`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-pty': ptyId }, body: JSON.stringify(payload) });
  await post({ hook_event_name: 'SessionStart', session_id: sessionId });
  await post({ hook_event_name: 'Stop', session_id: sessionId, transcript_path: elsewhere });
  assert.equal(localSessionsOf(server.getState()!, WORKSPACE)[0]?.tokens, undefined, 'a path outside the checkout\'s folder is dropped');
  await post({ hook_event_name: 'Stop', session_id: sessionId, transcript_path: sibling });
  assert.equal(localSessionsOf(server.getState()!, WORKSPACE)[0]?.tokens, undefined, 'another session\'s transcript in the same folder is dropped');
  await post({ hook_event_name: 'Stop', session_id: sessionId, transcript_path: own });
  assert.equal(localSessionsOf(server.getState()!, WORKSPACE)[0]?.tokens, 120);
});

test('POST /activities/local:<name>/sessions opens a new local session and answers its run like /open; an unknown workspace is 404 (#590, #629)', async (t) => {
  const { base, server } = await start(t);
  await refused(postJson(`${base}/activities/${encodeURIComponent(localActivityId('nope'))}/sessions`), 404, 'atividade desconhecida', 'not a workspace of the Comb: no local activity (#629)');
  const answer = (await (await postJson(`${base}/activities/${encodeURIComponent(localActivityId(WORKSPACE))}/sessions`)).json()) as OpenResult;
  assert.deepEqual(answer, { ok: true, ptyId: localWorker(server).ptyId });
});

test('POST /tasks/:id/open creates the task\'s activity once: a second open finds it and opens in it (#629)', async (t) => {
  const { base, server } = await start(t);
  await server.dispatch({ type: 'createTask', title: 'one', body: '', stage: STAGES[0].name, prefix: 'HIVE', workspace: WORKSPACE, auto: false });
  assert.equal((await postJson(`${base}/tasks/local:1/open`, { kind: 'terminal' })).status, 200);
  const first = activityOf(server.getState()!, 'local:1');
  assert.ok(first?.worktree, 'the first open made the worktree, on the activity');
  assert.equal((await postJson(`${base}/tasks/local:1/open`, { kind: 'terminal' })).status, 200);
  const state = server.getState()!;
  assert.deepEqual([state.activities.filter((a) => a.kind === 'task').length, activityOf(state, 'local:1')?.id], [1, first.id]);
  assert.deepEqual(state.terminals.map((term) => term.activityId), [first.id, first.id]);
});

test('every route on the work answers 404 for an unknown activity id, before reading its body (#629)', async (t) => {
  const { base } = await start(t);
  const getJson = (url: string): Promise<Response> => hiveFetch(url, { headers: { 'x-hive-ui': '1' } });
  const unknown = 'b1b2c3d4-0000-4000-8000-00000000dead';
  const s = 'b1b2c3d4-0000-4000-8000-000000000009';
  const posts = ['open', 'run', 'shell', 'sessions', `sessions/${s}/open`, `sessions/${s}/clear`, `sessions/${s}/copy`, 'tree/move', 'tree/create', 'tree/rename', 'tree/trash', 'tree/file', 'reveal', 'continue', 'restart', 'approve', 'feedback', 'approval/extend', 'delete'];
  const gets = ['diff?scope=worktree', 'tree', 'files', 'restart', `sessions/${s}/copy?toActivity=${unknown}`];
  for (const path of posts) await refused(postJson(`${base}/activities/${unknown}/${path}`), 404, 'atividade desconhecida', `POST ${path}`);
  for (const path of gets) await refused(getJson(`${base}/activities/${unknown}/${path}`), 404, 'atividade desconhecida', `GET ${path}`);
});

const shellOf = (base: string): string => `${base}/activities/${encodeURIComponent(localActivityId(WORKSPACE))}/shell`;

test('the grid /shell\'s body sends is the one the new terminal\'s pty is spawned at, rebuilt from cols and rows (#808)', async (t) => {
  const { base, workers } = await start(t);
  assert.equal((await postJson(shellOf(base), { size: { cols: 150, rows: 40, extra: 1 } })).status, 200);
  assert.deepEqual(workers[0].launch.size, { cols: 150, rows: 40 });
});

test('a malformed size in /shell\'s body is dropped: the shell still opens, at the host\'s fallback, and its launch has no size (#808)', async (t) => {
  const { base, workers } = await start(t);
  for (const size of [{ cols: 0, rows: 40 }, '150x40', { cols: 150 }]) assert.equal((await postJson(shellOf(base), { size })).status, 200, JSON.stringify(size));
  assert.deepEqual(workers.map((w) => 'size' in w.launch), [false, false, false]);
});

test('POST /activities/:id/shell with a folder opens the terminal there, a local activity\'s in its checkout and a task\'s in its worktree; a folder outside, a file or a bad body opens nothing (#818)', async (t) => {
  const { base, server, workers, repo } = await start(t);
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'README.md'), 'r');
  assert.equal((await postJson(shellOf(base), { folder: 'docs' })).status, 200);
  assert.equal(workers[0].launch.cwd, await realpath(join(repo, 'docs')));
  await refused(postJson(shellOf(base), { folder: '../x' }), 400, OUTSIDE_MESSAGE, 'outside the checkout');
  await refused(postJson(shellOf(base), { folder: 'README.md' }), 400, FOLDER_MISSING_MESSAGE, 'a file is no folder');
  await refused(postJson(shellOf(base), { folder: 3 }), 400, FOLDER_BODY_MESSAGE, 'not a string');
  await server.dispatch({ type: 'createTask', title: 'one', body: '', stage: STAGES[0].name, prefix: 'HIVE', workspace: WORKSPACE, auto: false });
  assert.equal((await postJson(`${base}/tasks/local:1/open`, { kind: 'terminal' })).status, 200);
  const activity = activityOf(server.getState()!, 'local:1');
  assert.ok(activity?.worktree);
  await mkdir(join(activity.worktree, 'src'), { recursive: true });
  assert.equal((await postJson(`${base}/activities/${encodeURIComponent(activity.id)}/shell`, { folder: 'src' })).status, 200);
  assert.equal(workers.at(-1)?.launch.cwd, await realpath(join(activity.worktree, 'src')));
  assert.equal(workers.length, 3, 'the checkout\'s terminal, the task\'s first one and the folder\'s: no refusal opened one');
});
