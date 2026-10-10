import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { freeName, MOVE_BODY_MESSAGE, MOVE_DISK, type MoveFs, moveItems } from '../src/server-move.js';
import { ABSOLUTE_MOVE_MESSAGE, FOLDER_MISSING_MESSAGE, GIT_MESSAGE, MISSING_FILE_MESSAGE, OUTSIDE_MESSAGE } from '../src/tree-paths.js';
import { localActivityId } from '../src/activities.js';
import { saveState } from '../src/state-store.js';
import { worktreePath } from '../src/worktree.js';
import type { Task, Exec, Language, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, CLOSE_TAB_DEFAULTS, SLEEP_NOTICE_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { LOCAL_STAGES, workspacesAt, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';
import { savedTasks, type WithWork, workPath } from './fixtures/work.js';

// The file tree's drop (#594): free names, and a move that crosses volumes, through an injected fs.
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const taken = (names: string[]) => async (name: string): Promise<boolean> => names.includes(name);
const fsError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

test('freeName keeps a free name, else adds " - <suffix>" before the last extension, then a number from 2; a dotfile and a folder have none (#594)', async () => {
  assert.equal(await freeName(taken([]), 'a.ts', 'copy'), 'a.ts');
  assert.equal(await freeName(taken(['a.ts']), 'a.ts', 'copy'), 'a - copy.ts');
  assert.equal(await freeName(taken(['a.ts', 'a - copy.ts', 'a - copy 2.ts']), 'a.ts', 'copy'), 'a - copy 3.ts');
  assert.equal(await freeName(taken(['archive.tar.gz']), 'archive.tar.gz', 'copia'), 'archive.tar - copia.gz');
  assert.equal(await freeName(taken(['.env']), '.env', 'copy'), '.env - copy');
  assert.equal(await freeName(taken(['Makefile']), 'Makefile', 'copy'), 'Makefile - copy');
  assert.equal(await freeName(taken(['lib.v2']), 'lib.v2', 'copy', true), 'lib.v2 - copy');
});

test('a move across volumes (EXDEV) copies each item, then removes the original (#594)', async (t) => {
  const root = await tempDir(t, 'move-');
  await mkdir(join(root, 'sub'));
  await mkdir(join(root, 'folder'));
  await writeFile(join(root, 'a.txt'), 'a');
  await writeFile(join(root, 'folder/b.txt'), 'b');
  const calls: string[] = [];
  const fs: MoveFs = {
    ...MOVE_DISK,
    rename: async () => {
      calls.push('rename');
      throw fsError('EXDEV', 'EXDEV: cross-device link not permitted');
    },
    cp: async (from, to) => {
      calls.push('cp');
      await MOVE_DISK.cp(from, to);
    },
    rm: async (path) => {
      calls.push('rm');
      await MOVE_DISK.rm(path);
    },
  };
  assert.deepEqual(await moveItems({ root, sources: ['a.txt', 'folder'], into: 'sub', copy: false, suffix: 'copy' }, fs), { moved: ['sub/a.txt', 'sub/folder'], from: ['a.txt', 'folder'] });
  assert.deepEqual(calls, ['rename', 'cp', 'rm', 'rename', 'cp', 'rm']);
  assert.equal(await readFile(join(root, 'sub/a.txt'), 'utf8'), 'a');
  assert.equal(await readFile(join(root, 'sub/folder/b.txt'), 'utf8'), 'b');
  assert.deepEqual([await exists(join(root, 'a.txt')), await exists(join(root, 'folder'))], [false, false]);
});

test('any other rename failure rejects with its own words and copies nothing (#594)', async (t) => {
  const root = await tempDir(t, 'move-');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'a.txt'), 'a');
  const fs: MoveFs = { ...MOVE_DISK, rename: async () => { throw fsError('EACCES', 'EACCES: permission denied'); } };
  await assert.rejects(moveItems({ root, sources: ['a.txt'], into: 'sub', copy: false, suffix: 'copy' }, fs), /EACCES: permission denied/);
  assert.deepEqual([await exists(join(root, 'a.txt')), await exists(join(root, 'sub/a.txt'))], [true, false]);
});

// POST /activities/:id/tree/move end to end (#594): local activities saved in state.json, their worktree a real temp folder, no git run.
const FILES: Record<string, string> = {
  'README.md': 'readme', 'src/a.ts': 'a', 'src/deep/b.ts': 'b', 'src/lib.v2/c.ts': 'c', '.env': 'env', 'docs/guide.md': 'guide',
};
const task = (n: number, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive', ...extra,
});
// The slug a saved activity carries (#629): the one the worktree paths below name
const SLUG_OF = (c: Task): string => `hive-${c.item.id.replace('HIVE-', '')}-task`;
const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const setupBody = (repo: string): SettingsBody => ({
  prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], stages: LOCAL_STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS,
  shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, ...CLOSE_TAB_DEFAULTS, ...SLEEP_NOTICE_DEFAULTS, defaultAgent: 'claude',
  theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
});
const noGit: Exec = async () => ({ stdout: '' });

