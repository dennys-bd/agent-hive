import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import { trashCommand } from '../src/platform-commands.js';
import { createServer, type HiveServer } from '../src/server.js';
import { CREATE_BODY_MESSAGE, FILE_BODY_MESSAGE, INTO_ITSELF_MESSAGE, IS_FOLDER_MESSAGE, renameItem, saveNewFile, TAKEN_MESSAGE, TOO_LARGE_MESSAGE, type TreeFs } from '../src/server-tree-ops.js';
import { saveState } from '../src/state-store.js';
import { GIT_MESSAGE, MISSING_FILE_MESSAGE, OUTSIDE_MESSAGE } from '../src/tree-paths.js';
import { worktreePath } from '../src/worktree.js';
import type { Exec, SettingsBody, Task } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, CLOSE_TAB_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, EDITOR_FILE_MAX, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS, SLEEP_NOTICE_DEFAULTS } from '../src/types.js';
import { LOCAL_STAGES, tempHive, workspacesAt } from './fakes.js';
import { savedTasks, type WithWork, workPath } from './fixtures/work.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// The files tree's own operations (#818) end to end: one local task's worktree is a real temp folder; the exec records the trash's argv and
// runs nothing.
const FILES: Record<string, string> = { 'README.md': 'readme', 'src/a.ts': 'a', 'docs/guide.md': 'guide' };
const task = (n: number, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive', ...extra,
});
const SLUG_OF = (c: Task): string => `hive-${c.item.id.replace('HIVE-', '')}-task`; // the slug the worktree path below names (#629)
const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const setupBody = (repo: string): SettingsBody => ({
  prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], stages: LOCAL_STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS,
  shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, ...CLOSE_TAB_DEFAULTS, ...SLEEP_NOTICE_DEFAULTS, defaultAgent: 'claude',
  theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
});
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const sha256 = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

interface Ops { base: string; wt: string; outside: string; calls: [string, string[]][]; server: HiveServer }

async function startOps(t: TestContext): Promise<Ops> {
  const { home, repo } = await tempHive(t);
  const wt = worktreePath(repo, 'hive-1-task');
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(join(wt, path, '..'), { recursive: true });
    await writeFile(join(wt, path), text);
  }
  await saveState(home, savedTasks({ ...initialState(0), localCount: 1 }, [task(1, { worktree: wt })], SLUG_OF));
  const calls: [string, string[]][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, args]);
    return { stdout: '' };
  };
  const server = createServer({ secret: SECRET, home, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, setupBody(repo))).status, 200);
  calls.length = 0;
  return { base, wt, outside: await tempDir(t, 'outside-'), calls, server };
}

const post = async (f: Ops, route: string, body: unknown): Promise<[number, unknown]> => {
  const res = await postJson(`${f.base}${workPath(f.server, 'local:1')}/tree/${route}`, body);
  return [res.status, res.status === 204 ? undefined : await res.json()];
};

test('tree/create makes an empty file or a folder, the folders a name with / adds first; a taken name is 409 and never overwritten (#818)', async (t) => {
  const f = await startOps(t);
  assert.deepEqual(await post(f, 'create', { path: 'docs/new.md', kind: 'file' }), [200, { path: 'docs/new.md' }]);
  assert.equal(await readFile(join(f.wt, 'docs/new.md'), 'utf8'), '');
  assert.deepEqual(await post(f, 'create', { path: 'lib', kind: 'folder' }), [200, { path: 'lib' }]);
  assert.ok((await stat(join(f.wt, 'lib'))).isDirectory());
  assert.deepEqual(await post(f, 'create', { path: 'a/b/c.ts', kind: 'file' }), [200, { path: 'a/b/c.ts' }]);
  assert.ok(await exists(join(f.wt, 'a/b/c.ts')));
  for (const [path, kind] of [['README.md', 'file'], ['docs', 'folder'], ['docs', 'file']] as const) {
    assert.deepEqual(await post(f, 'create', { path, kind }), [409, { error: TAKEN_MESSAGE }], `${kind} ${path}`);
  }
  assert.equal(await readFile(join(f.wt, 'README.md'), 'utf8'), 'readme');
});

