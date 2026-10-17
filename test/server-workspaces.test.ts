import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, type HiveServer } from '../src/server.js';
import type { Source, SourceItem, SourceTaskProps, Stage, Exec, OpenResult, Workspace, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { activityOf } from '../src/activities.js';
import { slugFor } from '../src/tasks.js';
import { readyOn, workPath } from './fixtures/work.js';
import { AUTH, STAGES, fakeSpawn, GITHUB_ENTRY, launchFlag, type FakeWorker, OPTIONS, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// Several workspaces per Comb (#179): two git repos, hive and site, behind one GitHub-shaped source whose listing a test fills.
const ORPHAN = 'hive-9-gone'; // a worktree every repo's git lists under .hive/worktrees, owned by no task
// A source with one rule (#293, #688) no test lists a Repo for, and no default workspace: a task's workspace is the hint a test lists, or none.
const ROUTED: SourceTaskProps = { defaults: { auto: true }, rules: [{ field: 'Repo', op: 'equals', value: 'hive', set: { workspace: 'hive' } }] };

interface Two {
  base: string; server: HiveServer; workers: FakeWorker[]; hive: Workspace; site: Workspace;
  listed: SourceItem[]; // what the source lists at the next poll
  calls: string[][]; // every git argv: ['git', '-C', <dir>, …]
  body: SettingsBody; // the save that configured it: a test re-posts it with a change
}

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
// What POST /tasks/:id/open answers once the run it started exists (#249): ok and the ptyId pool.started confirmed, so the page can
// attach it with no extra click.
const opened = async (res: Response | Promise<Response>): Promise<void> => {
  const body = await json<OpenResult>(res);
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'ptyId']);
  assert.equal(typeof body.ptyId, 'string');
};
const item = (id: string, hint?: string, column = 'Ready'): SourceItem => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: `https://github.com/acme/r/issues/${id}`, ...(hint === undefined ? {} : { workspaceHint: hint }) }, column,
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

// git answers every command with nothing, except `worktree list`, which shows the repo and ORPHAN under its .hive/worktrees.
function twoGit(calls: string[][]): Exec {
  return async (file, args) => {
    calls.push([file, ...args]);
    const [, dir, command, sub] = args;
    const listing = `worktree ${dir}\nHEAD 1111\nbranch refs/heads/main\n\nworktree ${worktreePath(dir, ORPHAN)}\nHEAD 3333\nbranch refs/heads/hive/9-gone\n`;
    return { stdout: command === 'worktree' && sub === 'list' ? listing : '' };
  };
}

