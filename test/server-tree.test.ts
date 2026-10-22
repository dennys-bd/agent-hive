import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { FOLDER_QUERY_MESSAGE, nestedRepoOf, parseStatus, repoViewOf, REVEAL_BODY_MESSAGE, taskTree, treeRoot } from '../src/server-tree.js';
import { revealCommand } from '../src/platform-commands.js';
import { FOLDER_MISSING_MESSAGE, GIT_MESSAGE, OUTSIDE_MESSAGE } from '../src/tree-paths.js';
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
// git's ignored listing (HIVE-22): an ignored file, two ignored folders git did not walk into, and a .git the guard drops
const IGNORED = ['debug.log', 'node_modules/', 'docs/', '.git/', ''].join('\0');
// the vendor/lib nested repository the --directory listing names (it holds .git) joins the ignored folders
const IGNORED_ENTRIES = { files: ['debug.log'], folders: ['docs', 'node_modules', 'vendor/lib'] };
// a nested repository's git status (#1), its paths relative to that repository
const NESTED_STATUS = [' M agent/foo.md', '!! agent/x.log', ''].join('\0');
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
    if (args.includes('--ignored=matching')) {
      if (args[2].endsWith('broken')) throw new Error('fatal: not a git repository');
      return { stdout: NESTED_STATUS };
    }
    if (args.includes('--ignored')) return { stdout: IGNORED };
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

test('parseStatus marks changed files M, new, untracked or renamed ones A, and deleted ones D, which it also lists as deleted; a rename\'s old path is skipped (#903)', () => {
  const { marks, deleted } = parseStatus(STATUS);
  assert.deepEqual(marks, { 'src/b.ts': 'M', 'gone.txt': 'D', 'new.txt': 'A', 'moved.ts': 'A' });
  assert.deepEqual([...deleted], ['gone.txt']);
  // a staged deletion, and a file added then deleted from the worktree: both gone from the disk
  const staged = parseStatus(['D  staged.txt', 'AD added-gone.txt', ''].join('\0'));
  assert.deepEqual([staged.marks, [...staged.deleted]], [{ 'staged.txt': 'D', 'added-gone.txt': 'D' }, ['staged.txt', 'added-gone.txt']]);
  // a staged delete re-created on disk: git lists `D ` then `??`; the file is back, new and no longer deleted
  const back = parseStatus(['D  back.txt', '?? back.txt', ''].join('\0'));
  assert.deepEqual([back.marks, [...back.deleted]], [{ 'back.txt': 'A' }, []]);
});

test('repoViewOf marks the folder\'s direct child files as the outer tree does, leaves a deeper path out, marks a deleted direct child D (it has no row, only its folders read it), reads a rename as new, and names the children the nested repository ignores, an ignored folder covering its subtree (#1)', () => {
  const status = [' M agent/foo.md', '?? agent/new.md', ' M agent/deep/y.md', ' D agent/gone.md', 'R  agent/moved.md', 'agent/was.md', '!! agent/x.log', '!! agent/old/', '!! agent/deep/z.log', ''].join('\0');
  const children = { files: ['foo.md', 'moved.md', 'new.md', 'tracked.md', 'x.log'], folders: ['deep', 'old'] };
  assert.deepEqual(repoViewOf(status, 'agent', children), { marks: { 'foo.md': 'M', 'gone.md': 'D', 'moved.md': 'A', 'new.md': 'A' }, ignored: ['old', 'x.log'] });
  // the read folder inside an ignored one: git names only the folder, `dir/`, and every child sits under it
  assert.deepEqual(repoViewOf(['!! agent/old/', ''].join('\0'), 'agent/old', { files: ['a.txt'], folders: ['b'] }), { marks: {}, ignored: ['a.txt', 'b'] });
  // the nested repository's own root: no prefix
  assert.deepEqual(repoViewOf([' M README.md', '!! build/', ''].join('\0'), '', { files: ['README.md'], folders: ['build'] }), { marks: { 'README.md': 'M' }, ignored: ['build'] });
});

test('nestedRepoOf answers the nearest folder holding .git from the read folder up, a repository inside a nested one for its own files, the tree\'s root left out (#1)', async () => {
  const repos = new Set(['/wt', '/wt/docs', '/wt/docs/vendor/lib']);
  const hasGit = async (folder: string): Promise<boolean> => repos.has(folder);
  assert.equal(await nestedRepoOf('/wt', 'docs', hasGit), 'docs');
  assert.equal(await nestedRepoOf('/wt', 'docs/agent/specs', hasGit), 'docs');
  assert.equal(await nestedRepoOf('/wt', 'docs/vendor/lib/src', hasGit), 'docs/vendor/lib');
  assert.equal(await nestedRepoOf('/wt', 'node_modules/x', hasGit), undefined);
  assert.equal(await nestedRepoOf('/wt', '', hasGit), undefined);
});