test('tree/create refuses a path outside the root, absolute, through .. or a symlink, or under .git, and a malformed body, making nothing (#818)', async (t) => {
  const f = await startOps(t);
  await symlink(f.outside, join(f.wt, 'out'));
  await mkdir(join(f.wt, '.git'));
  const cases: [string, string][] = [['../x.ts', OUTSIDE_MESSAGE], ['src/../../x.ts', OUTSIDE_MESSAGE], ['out/x.ts', OUTSIDE_MESSAGE], [join(f.wt, 'x.ts'), OUTSIDE_MESSAGE], ['.git/x', GIT_MESSAGE], ['.GIT/x', GIT_MESSAGE]];
  for (const [path, error] of cases) assert.deepEqual(await post(f, 'create', { path, kind: 'file' }), [400, { error }], path);
  for (const body of [{}, { path: '', kind: 'file' }, { path: 'x', kind: 'link' }, { path: 3, kind: 'file' }]) {
    assert.deepEqual(await post(f, 'create', body), [400, { error: CREATE_BODY_MESSAGE }], JSON.stringify(body));
  }
  assert.deepEqual([await readdir(f.outside), await exists(join(f.wt, 'x.ts'))], [[], false]);
});

test('tree/rename moves an item to its new name, making the folders the name adds; a taken name is 409, a missing item 404, a folder into itself or a path outside 400 (#818)', async (t) => {
  const f = await startOps(t);
  assert.deepEqual(await post(f, 'rename', { from: 'README.md', to: 'docs/old/README.md' }), [200, { path: 'docs/old/README.md' }]);
  assert.deepEqual([await exists(join(f.wt, 'README.md')), await readFile(join(f.wt, 'docs/old/README.md'), 'utf8')], [false, 'readme']);
  assert.deepEqual(await post(f, 'rename', { from: 'src/a.ts', to: 'docs/guide.md' }), [409, { error: TAKEN_MESSAGE }]);
  assert.deepEqual(await post(f, 'rename', { from: 'nope.md', to: 'x.md' }), [404, { error: MISSING_FILE_MESSAGE }]);
  assert.deepEqual(await post(f, 'rename', { from: 'src', to: 'src/inner/src' }), [400, { error: INTO_ITSELF_MESSAGE }]);
  assert.deepEqual(await post(f, 'rename', { from: 'src/a.ts', to: '../a.ts' }), [400, { error: OUTSIDE_MESSAGE }]);
  assert.deepEqual([await readFile(join(f.wt, 'docs/guide.md'), 'utf8'), await readFile(join(f.wt, 'src/a.ts'), 'utf8')], ['guide', 'a']);
});

test('tree/trash checks every path first, so one refused trashes nothing; then one trash command with each outermost item\'s real path (#818)', async (t) => {
  const f = await startOps(t);
  assert.deepEqual(await post(f, 'trash', { paths: ['README.md', '../x'] }), [400, { error: OUTSIDE_MESSAGE }]);
  assert.deepEqual(await post(f, 'trash', { paths: ['README.md', 'gone.md'] }), [404, { error: MISSING_FILE_MESSAGE }]);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await post(f, 'trash', { paths: ['README.md', 'src', 'src/a.ts'] }), [204, undefined]);
  const real = await realpath(f.wt);
  assert.deepEqual(f.calls, [trashCommand(process.platform, [join(real, 'README.md'), join(real, 'src')])]);
});