async function startTwo(t: TestContext, source: Record<string, unknown> = {}, maxConcurrent = 2, stages: Stage[] = STAGES): Promise<Two> {
  const hive: Workspace = { name: 'hive', path: (await tempHive(t)).repo, env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' };
  const { home, repo } = await tempHive(t, maxConcurrent);
  const site: Workspace = { name: 'site', path: repo, env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' };
  const listed: SourceItem[] = [];
  const calls: string[][] = [];
  const sourceFactory = (): Source => ({ resolveFields: async () => {}, listItems: async () => [...listed], setColumn: async () => {}, apply: async () => {}, settingsOptions: async () => OPTIONS });
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ secret: SECRET, home, sourceFactory, launchPty: spawn, exec: twoGit(calls) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body = {
    prefix: 'HIVE', auth: AUTH, sources: [{ ...GITHUB_ENTRY, taskProps: ROUTED, ...source }], stages, onClose: 'menuBar',
    deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [], workspaces: [hive, site],
  } as SettingsBody;
  assert.equal((await postJson(`${base}/settings`, body)).status, 200);
  await server.poll(); // the save's own poll runs in the background (#59): settle it on the empty listing
  await server.dispatch({ type: 'setSignal', signal: 'green' });
  return { base, server, workers, hive, site, listed, calls, body };
}

test('a save that changes the source default dispatches setWorkspaces: a task no rule placed starts in that workspace (#179)', async (t) => {
  const two = await startTwo(t);
  two.listed.push(item('1'));
  await two.server.poll();
  assert.equal(two.workers.length, 0, 'two workspaces, no hint, a dynamic board with no default: the task waits');
  assert.deepEqual(two.server.getState()?.workspaces, ['hive', 'site']);
  const withDefault = { ...two.body, sources: [{ ...two.body.sources![0], taskProps: { ...ROUTED, defaults: { workspace: 'site', auto: true } } }] }; // the rule stays: the default is its fallback (#688)
  assert.equal((await postJson(`${two.base}/settings`, withDefault)).status, 200);
  await waitFor(() => two.workers.length === 1);
  assert.deepEqual(two.server.getState()?.sourceWorkspaces, { board: 'site' });
  assert.equal(two.server.getState()?.tasks[0].workspace, 'site');
});

test('each task spawns in its own workspace: the worktree is added with git -C <workspace> and the worker runs under <workspace>/.hive/worktrees; the worker cap counts both (#179)', async (t) => {
  const two = await startTwo(t, {}, 2);
  two.listed.push(item('1', 'hive'), item('2', 'site'), item('3', 'site'));
  await two.server.poll();
  assert.deepEqual(two.workers.map((w) => w.launch.cwd), [worktreePath(two.hive.path, 'hive-1-task-1'), worktreePath(two.site.path, 'hive-2-task-2')]);
  assert.equal(activityOf(two.server.getState()!, 'board:I3')?.workerId, undefined, 'two workers across both workspaces: the third waits'); // #629: the activity's
  assert.deepEqual(two.calls.filter((c) => c.includes('add')).map((c) => c[2]), [two.hive.path, two.site.path]);
});

test('the deleteActivity effect runs git in the task\'s workspace; a task no rule places gets no worktree, so nothing to delete (#179, #629)', async (t) => {
  const stages: Stage[] = [...STAGES, { name: 'done', from: { board: ['Done'] }, action: 'deleteActivity' }];
  const two = await startTwo(t, {}, 0, stages);
  two.listed.push(item('1', 'site'), item('2'));
  await two.server.poll(); // both wait in the first stage: no worker
  for (const task of two.server.getState()!.tasks) { // something to clean (#236): a task with nothing the scope covers just moves on
    await readyOn(two.server, task.item.itemId, { path: `/wt/${slugFor(task.item)}`, branch: `hive/${task.item.id}`, base: null, local: false });
  }
  // The open route places a task before its worktreeReady: an unplaced one gets no activity, so no worktree either (#629)
  assert.equal(activityOf(two.server.getState()!, 'board:I2')?.worktree, undefined);
  two.listed.splice(0, 2, item('1', 'site', 'Done'), item('2', undefined, 'Done'));
  two.calls.length = 0;
  await two.server.poll(); // the delete activity runs inside the poll's dispatch, before the worktree check drops the fake paths
  assert.ok(two.calls.length > 0 && two.calls.every((c) => c[2].startsWith(two.site.path)), two.calls.map((c) => c.join(' ')).join('\n'));
  assert.equal(activityOf(two.server.getState()!, 'board:I2')?.error, undefined, 'nothing to clean: it moves on'); // #629: the activity's
});

test('a save refuses to remove or re-path a workspace a running task resolves to (409) and accepts removing one no running task uses (#179)', async (t) => {
  const two = await startTwo(t, {}, 1);
  two.listed.push(item('1', 'site'));
  await two.server.poll();
  assert.equal(two.workers.length, 1);
  const moved: Workspace = { name: 'site', path: (await tempHive(t)).repo, env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' };
  for (const workspaces of [[two.hive], [two.hive, moved]]) {
    const res = await postJson(`${two.base}/settings`, { ...two.body, workspaces });
    assert.equal(res.status, 409, JSON.stringify(workspaces));
    assert.deepEqual(await res.json(), { error: 'workspace site has a running worker' });
  }
  assert.equal((await postJson(`${two.base}/settings`, { ...two.body, workspaces: [two.site], sources: [{ ...two.body.sources![0], taskProps: { defaults: { workspace: 'site', auto: true }, rules: [] } }] })).status, 200, 'hive has no running task: it may go, the board with it');
  assert.deepEqual(two.server.getState()?.workspaces, ['site']);
});

test('every workspace gets .hive/ in its .git/info/exclude (#179)', async (t) => {
  const two = await startTwo(t);
  for (const { path } of [two.hive, two.site]) assert.match(await readFile(join(path, '.git', 'info', 'exclude'), 'utf8'), /^\.hive\/$/m, path);
});

test('POST /tasks/:id/workspace sets a fresh task\'s workspace and the fill starts it there: 404 unknown task, 400 unknown name, 409 once it has a worktree (#179)', async (t) => {
  const two = await startTwo(t, {}, 1);
  two.listed.push(item('1'));
  await two.server.poll();
  assert.equal(two.workers.length, 0);
  const refusals: [string, unknown, number, string][] = [['board:I9', 'site', 404, 'tarefa desconhecida'], ['board:I1', 'nope', 400, 'unknown workspace'], ['board:I1', 7, 400, 'unknown workspace']];
  for (const [id, workspace, status, error] of refusals) {
    const res = await postJson(`${two.base}/tasks/${id}/workspace`, { workspace: workspace });
    assert.equal(res.status, status, `${id} ${String(workspace)}`);
    assert.deepEqual(await res.json(), { error });
  }
  assert.deepEqual(await json(postJson(`${two.base}/tasks/board:I1/workspace`, { workspace: 'site' })), { ok: true });
  await waitFor(() => two.workers.length === 1);
  assert.equal(two.workers[0].launch.cwd, worktreePath(two.site.path, 'hive-1-task-1'));
  const locked = await postJson(`${two.base}/tasks/board:I1/workspace`, { workspace: 'hive' });
  assert.equal(locked.status, 409);
  assert.deepEqual(await locked.json(), { error: 'delete the activity first' });
});

test('a task with no workspace: bases answers needsWorkspace, then the lists of the workspace the query names; start is 400 choose a workspace and starts with { workspace }, saving it (#179)', async (t) => {
  const two = await startTwo(t, {}, 1);
  await two.server.dispatch({ type: 'setSignal', signal: 'yellow' }); // only the manual start may run it
  two.listed.push(item('1'));
  await two.server.poll();
  assert.deepEqual(await json(hiveFetch(`${two.base}/tasks/board:I1/bases`)), { hasWorktree: false, defaultRef: '', tasks: [], local: [], remote: [], needsWorkspace: true });
  two.calls.length = 0;
  assert.equal((await hiveFetch(`${two.base}/tasks/board:I1/bases?workspace=site`)).status, 200);
  assert.ok(two.calls.length > 0 && two.calls.every((c) => c[2].startsWith(two.site.path)), 'the lists come from the workspace the popup chose');
  assert.equal((await hiveFetch(`${two.base}/tasks/board:I1/bases?workspace=nope`)).status, 400);
  const refused = await postJson(`${two.base}/tasks/board:I1/start`, { base: null });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'choose a workspace' });
  assert.equal((await postJson(`${two.base}/tasks/board:I1/start`, { base: null, workspace: 'nope' })).status, 400);
  assert.deepEqual(await json(postJson(`${two.base}/tasks/board:I1/start`, { base: null, workspace: 'site' })), { ok: true });
  await waitFor(() => two.workers.length === 1);
  assert.equal(two.server.getState()?.tasks[0].workspace, 'site');
  assert.equal(two.workers[0].launch.cwd, worktreePath(two.site.path, 'hive-1-task-1'));
});

test('POST /tasks takes a Comb workspace for the new task and refuses an unknown one with 400 (#179)', async (t) => {
  const two = await startTwo(t, {}, 0);
  assert.equal((await postJson(`${two.base}/tasks`, { title: 'x', stage: 'fila', workspace: 'site' })).status, 201);
  assert.equal(two.server.getState()?.tasks[0].workspace, 'site');
  const res = await postJson(`${two.base}/tasks`, { title: 'y', stage: 'fila', workspace: 'nope' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'unknown workspace' });
});

test('a task whose workspace was removed reads as gone: bases, delete-activity and the terminal answer 409 workspace <name> is gone (#179)', async (t) => {
  const two = await startTwo(t, {}, 0);
  two.listed.push(item('1', 'site'));
  await two.server.poll();
  await two.server.dispatch({ type: 'setAuto', taskId: 'board:I1', auto: false });
  const worktree = worktreePath(two.site.path, 'hive-1-task-1');
  await mkdir(worktree, { recursive: true }); // on disk: the poll after the save must not drop it
  await readyOn(two.server, 'board:I1', { path: worktree, branch: 'hive/1-task-1', base: null, local: false });
  assert.equal(two.server.getState()?.tasks[0].workspace, 'site');
  assert.equal((await postJson(`${two.base}/settings`, { ...two.body, workspaces: [two.hive] })).status, 200);
  const answers = [
    await hiveFetch(`${two.base}/tasks/board:I1/bases`),
    await postJson(`${two.base}${workPath(two.server, 'board:I1')}/delete`),
    await postJson(`${two.base}/tasks/board:I1/open`, { kind: 'terminal' }),
  ];
  for (const res of answers) {
    assert.equal(res.status, 409, res.url);
    assert.deepEqual(await res.json(), { error: 'workspace site is gone' });
  }
});

test('a task whose workspace left the config starts no run: an open with picks and a start answer 409; added back, its run loads <home>/plugins/<workspace> (#317)', async (t) => {
  const two = await startTwo(t, {}, 0);
  two.listed.push(item('1', 'site'));
  await two.server.poll();
  await two.server.dispatch({ type: 'setAuto', taskId: 'board:I1', auto: false });
  const worktree = worktreePath(two.site.path, 'hive-1-task-1');
  await mkdir(worktree, { recursive: true }); // on disk: the poll after the save must not drop it
  await readyOn(two.server, 'board:I1', { path: worktree, branch: 'hive/1-task-1', base: null, local: false });
  assert.equal((await postJson(`${two.base}/settings`, { ...two.body, workspaces: [two.hive] })).status, 200);
  const answers = [
    await postJson(`${two.base}/tasks/board:I1/open`, { kind: 'claude', specializedAgent: 'hive:designer' }),
    await postJson(`${two.base}/tasks/board:I1/start`, { base: null }),
  ];
  for (const res of answers) assert.deepEqual([res.status, await res.json()], [409, { error: 'workspace site is gone' }], res.url);
  assert.equal(two.workers.length, 0, 'nothing spawned');
  assert.equal((await postJson(`${two.base}/settings`, two.body)).status, 200); // site back: the save's render lands before it answers
  await opened(postJson(`${two.base}/tasks/board:I1/open`, { kind: 'claude' }));
  const dir = launchFlag(two.workers[0]?.launch, '--plugin-dir');
  assert.ok(dir?.endsWith(join('plugins', 'site')), dir);
});

test('POST /tasks/:id/open on a manual task with no workspace is 400 choose a workspace and creates nothing; with { workspace } it saves the choice and creates the worktree there before the terminal opens (#179, #237)', async (t) => {
  const two = await startTwo(t, {}, 0);
  two.listed.push(item('1'));
  await two.server.poll();
  await two.server.dispatch({ type: 'setAuto', taskId: 'board:I1', auto: false });
  const refused = await postJson(`${two.base}/tasks/board:I1/open`, { kind: 'terminal', base: null });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'choose a workspace' });
  assert.equal(activityOf(two.server.getState()!, 'board:I1')?.worktree, undefined);
  two.calls.length = 0;
  await opened(postJson(`${two.base}/tasks/board:I1/open`, { kind: 'terminal', base: null, workspace: 'site' }));
  const task = two.server.getState()!.tasks[0];
  assert.deepEqual([task.workspace, activityOf(two.server.getState()!, 'board:I1')?.worktree], ['site', worktreePath(two.site.path, 'hive-1-task-1')]);
  assert.ok(two.calls.every((c) => c[2].startsWith(two.site.path)));
});

test('GET /worktrees lists every workspace\'s worktrees, each row tagged with its workspace; the removal route takes the workspace, runs git there, and answers 404 for an unknown one (#179)', async (t) => {
  const two = await startTwo(t, {}, 0);
  assert.deepEqual(await json(hiveFetch(`${two.base}/worktrees`)), [
    { workspace: 'hive', slug: ORPHAN, path: worktreePath(two.hive.path, ORPHAN), branch: 'hive/9-gone', orphan: 'noTask' },
    { workspace: 'site', slug: ORPHAN, path: worktreePath(two.site.path, ORPHAN), branch: 'hive/9-gone', orphan: 'noTask' },
  ]);
  const unknown = await postJson(`${two.base}/worktrees/nope/${ORPHAN}/remove`, { force: true });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'unknown workspace' });
  await mkdir(worktreePath(two.site.path, ORPHAN), { recursive: true });
  two.calls.length = 0;
  assert.deepEqual(await json(postJson(`${two.base}/worktrees/site/${ORPHAN}/remove`, { force: true })), { removed: true });
  assert.ok(two.calls.length > 0 && two.calls.every((c) => c[2].startsWith(two.site.path)));
});