test('GET /activities/:id/tree lists the worktree the slug names without the deleted paths or a nested repo, with the marks, and never takes the index lock', async (t) => {
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })]);
  const res = await hiveFetch(`${f.base}${workPath(f.server, 'local:1')}/tree`);
  assert.deepEqual([res.status, await res.json()], [200, { root: worktreePath(f.repo, 'hive-1-task'), checkout: '.hive/worktrees/hive-1-task', files: ['a.txt', 'src/b.ts', 'new.txt'], marks: { 'src/b.ts': 'M', 'gone.txt': 'D', 'new.txt': 'A', 'moved.ts': 'A' }, folders: ['empty'], ignored: IGNORED_ENTRIES }]);
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
  assert.deepEqual([res.status, await res.json()], [200, { root: f.repo, files: ['a.txt', 'src/b.ts', 'new.txt'], marks: { 'src/b.ts': 'M', 'gone.txt': 'D', 'new.txt': 'A', 'moved.ts': 'A' }, folders: ['empty'], ignored: IGNORED_ENTRIES }]);
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
  const config: Pick<Config, 'comb'> = { comb: { prefix: 'HIVE', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }], sources: [], transitions: [], stages: [], commands: [], hiveSource: true, createIn: 'hive' } };
  const state = withLocal(withLocal({ ...initialState(0), workspaces: ['hive', 'site'] }, 'hive'), 'site');
  assert.equal(treeRoot(state, config, localActivityId('hive')), '/repo');
  assert.deepEqual(treeRoot(state, config, localActivityId('site')), { status: 404, message: UNKNOWN_WORKSPACE_MESSAGE });
});

test('GET /activities/:id/tree answers a task\'s root relative to its workspace\'s checkout, and no checkout for a local run or a local activity, whose root is the checkout itself (#131)', async (t) => {
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') }), task(2, { worktree: repo, local: true })]);
  const checkoutAt = async (path: string): Promise<string | undefined> => ((await (await hiveFetch(`${f.base}${path}/tree`)).json()) as TaskTree).checkout;
  assert.deepEqual(
    [await checkoutAt(workPath(f.server, 'local:1')), await checkoutAt(workPath(f.server, 'local:2')), await checkoutAt(LOCAL)],
    ['.hive/worktrees/hive-1-task', undefined, undefined],
  );
});

test('GET /activities/:id/tree lists as folders the --directory entries no listed file sits under, moves a nested repository to the ignored folders, and answers its root (#818, HIVE-22)', async (t) => {
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })]);
  const tree = (await (await hiveFetch(`${f.base}${workPath(f.server, 'local:1')}/tree`)).json()) as TaskTree;
  assert.deepEqual([tree.root, tree.folders, tree.ignored], [worktreePath(f.repo, 'hive-1-task'), ['empty'], IGNORED_ENTRIES]);
  const argv = f.calls.map(([, args]) => args.join(' '));
  assert.ok(argv.some((line) => line.endsWith('ls-files -z --others --directory --exclude-standard')));
  assert.ok(argv.some((line) => line.endsWith('ls-files -z --others --ignored --exclude-standard --directory')));
});

test('taskTree answers the ignored entries outermost and sorted, whatever order git gives, with a nested repository it does not ignore and no .git at any depth (HIVE-22)', async () => {
  const exec: Exec = async (_file, args) => {
    if (args.includes('--ignored')) return { stdout: ['node_modules/', 'docs/', 'z.log', 'a.log', '.git/', 'sub/.GIT/config', ''].join('\0') };
    if (args.includes('--directory')) return { stdout: ['vendor/lib/', 'empty/', ''].join('\0') };
    return { stdout: args.includes('status') ? '' : ['a.txt', ''].join('\0') };
  };
  const tree = await taskTree('/wt', exec, async (folder) => folder.endsWith('vendor/lib/'));
  assert.deepEqual([tree.folders, tree.ignored], [['empty'], { files: ['a.log', 'z.log'], folders: ['docs', 'node_modules', 'vendor/lib'] }]);
});