interface Moving { base: string; wt: string; repo: string; outside: string; server: HiveServer }

// Activity 1 has its worktree on disk with FILES; 2 has none; 3's is gone. `outside` is a folder out of the worktree: Finder's side.
async function startMove(t: TestContext, systemLanguage?: Language): Promise<Moving> {
  const { home, repo } = await tempHive(t);
  const wt = worktreePath(repo, 'hive-1-task');
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(join(wt, path, '..'), { recursive: true });
    await writeFile(join(wt, path), text);
  }
  const tasks = [task(1, { worktree: wt }), task(2), task(3, { worktree: worktreePath(repo, 'hive-3-task'), worktreeGone: true })];
  await saveState(home, savedTasks({ ...initialState(0), localCount: tasks.length }, tasks, SLUG_OF)); // #629: each worktree on its activity
  const server = createServer({ secret: SECRET, home, exec: noGit, systemLanguage });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, setupBody(repo))).status, 200);
  return { base, wt, repo, outside: await tempDir(t, 'finder-'), server };
}

const move = async ({ base, server }: Pick<Moving, 'base' | 'server'>, body: unknown, id = 'local:1'): Promise<[number, unknown]> => {
  const res = await postJson(`${base}${workPath(server, id)}/tree/move`, body);
  const { from: _from, ...answer } = (await res.json()) as Record<string, unknown>; // the moved paths alone: `from` has a test of its own (#818)
  return [res.status, answer];
};
const drop = (sources: string[], into: string, copy = false) => ({ sources, into, copy });

// #629: local:2 never had a worktree, so it has no activity: 404, as an unknown one
test('POST /activities/:id/tree/move answers 404 for an unknown activity and 409 for one with no worktree on disk (#594)', async (t) => {
  const f = await startMove(t);
  for (const [id, status] of [['local:9', 404], ['local:2', 404], ['local:3', 409]] as const) {
    assert.equal((await move(f, drop(['README.md'], ''), id))[0], status, id);
  }
});

test('a malformed body answers 400 and moves nothing (#594)', async (t) => {
  const f = await startMove(t);
  const bodies = [{}, drop([], ''), drop([''], ''), { sources: ['README.md', 3], into: '', copy: false }, { sources: ['README.md'], into: 1, copy: false }, { sources: ['README.md'], into: 'docs', copy: 'yes' }];
  for (const body of bodies) assert.deepEqual(await move(f, body), [400, { error: MOVE_BODY_MESSAGE }], JSON.stringify(body));
  assert.ok(await exists(join(f.wt, 'README.md')));
});

test('an into that is absolute, leads out through .. or a symlink, or is no folder answers 400 and moves nothing (#594)', async (t) => {
  const f = await startMove(t);
  await symlink(f.outside, join(f.wt, 'out'));
  const cases = [['..', OUTSIDE_MESSAGE], ['src/../..', OUTSIDE_MESSAGE], [f.wt, OUTSIDE_MESSAGE], ['out', OUTSIDE_MESSAGE], ['README.md', FOLDER_MISSING_MESSAGE], ['nope', FOLDER_MISSING_MESSAGE]] as const;
  for (const [into, error] of cases) assert.deepEqual(await move(f, drop(['README.md'], into)), [400, { error }], into);
  assert.ok(await exists(join(f.wt, 'README.md')));
  assert.deepEqual(await readdir(f.outside), []);
});

test('a relative source that leads out answers 400, a missing one 404, and a refused source moves none of the others (#594)', async (t) => {
  const f = await startMove(t);
  await writeFile(join(f.outside, 'secret.txt'), 's');
  await symlink(f.outside, join(f.wt, 'out'));
  for (const source of ['../x', 'src/../../x', 'out/secret.txt']) {
    assert.deepEqual(await move(f, drop([source], 'docs')), [400, { error: OUTSIDE_MESSAGE }], source);
  }
  assert.deepEqual(await move(f, drop(['README.md', 'gone.txt'], 'docs')), [404, { error: MISSING_FILE_MESSAGE }]);
  assert.deepEqual([await exists(join(f.wt, 'README.md')), await exists(join(f.outside, 'secret.txt'))], [true, true]);
});

