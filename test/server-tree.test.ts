import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { parseStatus, REVEAL_BODY_MESSAGE, treeRoot } from '../src/server-tree.js';
import { revealCommand } from '../src/platform-commands.js';
import { OUTSIDE_MESSAGE } from '../src/tree-paths.js';
import { localActivityId } from '../src/activities.js';
import { LOCAL_ACTIVITY_MESSAGE } from '../src/activity-routes.js';
import { UNKNOWN_WORKSPACE_MESSAGE } from '../src/server-files.js';
import { saveState } from '../src/state-store.js';
import { worktreePath } from '../src/worktree.js';
import type { Task, TaskTree, Config, Exec, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { LOCAL_STAGES, workspacesAt, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { savedTasks, type WithWork, withLocal, workPath } from './fixtures/work.js';

// GET /activities/:id/tree and POST /activities/:id/reveal (redesign 07, #629), over local tasks saved in state.json, with git and the reveal command faked.
const LISTED = ['a.txt', 'src/b.ts', 'gone.txt', 'new.txt', 'vendor/lib/', ''].join('\0');
// git's --directory listing (#818): an empty folder, a folder a listed file sits under, and the nested repository LISTED names too
const DIRS = ['empty/', 'src/', 'vendor/lib/', ''].join('\0');
const STATUS = [' M src/b.ts', ' D gone.txt', '?? new.txt', 'R  moved.ts', 'old.ts', ''].join('\0');
const task = (n: number, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive', ...extra,
});
// The slug a saved activity carries (#629): the one the worktree paths below name
const SLUG_OF = (c: Task): string => `hive-${c.item.id.replace('HIVE-', '')}-task`;
const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });

async function startTree(t: TestContext, tasks: (repo: string) => WithWork[]): Promise<{ base: string; repo: string; calls: [string, string[]][]; server: HiveServer }> {
  const { home, repo } = await tempHive(t);
  const saved = tasks(repo);
  for (const c of saved) if (c.worktree !== undefined && !c.worktreeGone) await mkdir(join(c.worktree, 'vendor/lib/.git'), { recursive: true }); // the nested repository (#818)
  await mkdir(join(repo, 'vendor/lib/.git'), { recursive: true });
  await saveState(home, savedTasks({ ...initialState(0), localCount: saved.length }, saved, SLUG_OF)); // #629: each worktree on its activity
  const calls: [string, string[]][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, args]);
    if (args.includes('--directory')) return { stdout: DIRS };
    if (args.includes('ls-files')) return { stdout: LISTED };
    return { stdout: args.includes('status') ? STATUS : '' };
  };
  const server = createServer({ secret: SECRET, home, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SettingsBody = { prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], stages: LOCAL_STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [] };
  assert.equal((await postJson(`${base}/settings`, body)).status, 200);
  calls.length = 0;
  return { base, repo, calls, server };
}

test('parseStatus marks changed files M and new, untracked or renamed ones A, drops deleted ones, and skips a rename\'s old path', () => {
  const { marks, deleted } = parseStatus(STATUS);
  assert.deepEqual(marks, { 'src/b.ts': 'M', 'new.txt': 'A', 'moved.ts': 'A' });
  assert.deepEqual([...deleted], ['gone.txt']);
});

test('GET /activities/:id/tree lists the worktree the slug names without the deleted paths or a nested repo, with the marks, and never takes the index lock', async (t) => {
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })]);
  const res = await hiveFetch(`${f.base}${workPath(f.server, 'local:1')}/tree`);
  assert.deepEqual([res.status, await res.json()], [200, { root: worktreePath(f.repo, 'hive-1-task'), files: ['a.txt', 'src/b.ts', 'new.txt'], marks: { 'src/b.ts': 'M', 'new.txt': 'A', 'moved.ts': 'A' }, folders: ['empty'] }]);
  for (const [file, args] of f.calls) {
    assert.equal(file, 'git');
    assert.deepEqual(args.slice(0, 3), ['--no-optional-locks', '-C', worktreePath(f.repo, 'hive-1-task')]);
  }
});

// #629: a task with no activity (local:1, never opened) is no activity to address: 404, as an unknown one
test('GET /activities/:id/tree and POST /activities/:id/reveal refuse an unknown activity (404) and one with no worktree on disk (409), running nothing', async (t) => {
  const f = await startTree(t, (repo) => [task(1), task(2, { worktree: worktreePath(repo, 'hive-2-task'), worktreeGone: true })]);
  for (const [id, status] of [['local:9', 404], ['local:1', 404], ['local:2', 409]] as const) {
    assert.equal((await hiveFetch(`${f.base}${workPath(f.server, id)}/tree`)).status, status, id);
    assert.equal((await postJson(`${f.base}${workPath(f.server, id)}/reveal`)).status, status, id);
  }
  assert.deepEqual(f.calls, []);
});