test('taskTree answers the branch its root has out, and none on a detached HEAD or when git fails (#713)', async () => {
  const execWith = (branch: () => string): Exec => async (_file, args) => ({ stdout: args.includes('--show-current') ? branch() : '' });
  assert.equal((await taskTree('/wt', execWith(() => 'main\n'), async () => false)).branch, 'main');
  assert.equal('branch' in (await taskTree('/wt', execWith(() => '\n'), async () => false)), false, 'detached: no branch');
  assert.equal('branch' in (await taskTree('/wt', execWith(() => { throw new Error('fatal'); }), async () => false)), false, 'a failed read is no branch, not a failed tree');
});

test('GET /activities/:id/tree/folder lists a folder\'s children from disk, sorted, .git left out, running no git; a path outside the root, under .git, missing or not a string is refused, running no git (HIVE-22, #1)', async (t) => {
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })]);
  const wt = worktreePath(f.repo, 'hive-1-task');
  await mkdir(join(wt, 'docs', 'agent'), { recursive: true });
  await writeFile(join(wt, 'docs', 'glossary.md'), 'g');
  await writeFile(join(wt, 'docs', 'README.md'), 'r');
  await writeFile(join(wt, 'docs', '.git'), 'gitdir: elsewhere'); // a docs worktree's .git is a file
  const folder = (query: string): Promise<Response> => hiveFetch(`${f.base}${workPath(f.server, 'local:1')}/tree/folder${query}`);
  const res = await folder('?path=docs');
  assert.deepEqual([res.status, await res.json()], [200, { files: ['README.md', 'glossary.md'], folders: ['agent'], repo: { marks: {}, ignored: [] } }]);
  // docs holds .git: one status in it, its own root as the pathspec `.`
  assert.deepEqual(f.calls.map(([, args]) => [args[2], args.at(-1)]), [[join(wt, 'docs'), '.']]);
  f.calls.length = 0;
  const refusals = [['?path=..%2Fx', OUTSIDE_MESSAGE], ['?path=vendor%2Flib%2F.git', GIT_MESSAGE], ['?path=nope', FOLDER_MISSING_MESSAGE], ['', FOLDER_QUERY_MESSAGE], ['?path=a&path=b', FOLDER_QUERY_MESSAGE]] as const;
  for (const [query, message] of refusals) {
    const refused = await folder(query);
    assert.deepEqual([refused.status, await refused.json()], [400, { error: message }], query);
  }
  assert.deepEqual(f.calls, []);
});

test('GET /activities/:id/tree/folder answers a nested repository\'s marks and ignored names from one status in that repository, limited to the folder; a folder with no repository above runs no git (#1)', async (t) => {
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })]);
  const wt = worktreePath(f.repo, 'hive-1-task');
  await mkdir(join(wt, 'docs', 'agent'), { recursive: true });
  await mkdir(join(wt, 'src'), { recursive: true });
  await writeFile(join(wt, 'docs', '.git'), 'gitdir: elsewhere'); // a docs worktree's .git is a file
  await Promise.all(['foo.md', 'bar.md', 'x.log'].map((name) => writeFile(join(wt, 'docs', 'agent', name), name)));
  await writeFile(join(wt, 'src', 'b.ts'), 'b');
  const folder = (path: string): Promise<Response> => hiveFetch(`${f.base}${workPath(f.server, 'local:1')}/tree/folder?path=${encodeURIComponent(path)}`);
  const res = await folder('docs/agent');
  assert.deepEqual([res.status, await res.json()], [200, { files: ['bar.md', 'foo.md', 'x.log'], folders: [], repo: { marks: { 'foo.md': 'M' }, ignored: ['x.log'] } }]);
  assert.deepEqual(f.calls, [['git', ['--no-optional-locks', '-C', join(wt, 'docs'), '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', 'agent']]]);
  f.calls.length = 0;
  // a path written with `..` finds the same repository and pathspec
  assert.deepEqual((await (await folder('src/../docs/agent')).json()).repo, { marks: { 'foo.md': 'M' }, ignored: ['x.log'] });
  assert.deepEqual(f.calls.map(([, args]) => [args[2], args.at(-1)]), [[join(wt, 'docs'), 'agent']]);
  f.calls.length = 0;
  assert.deepEqual(await (await folder('src')).json(), { files: ['b.ts'], folders: [] });
  assert.deepEqual(f.calls, []);
  // a nested repository whose status fails still lists its folder, without marks
  await mkdir(join(wt, 'broken'), { recursive: true });
  await writeFile(join(wt, 'broken', '.git'), 'gitdir: gone');
  await writeFile(join(wt, 'broken', 'a.md'), 'a');
  const broken = await folder('broken');
  assert.deepEqual([broken.status, await broken.json()], [200, { files: ['a.md'], folders: [] }]);
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