test('tree/file writes an untitled buffer to the dialog\'s absolute path and answers it relative with its version; outside the root or under .git is 400, a taken path 409 unless replace, past the editor\'s cap 413 (#818)', async (t) => {
  const f = await startOps(t);
  const real = await realpath(f.wt);
  assert.deepEqual(await post(f, 'file', { path: join(real, 'docs/notes.md'), text: 'n', replace: false }), [200, { path: 'docs/notes.md', version: sha256('n') }]);
  assert.equal(await readFile(join(f.wt, 'docs/notes.md'), 'utf8'), 'n');
  assert.deepEqual(await post(f, 'file', { path: join(real, 'README.md'), text: 'new', replace: false }), [409, { error: TAKEN_MESSAGE }]);
  assert.equal(await readFile(join(f.wt, 'README.md'), 'utf8'), 'readme');
  assert.deepEqual(await post(f, 'file', { path: join(real, 'README.md'), text: 'new', replace: true }), [200, { path: 'README.md', version: sha256('new') }]);
  assert.equal(await readFile(join(f.wt, 'README.md'), 'utf8'), 'new');
  await mkdir(join(f.wt, '.git'));
  assert.deepEqual(await post(f, 'file', { path: join(f.outside, 'x.md'), text: 'x', replace: true }), [400, { error: OUTSIDE_MESSAGE }]);
  assert.deepEqual(await post(f, 'file', { path: join(real, '.git', 'x'), text: 'x', replace: true }), [400, { error: GIT_MESSAGE }]);
  assert.deepEqual(await post(f, 'file', { path: 'docs/rel.md', text: 'x', replace: false }), [400, { error: FILE_BODY_MESSAGE }]);
  assert.deepEqual(await post(f, 'file', { path: join(real, 'big.txt'), text: 'x'.repeat(EDITOR_FILE_MAX + 1), replace: false }), [413, { error: TOO_LARGE_MESSAGE }]);
  assert.deepEqual([await exists(join(f.outside, 'x.md')), await exists(join(f.wt, 'big.txt'))], [false, false]);
});

// A fake volume for renameItem: `names` are the entries on it; a case-insensitive one resolves a name to the entry of any case, as APFS does
function fakeVolume(names: string[], isCaseInsensitive: boolean): { fs: TreeFs; renames: [string, string][]; entries: Set<string> } {
  const entries = new Set(names);
  const renames: [string, string][] = [];
  const found = (path: string): string | undefined => (isCaseInsensitive ? [...entries].find((e) => e.toLowerCase() === path.toLowerCase()) : entries.has(path) ? path : undefined);
  const fs: TreeFs = {
    realpath: async (path) => path,
    stat: async (path) => {
      if (found(path) === undefined && path !== '/root') throw new Error('ENOENT');
      return { isDirectory: () => false };
    },
    sameFile: async (a, b) => found(a) !== undefined && found(a) === found(b),
    mkdirs: async () => undefined,
    mkdir: async () => undefined,
    writeNew: async () => undefined,
    replace: async () => undefined,
    rename: async (from, to) => {
      renames.push([from, to]);
    },
  };
  return { fs, renames, entries };
}

test('renameItem accepts a case-only rename of the same inode (case-insensitive volume) (#818)', async () => {
  const { fs, renames } = fakeVolume(['/root/a.ts'], true);
  assert.equal(await renameItem({ root: '/root', from: 'a.ts', to: 'A.ts' }, fs), 'A.ts');
  assert.deepEqual(renames, [['/root/a.ts', '/root/A.ts']]);
});

test('renameItem answers 409 and renames nothing when a differently-cased name is another file (case-sensitive volume) (#818)', async () => {
  const { fs, renames } = fakeVolume(['/root/a.ts', '/root/A.ts'], false);
  assert.deepEqual(await renameItem({ root: '/root', from: 'a.ts', to: 'A.ts' }, fs), { status: 409, message: TAKEN_MESSAGE });
  assert.deepEqual(renames, []);
});

test('saveNewFile answers 409 with its own words when the path holds a folder, replace or not (#818)', async () => {
  const { fs } = fakeVolume(['/root/docs'], false);
  const isFolder: TreeFs = { ...fs, stat: async (path) => ({ isDirectory: () => path === '/root/docs' }) };
  for (const replace of [false, true]) {
    assert.deepEqual(await saveNewFile({ root: '/root', path: '/root/docs', text: 'x', replace }, isFolder), { status: 409, message: IS_FOLDER_MESSAGE }, `replace ${replace}`);
  }
});