test('a file and a folder move; with copy both stay, a folder copied whole; each new path answered in order (#594)', async (t) => {
  const f = await startMove(t);
  assert.deepEqual(await move(f, drop(['README.md'], 'docs')), [200, { moved: ['docs/README.md'] }]);
  assert.equal(await readFile(join(f.wt, 'docs/README.md'), 'utf8'), 'readme');
  assert.equal(await exists(join(f.wt, 'README.md')), false);
  assert.deepEqual(await move(f, drop(['src/deep'], '')), [200, { moved: ['deep'] }]);
  assert.equal(await readFile(join(f.wt, 'deep/b.ts'), 'utf8'), 'b');
  assert.equal(await exists(join(f.wt, 'src/deep')), false);
  assert.deepEqual(await move(f, drop(['src', 'docs/guide.md'], 'deep', true)), [200, { moved: ['deep/src', 'deep/guide.md'] }]);
  for (const path of ['src/a.ts', 'deep/src/a.ts', 'deep/src/lib.v2/c.ts', 'docs/guide.md', 'deep/guide.md']) assert.ok(await exists(join(f.wt, path)), path);
});

test('a name taken keeps both: " - copy", then " - copy 2"; a dotfile and a dotted folder keep their name whole (#594)', async (t) => {
  const f = await startMove(t);
  await writeFile(join(f.wt, 'docs/a.ts'), 'old');
  await writeFile(join(f.wt, 'docs/.env'), 'old');
  await mkdir(join(f.wt, 'docs/lib.v2'));
  assert.deepEqual(await move(f, drop(['src/a.ts'], 'docs', true)), [200, { moved: ['docs/a - copy.ts'] }]);
  assert.deepEqual(await move(f, drop(['src/a.ts'], 'docs', true)), [200, { moved: ['docs/a - copy 2.ts'] }]);
  assert.deepEqual(await move(f, drop(['.env'], 'docs')), [200, { moved: ['docs/.env - copy'] }]);
  assert.deepEqual(await move(f, drop(['src/lib.v2'], 'docs')), [200, { moved: ['docs/lib.v2 - copy'] }]);
  assert.equal(await readFile(join(f.wt, 'docs/a.ts'), 'utf8'), 'old');
});

test('the suffix follows the Hive\'s language: " - copia" when it is pt (#594)', async (t) => {
  const f = await startMove(t, 'pt');
  await writeFile(join(f.wt, 'docs/a.ts'), 'old');
  assert.deepEqual(await move(f, drop(['src/a.ts'], 'docs', true)), [200, { moved: ['docs/a - copia.ts'] }]);
});

test('an item onto its own folder, and a folder into itself or below it, are skipped (#594)', async (t) => {
  const f = await startMove(t);
  assert.deepEqual(await move(f, drop(['README.md'], '')), [200, { moved: [] }]);
  assert.deepEqual(await move(f, drop(['src'], 'src')), [200, { moved: [] }]);
  assert.deepEqual(await move(f, drop(['src'], 'src/deep')), [200, { moved: [] }]);
  assert.deepEqual(await move(f, drop(['src/a.ts', 'README.md'], 'src')), [200, { moved: ['src/README.md'] }]);
  assert.ok(await exists(join(f.wt, 'src/deep/b.ts')));
});

test('an absolute source, a file dragged from Finder, is copied in and stays where it was (#594)', async (t) => {
  const f = await startMove(t);
  await writeFile(join(f.outside, 'notes.txt'), 'n');
  await writeFile(join(f.outside, 'plan.md'), 'p');
  assert.deepEqual(await move(f, drop([join(f.outside, 'notes.txt')], 'docs', true)), [200, { moved: ['docs/notes.txt'] }]);
  assert.deepEqual(await move(f, drop([join(f.outside, 'plan.md')], '', true)), [200, { moved: ['plan.md'] }]);
  assert.deepEqual((await readdir(f.outside)).sort(), ['notes.txt', 'plan.md']);
  assert.equal(await readFile(join(f.wt, 'docs/notes.txt'), 'utf8'), 'n');
});

test('an absolute source without copy answers 400 and removes nothing, so the route never takes a file out of the tree\'s root (#594)', async (t) => {
  const f = await startMove(t);
  await writeFile(join(f.outside, 'notes.txt'), 'n');
  const inside = join(f.wt, 'README.md');
  for (const source of [join(f.outside, 'notes.txt'), inside]) {
    assert.deepEqual(await move(f, drop([source], 'docs')), [400, { error: ABSOLUTE_MOVE_MESSAGE }], source);
  }
  assert.deepEqual(await readdir(f.outside), ['notes.txt']);
  assert.ok(await exists(inside));
  assert.equal(await exists(join(f.wt, 'docs/notes.txt')), false);
});

test('a duplicated source, or one nested under another source, is moved once instead of failing after a partial move (#594)', async (t) => {
  const f = await startMove(t);
  assert.deepEqual(await move(f, drop(['README.md', 'README.md'], 'docs')), [200, { moved: ['docs/README.md'] }]);
  assert.deepEqual(await move(f, drop(['src/a.ts', 'src', 'src/deep/b.ts'], 'docs')), [200, { moved: ['docs/src'] }]);
  assert.ok(await exists(join(f.wt, 'docs/src/a.ts')));
});

