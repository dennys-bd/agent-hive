import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import { FOLDER_QUERY_MESSAGE, nestedRepoOf, repoViewOf, REVEAL_BODY_MESSAGE, taskTree, treeRoot, untrackedMarks } from '../src/server-tree.js';
import { revealCommand } from '../src/platform-commands.js';
import { FOLDER_MISSING_MESSAGE, GIT_MESSAGE, OUTSIDE_MESSAGE } from '../src/tree-paths.js';
import { localActivityId } from '../src/activities.js';
import { LOCAL_ACTIVITY_MESSAGE } from '../src/activity-routes.js';
import { UNKNOWN_WORKSPACE_MESSAGE } from '../src/server-files.js';
import { worktreePath } from '../src/worktree.js';
import type { TaskTree, Config, Exec } from '../src/types.js';
import { hiveFetch } from './secret-client.js';
import { head, ignoredEntry, ordinary, renamed, statusText, untracked } from './fixtures/porcelain-v2.js';
import { withLocal, workPath } from './fixtures/work.js';
import { IGNORED_ENTRIES, postJson, startTree, task } from './fixtures/tree-server.js';

// GET /activities/:id/tree and POST /activities/:id/reveal (redesign 07, #629), over local tasks saved in state.json, with git and the reveal command faked.

test('repoViewOf marks the folder\'s direct child files as the outer tree does, leaves a deeper path out, marks a deleted direct child D (it has no row, only its folders read it), reads a rename as new, and names the children the nested repository ignores, an ignored folder covering its subtree (#1)', () => {
  const status = statusText(ordinary('.M', 'agent/foo.md'), untracked('agent/new.md'), ordinary('.M', 'agent/deep/y.md'), ordinary('.D', 'agent/gone.md'), renamed('R.', 'agent/moved.md', 'agent/was.md'), ignoredEntry('agent/x.log'), ignoredEntry('agent/old/'), ignoredEntry('agent/deep/z.log'));
  const children = { files: ['foo.md', 'moved.md', 'new.md', 'tracked.md', 'x.log'], folders: ['deep', 'old'] };
  assert.deepEqual(repoViewOf(status, 'agent', children), { marks: { 'foo.md': 'M', 'gone.md': 'D', 'moved.md': 'A', 'new.md': 'A' }, ignored: ['old', 'x.log'] });
  // the read folder inside an ignored one: git names only the folder, `dir/`, and every child sits under it
  assert.deepEqual(repoViewOf(statusText(ignoredEntry('agent/old/')), 'agent/old', { files: ['a.txt'], folders: ['b'] }), { marks: {}, ignored: ['a.txt', 'b'] });
  // the nested repository's own root: no prefix
  assert.deepEqual(repoViewOf(statusText(ordinary('.M', 'README.md'), ignoredEntry('build/')), '', { files: ['README.md'], folders: ['build'] }), { marks: { 'README.md': 'M' }, ignored: ['build'] });
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
  assert.deepEqual(f.calls.map(([, args]) => args.slice(7).join(' ')).sort(), [
    'ls-files -z --cached --others --exclude-standard',
    'ls-files -z --others --directory --exclude-standard',
    'status --porcelain=v2 -z --branch --untracked-files=normal --ignored=traditional',
  ]);
});

test('taskTree answers the ignored entries outermost and sorted, whatever order git gives, with a nested repository it does not ignore and no .git at any depth (HIVE-22)', async () => {
  const exec: Exec = async (_file, args) => {
    if (args.includes('--directory')) return { stdout: ['vendor/lib/', 'empty/', ''].join('\0') };
    if (args.includes('status')) return { stdout: statusText(ignoredEntry('node_modules/'), ignoredEntry('docs/'), ignoredEntry('z.log'), ignoredEntry('a.log'), ignoredEntry('.git/'), ignoredEntry('sub/.GIT/config')) };
    return { stdout: ['a.txt', ''].join('\0') };
  };
  const tree = await taskTree('/wt', exec, async (folder) => folder.endsWith('vendor/lib/'));
  assert.deepEqual([tree.folders, tree.ignored], [['empty'], { files: ['a.log', 'z.log'], folders: ['docs', 'node_modules', 'vendor/lib'] }]);
});

test('taskTree answers the branch from the status run\'s # branch.head: a branch, none on a detached HEAD, and a repository\'s first one before any commit (#713, #502)', async () => {
  const treeOf = (status: string) => taskTree('/wt', async (_file, args) => ({ stdout: args.includes('status') ? status : '' }), async () => false);
  assert.equal((await treeOf(statusText(head('main')))).branch, 'main');
  assert.equal('branch' in (await treeOf(statusText(head('(detached)')))), false, 'detached: no branch');
  assert.equal((await treeOf(statusText('# branch.oid (initial)', '# branch.head main'))).branch, 'main');
});

test('taskTree marks A every listed entry under an untracked folder, a nested repository\'s own entry included, as the per-file ?? did (#502)', async () => {
  const exec: Exec = async (_file, args) => {
    if (args.includes('--directory')) return { stdout: ['newdir/', 'vendor/lib/', ''].join('\0') };
    if (args.includes('status')) return { stdout: statusText(untracked('newdir/'), untracked('vendor/lib/'), untracked('loose.txt')) };
    return { stdout: ['a.txt', 'loose.txt', 'newdir/x.ts', 'newdir/sub/y.ts', 'vendor/lib/', ''].join('\0') };
  };
  const tree = await taskTree('/wt', exec, async (folder) => folder.endsWith('vendor/lib/'));
  assert.deepEqual(tree.marks, { 'loose.txt': 'A', 'newdir/x.ts': 'A', 'newdir/sub/y.ts': 'A', 'vendor/lib/': 'A' });
  assert.deepEqual(tree.files, ['a.txt', 'loose.txt', 'newdir/x.ts', 'newdir/sub/y.ts']);
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
  assert.deepEqual(f.calls, [['git', ['--no-optional-locks', '-C', join(wt, 'docs'), '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '--literal-pathspecs', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--', 'agent']]]);
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

test('untrackedMarks marks every entry under an untracked folder, a nested repository\'s own `dir/` included, and stays linear in the entries (#502)', () => {
  const folders = Array.from({ length: 2_000 }, (_, i) => `untracked-${i}/`);
  const entries = ['tracked/a.ts', 'untracked-0x/a.ts', 'untracked-0/', 'untracked-1/deep/er/f.ts', ...Array.from({ length: 50_000 }, (_, i) => `tracked/${i}.ts`)];
  const started = performance.now();
  const marks = untrackedMarks(entries, folders);
  assert.deepEqual(marks, { 'untracked-0/': 'A', 'untracked-1/deep/er/f.ts': 'A' });
  assert.ok(performance.now() - started < 300, 'entries x folders scan');
});