test('POST /activities/:id/reveal shows the task\'s worktree with the platform\'s reveal command (#629, #658)', async (t) => {
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })]);
  assert.equal((await postJson(`${f.base}${workPath(f.server, 'local:1')}/reveal`)).status, 204);
  assert.deepEqual(f.calls, [revealCommand(process.platform, worktreePath(f.repo, 'hive-1-task'))]);
});

// #633: a workspace's local activity, whose tree is the workspace's checkout (the temp git repo the setup saves as `hive`)
const LOCAL = `/activities/${encodeURIComponent(localActivityId('hive'))}`;

test('GET /activities/local:<workspace>/tree lists the workspace checkout with its marks, and its reveal shows the checkout (#633, #658)', async (t) => {
  const f = await startTree(t, () => []);
  const res = await hiveFetch(`${f.base}${LOCAL}/tree`);
  assert.deepEqual([res.status, await res.json()], [200, { root: f.repo, files: ['a.txt', 'src/b.ts', 'new.txt'], marks: { 'src/b.ts': 'M', 'new.txt': 'A', 'moved.ts': 'A' }, folders: ['empty'] }]);
  for (const [file, args] of f.calls) assert.deepEqual([file, ...args.slice(0, 3)], ['git', '--no-optional-locks', '-C', f.repo]);
  f.calls.length = 0;
  assert.equal((await postJson(`${f.base}${LOCAL}/reveal`)).status, 204);
  assert.deepEqual(f.calls, [revealCommand(process.platform, f.repo)]);
});

test('a local activity\'s diff and files still answer 409: only the tree routes take its checkout (#633)', async (t) => {
  const f = await startTree(t, () => []);
  for (const path of ['diff?scope=worktree', 'files']) {
    const res = await hiveFetch(`${f.base}${LOCAL}/${path}`);
    assert.deepEqual([res.status, await res.json()], [409, { error: LOCAL_ACTIVITY_MESSAGE }], path);
  }
  assert.deepEqual(f.calls, []);
});

// A save removes a workspace's local activity with it (withLocalActivities), so the route cannot reach this; treeRoot still refuses it
test('treeRoot resolves a local activity to its frozen workspace\'s checkout, and one whose workspace left the config to a 404 (#633)', () => {
  const config: Pick<Config, 'comb'> = { comb: { prefix: 'HIVE', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null }], sources: [], transitions: [], stages: [], commands: [], hiveSource: true, createIn: 'hive' } };
  const state = withLocal(withLocal({ ...initialState(0), workspaces: ['hive', 'site'] }, 'hive'), 'site');
  assert.equal(treeRoot(state, config, localActivityId('hive')), '/repo');
  assert.deepEqual(treeRoot(state, config, localActivityId('site')), { status: 404, message: UNKNOWN_WORKSPACE_MESSAGE });
});

test('GET /activities/:id/tree lists as folders the --directory entries no listed file sits under, leaves out a nested repository, and answers its root (#818)', async (t) => {
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })]);
  const tree = (await (await hiveFetch(`${f.base}${workPath(f.server, 'local:1')}/tree`)).json()) as TaskTree;
  assert.deepEqual([tree.root, tree.folders], [worktreePath(f.repo, 'hive-1-task'), ['empty']]);
  assert.ok(f.calls.some(([, args]) => args.join(' ').endsWith('ls-files -z --others --directory --exclude-standard')));
});

test('POST /activities/:id/reveal with a path shows that item, by its real path; one outside the root or a bad path runs nothing (#818)', async (t) => {
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })]);
  const wt = worktreePath(f.repo, 'hive-1-task');
  await mkdir(join(wt, 'src'), { recursive: true });
  await writeFile(join(wt, 'src', 'b.ts'), 'b');
  const reveal = (body: unknown): Promise<Response> => postJson(`${f.base}${workPath(f.server, 'local:1')}/reveal`, body);
  const outside = await reveal({ path: '../x' });
  assert.deepEqual([outside.status, await outside.json()], [400, { error: OUTSIDE_MESSAGE }]);
  const bad = await reveal({ path: 3 });
  assert.deepEqual([bad.status, await bad.json()], [400, { error: REVEAL_BODY_MESSAGE }]);
  assert.deepEqual(f.calls, []);
  assert.equal((await reveal({ path: 'src/b.ts' })).status, 204);
  assert.deepEqual(f.calls, [revealCommand(process.platform, join(await realpath(wt), 'src', 'b.ts'), true)]);
});