test('a source or an into that starts at .git answers 400 and moves nothing (#594)', async (t) => {
  const f = await startMove(t);
  await mkdir(join(f.wt, '.git/hooks'), { recursive: true });
  await symlink('.git', join(f.wt, 'git-link'));
  const bodies = [
    drop(['.git'], 'docs'), drop(['.git/hooks'], 'docs'), drop(['README.md'], '.git'), drop(['README.md'], '.git/hooks'),
    drop(['README.md'], '.GIT'), drop(['.Git/hooks'], 'docs'), drop(['README.md'], 'git-link'), drop(['git-link/hooks'], 'docs'),
  ];
  for (const body of bodies) {
    assert.deepEqual(await move(f, body), [400, { error: GIT_MESSAGE }], JSON.stringify(body));
  }
  assert.ok(await exists(join(f.wt, '.git/hooks')));
  assert.ok(await exists(join(f.wt, 'README.md')));
});

test('a copy that fails across volumes removes the half-copied destination; a source that will not go says the item was copied (#594)', async (t) => {
  const root = await tempDir(t, 'move-');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'a.txt'), 'a');
  const exdev = async (): Promise<void> => { throw fsError('EXDEV', 'EXDEV: cross-device link not permitted'); };
  const removed: string[] = [];
  const failingCp: MoveFs = {
    ...MOVE_DISK, rename: exdev,
    cp: async () => { throw new Error('ENOSPC: no space left'); },
    rm: async (path) => { removed.push(path); },
  };
  const job = { root, sources: ['a.txt'], into: 'sub', copy: false, suffix: 'copy' };
  await assert.rejects(moveItems(job, failingCp), /ENOSPC: no space left/);
  assert.equal(removed.length, 1);
  assert.match(removed[0] as string, /sub[\\/]a\.txt$/);
  const failingRm: MoveFs = { ...MOVE_DISK, rename: exdev, rm: async () => { throw new Error('EACCES: permission denied'); } };
  await assert.rejects(moveItems(job, failingRm), /copied.*original.*could not be removed.*EACCES: permission denied/);
});

// #633: the local activity's root is the workspace's checkout, the git repo tempHive made, with its own .git
test('a move on a workspace\'s local activity moves inside the checkout; a source under .git still answers 400 (#633)', async (t) => {
  const f = await startMove(t);
  await mkdir(join(f.repo, 'docs'));
  await writeFile(join(f.repo, 'notes.md'), 'n');
  const local = (body: unknown): Promise<Response> => postJson(`${f.base}/activities/${encodeURIComponent(localActivityId('hive'))}/tree/move`, body);
  const moved = await local(drop(['notes.md'], 'docs'));
  assert.deepEqual([moved.status, await moved.json()], [200, { moved: ['docs/notes.md'], from: ['notes.md'] }]);
  assert.equal(await readFile(join(f.repo, 'docs/notes.md'), 'utf8'), 'n');
  const git = await local(drop(['.git/config'], 'docs'));
  assert.deepEqual([git.status, await git.json()], [400, { error: GIT_MESSAGE }]);
  assert.ok(await exists(join(f.repo, '.git/config')));
});

test('a drop answers each moved item\'s path and the path it came from, both relative, so open tabs can follow a move (#818)', async (t) => {
  const f = await startMove(t);
  const res = await postJson(`${f.base}${workPath(f.server, 'local:1')}/tree/move`, drop(['README.md', 'src/a.ts'], 'docs'));
  assert.deepEqual([res.status, await res.json()], [200, { moved: ['docs/README.md', 'docs/a.ts'], from: ['README.md', 'src/a.ts'] }]);
});

test('a copy onto its own folder lands under a free name, as Finder\'s duplicate; a move there stays a no-op, and a folder copied into itself is still skipped (#818)', async (t) => {
  const f = await startMove(t);
  assert.deepEqual(await move(f, drop(['README.md'], '', true)), [200, { moved: ['README - copy.md'] }]);
  assert.deepEqual(await move(f, drop(['src/a.ts'], 'src', true)), [200, { moved: ['src/a - copy.ts'] }]);
  assert.deepEqual(await move(f, drop(['src'], '', true)), [200, { moved: ['src - copy'] }]);
  assert.equal(await readFile(join(f.wt, 'src - copy/deep/b.ts'), 'utf8'), 'b');
  assert.deepEqual(await move(f, drop(['README.md'], '')), [200, { moved: [] }], 'a move onto its own folder');
  assert.deepEqual(await move(f, drop(['src'], 'src', true)), [200, { moved: [] }], 'cp would recurse into its own output');
  assert.deepEqual(await move(f, drop(['src'], 'src/deep', true)), [200, { moved: [] }]);
});
