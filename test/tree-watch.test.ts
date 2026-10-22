import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COALESCE_MS, createTreeWatch, FALLBACK_MS, gitDirOf, LEASE_TTL_MS, MAX_LEASES, MIN_PUSH_MS, pathKind, PATHS_CAP, TooManyLeasesError, type WatchFn } from '../src/tree-watch.js';
import type { Exec, TreeChange } from '../src/types.js';
import { tempDir } from './temp-dir.js';

test('pathKind drops a .git segment at any depth and in any case, keeps the root\'s own .git/index and .git/HEAD as git, and drops .hive/worktrees only under a checkout (#502)', () => {
  assert.equal(pathKind('src/a.ts', false), 'path');
  assert.equal(pathKind('.git/index', false), 'git');
  assert.equal(pathKind('.git/HEAD', true), 'git');
  for (const path of ['.git', '.git/objects/ab/cd', '.git/index.lock', '.git/refs/heads/main', '.GIT/config', 'docs/.git/index', 'docs/.git/HEAD']) assert.equal(pathKind(path, true), 'drop', path);
  assert.equal(pathKind('.hive/worktrees', true), 'drop');
  assert.equal(pathKind('.hive/worktrees/hive-2-x/src/a.ts', true), 'drop');
  assert.equal(pathKind('.hive/worktrees/hive-2-x/src/a.ts', false), 'path', 'a task worktree holds no other activity');
  assert.equal(pathKind('.hive/notes.md', true), 'path');
});

test('gitDirOf reads the gitdir: line of a worktree\'s .git file, a relative one against the folder holding it; other text names none (#502)', () => {
  assert.equal(gitDirOf('gitdir: /repo/.git/worktrees/hive-1\n', '/wt'), '/repo/.git/worktrees/hive-1');
  assert.equal(gitDirOf('gitdir: ../repo/.git/worktrees/docs\n', '/wt/docs'), '/wt/repo/.git/worktrees/docs');
  assert.equal(gitDirOf('not a git file', '/wt'), undefined);
});

interface FakeWatcher { path: string; recursive: boolean; emit(eventType: string, filename: string | null): void; fail(err: Error): void; isClosed: boolean }

// fs.watch without a file system: a test emits each event and error itself
function fakeFs(): { watch: WatchFn; watchers: FakeWatcher[]; open(recursive?: boolean): FakeWatcher[] } {
  const watchers: FakeWatcher[] = [];
  const watch: WatchFn = (path, { recursive }, listener) => {
    let onError: (err: Error) => void = () => undefined;
    const watcher: FakeWatcher = { path, recursive, emit: listener, fail: (err) => onError(err), isClosed: false };
    watchers.push(watcher);
    return { close: () => { watcher.isClosed = true; }, on: (_event, listener) => { onError = listener; } };
  };
  return { watch, watchers, open: (recursive) => watchers.filter((w) => !w.isClosed && (recursive === undefined || w.recursive === recursive)) };
}

const NO_GIT: Exec = async () => { throw new Error('a watching root runs no git'); };

function setup(t: TestContext, { exec = NO_GIT, watch }: { exec?: Exec; watch?: WatchFn } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const fs = fakeFs();
  const changes: TreeChange[] = [];
  const warnings: string[] = [];
  const tree = createTreeWatch({ log: { warn: (line) => warnings.push(line), debug: () => undefined }, notify: (change) => changes.push(change), exec, watch: watch ?? fs.watch, now: () => Date.now() });
  t.after(() => tree.close());
  return { tree, fs, changes, warnings, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('two leases on one root share one watcher, which closes once both are released (#502)', async (t) => {
  const { tree, fs } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false);
  await tree.lease('a-2', '/wt', 'L2', false);
  assert.deepEqual(fs.open(true).map((w) => w.path), ['/wt']);
  tree.release('a-1', 'L1');
  assert.equal(fs.open(true).length, 1);
  tree.release('a-2', 'L2');
  tree.release('a-2', 'L2'); // an unknown lease is a no-op
  assert.deepEqual(fs.open(), []);
});

test('a lease not renewed within LEASE_TTL_MS expires and its root\'s watcher closes; a renewal starts the wait again (#502)', async (t) => {
  const { tree, fs, tick } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false);
  tick(LEASE_TTL_MS - 1);
  await tree.lease('a-1', '/wt', 'L1', false);
  tick(LEASE_TTL_MS - 1);
  assert.equal(fs.open(true).length, 1, 'renewed');
  assert.equal(fs.watchers.length, 1, 'a renewal opens no second watcher');
  tick(1);
  assert.deepEqual(fs.open(), []);
});

test('a burst is one push COALESCE_MS after its first change, paths deduplicated and sorted; a burst inside the next second waits for that second to end (#502)', async (t) => {
  const { tree, fs, changes, tick } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false);
  const [root] = fs.open(true);
  for (const path of ['src/b.ts', 'src/a.ts', 'src/b.ts']) root.emit('change', path);
  tick(COALESCE_MS - 1);
  assert.deepEqual(changes, []);
  tick(1); // t = 250 ms
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'a-1', paths: ['src/a.ts', 'src/b.ts'] }]);
  tick(50); // t = 300 ms
  root.emit('rename', 'src/c.ts');
  tick(MIN_PUSH_MS - 51); // t = 1249 ms: the second since the push at 250 ms is not over
  assert.equal(changes.length, 1);
  tick(1);
  assert.deepEqual(changes.at(-1), { type: 'tree', activityId: 'a-1', paths: ['src/c.ts'] });
});

test('each push goes once to every activity leased on the root, sorted, however many leases each holds; another root\'s activity hears nothing (#502)', async (t) => {
  const { tree, fs, changes, tick } = setup(t);
  await tree.lease('a-2', '/wt', 'L1', false);
  await tree.lease('a-1', '/wt', 'L2', false);
  await tree.lease('a-1', '/wt', 'L3', false); // a second window on a-1
  await tree.lease('a-3', '/other', 'L4', false);
  fs.open(true).find((w) => w.path === '/wt')?.emit('change', 'a.txt');
  tick(COALESCE_MS);
  assert.deepEqual(changes.map((change) => change.activityId), ['a-1', 'a-2']);
});

test('the main .git\'s paths and, under a checkout, .hive/worktrees are dropped, and a push left with no path is not sent; the root\'s .git/index goes out with no paths (#502)', async (t) => {
  const { tree, fs, changes, tick } = setup(t);
  await tree.lease('local:hive', '/repo', 'L1', true);
  const [root] = fs.open(true);
  for (const path of ['.git/objects/ab/cd', '.git/refs/heads/main', '.git/logs/HEAD', 'docs/.git/index', '.hive/worktrees/hive-2-x/src/a.ts']) root.emit('change', path);
  tick(MIN_PUSH_MS * 2);
  assert.deepEqual(changes, []);
  root.emit('change', '.git/index');
  tick(COALESCE_MS);
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'local:hive' }]);
});

test('a change with no file name, or more than PATHS_CAP paths, goes out with no paths; PATHS_CAP paths still go out (#502)', async (t) => {
  const { tree, fs, changes, tick } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false);
  const [root] = fs.open(true);
  root.emit('rename', null);
  tick(COALESCE_MS);
  assert.deepEqual(changes.at(-1), { type: 'tree', activityId: 'a-1' });
  tick(MIN_PUSH_MS);
  for (let i = 0; i <= PATHS_CAP; i++) root.emit('change', `gen/${i}.ts`);
  tick(COALESCE_MS);
  assert.deepEqual(changes.at(-1), { type: 'tree', activityId: 'a-1' });
  tick(MIN_PUSH_MS);
  for (let i = 0; i < PATHS_CAP; i++) root.emit('change', `gen/${String(i).padStart(3, '0')}.ts`);
  tick(COALESCE_MS);
  assert.equal(changes.at(-1)?.paths?.length, PATHS_CAP);
});

test('close() closes every watcher and timer: a pending push and a lease\'s expiry never fire after it (#502)', async (t) => {
  const { tree, fs, changes, tick } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false);
  await tree.lease('a-2', '/other', 'L2', false);
  fs.open(true)[0].emit('change', 'a.txt');
  tree.close();
  tick(LEASE_TTL_MS);
  assert.deepEqual([fs.open(), changes], [[], []]);
});

// A task's worktree: its .git is a file naming its gitdir (#502 reads it with fs, no git)
async function worktreeRoot(t: TestContext): Promise<{ root: string; gitdir: string }> {
  const root = await tempDir(t, 'wt-');
  const gitdir = await tempDir(t, 'gitdir-');
  await writeFile(join(root, '.git'), `gitdir: ${gitdir}\n`);
  return { root, gitdir };
}

test('a worktree\'s gitdir is watched, not recursively: its index and HEAD go out with no paths, its other files are dropped, and it closes with the root (#502)', async (t) => {
  const { root, gitdir } = await worktreeRoot(t);
  const { tree, fs, changes, tick } = setup(t);
  await tree.lease('a-1', root, 'L1', false);
  const git = fs.open(false).find((w) => w.path === gitdir);
  assert.ok(git, 'the gitdir is watched');
  for (const name of ['index.lock', 'HEAD.lock', 'ORIG_HEAD', 'FETCH_HEAD', 'logs']) git.emit('rename', name);
  tick(MIN_PUSH_MS);
  assert.deepEqual(changes, []);
  git.emit('rename', 'index'); // git renames index.lock over index
  tick(COALESCE_MS);
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'a-1' }]);
  tick(MIN_PUSH_MS);
  git.emit('rename', 'HEAD');
  tick(COALESCE_MS);
  assert.equal(changes.length, 2);
  tree.release('a-1', 'L1');
  assert.deepEqual(fs.open(), []);
});

test('watchNested watches a leased root\'s nested repository\'s gitdir, its own .git folder or the one its .git file names; its index goes out as paths [repo]; once per repo; ignored without a lease; closed with the root (#502, #1)', async (t) => {
  const { root, gitdir } = await worktreeRoot(t);
  const docsGitdir = await tempDir(t, 'docs-gitdir-');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', '.git'), `gitdir: ${docsGitdir}\n`);
  await mkdir(join(root, 'vendor', 'lib', '.git'), { recursive: true });
  const { tree, fs, changes, tick } = setup(t);
  await tree.watchNested(root, 'docs');
  assert.equal(fs.watchers.length, 0, 'no lease: nothing is watched');
  await tree.lease('a-1', root, 'L1', false);
  await tree.watchNested(root, 'docs');
  await tree.watchNested(root, 'docs');
  await tree.watchNested(root, 'vendor/lib');
  assert.deepEqual(fs.open(false).map((w) => w.path).sort(), [docsGitdir, gitdir, join(root, 'vendor', 'lib', '.git')].sort());
  fs.open(false).find((w) => w.path === docsGitdir)?.emit('rename', 'index');
  tick(COALESCE_MS);
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'a-1', paths: ['docs'] }]);
  tree.release('a-1', 'L1');
  assert.deepEqual(fs.open(), []);
});

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve)); // a poll's git answer lands on the next turn
const ENOSPC = Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });

test('a watch that throws switches its root to one git status every FALLBACK_MS, logged once; a tick matching the last output pushes nothing, one that differs pushes once per activity with no paths; close() stops it (#502)', async (t) => {
  const outputs = ['# branch.head main\0', '# branch.head main\0', '# branch.head other\0'];
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => { calls.push(args); return { stdout: outputs[Math.min(calls.length, outputs.length) - 1] }; };
  const { tree, changes, warnings, tick } = setup(t, { exec, watch: () => { throw ENOSPC; } });
  await tree.lease('a-1', '/wt', 'L1', false);
  await tree.lease('a-2', '/wt', 'L2', false); // one poll per root, shared
  await settle();
  assert.deepEqual(calls, [['--no-optional-locks', '-C', '/wt', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignored=matching']]);
  tick(FALLBACK_MS);
  await settle();
  assert.deepEqual(changes, [], 'the same output: nothing changed');
  tick(FALLBACK_MS);
  await settle();
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'a-1' }, { type: 'tree', activityId: 'a-2' }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\/wt.*ENOSPC/);
  await tree.watchNested('/wt', 'docs'); // the fallback watches no nested repository
  tree.close();
  tick(FALLBACK_MS * 3);
  await settle();
  assert.equal(calls.length, 3, 'close() stops the poll');
});

test('a watcher\'s error closes the root\'s watchers and falls back to the poll, logged once per root however often it fails (#502)', async (t) => {
  const { root } = await worktreeRoot(t);
  const { tree, fs, warnings } = setup(t, { exec: async () => ({ stdout: '' }) });
  await tree.lease('a-1', root, 'L1', false);
  fs.open(true)[0].fail(new Error('EMFILE: too many open files'));
  assert.deepEqual(fs.open(), [], 'the tree\'s and the gitdir\'s watchers are closed');
  tree.release('a-1', 'L1');
  await tree.lease('a-1', root, 'L2', false); // a fresh watcher on the same root
  fs.open(true)[0].fail(new Error('EMFILE: too many open files'));
  assert.equal(warnings.length, 1);
});

test('release removes only a lease of the activity that holds it: another activity\'s id, or an unknown one, is a no-op (#502)', async (t) => {
  const { tree, fs } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false);
  tree.release('a-2', 'L1');
  tree.release('a-1', 'never');
  assert.equal(fs.open(true).length, 1, 'still leased');
  tree.release('a-1', 'L1');
  assert.deepEqual(fs.open(), []);
});

test('at MAX_LEASES leases a new id is refused with TooManyLeasesError, a renewal of a held id always succeeds, and a release makes room (#502)', async (t) => {
  const { tree, fs } = setup(t);
  for (let i = 0; i < MAX_LEASES; i++) await tree.lease('a-1', '/wt', `L${i}`, false);
  await assert.rejects(tree.lease('a-1', '/wt', 'extra', false), TooManyLeasesError);
  await tree.lease('a-1', '/wt', 'L0', false);
  assert.equal(fs.watchers.length, 1);
  tree.release('a-1', 'L0');
  await tree.lease('a-1', '/wt', 'extra', false);
});

test('the push spacing runs on a monotonic clock: the wall clock stepping back an hour delays no push (#502)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const fs = fakeFs();
  const changes: TreeChange[] = [];
  const tree = createTreeWatch({ log: { warn: () => undefined, debug: () => undefined }, notify: (change) => changes.push(change), exec: NO_GIT, watch: fs.watch });
  t.after(() => tree.close());
  t.mock.timers.tick(3_600_000);
  await tree.lease('a-1', '/wt', 'L1', false);
  const [root] = fs.open(true);
  root.emit('change', 'a.txt');
  t.mock.timers.tick(COALESCE_MS);
  assert.equal(changes.length, 1);
  t.mock.timers.setTime(0);
  root.emit('change', 'b.txt');
  t.mock.timers.tick(MIN_PUSH_MS);
  assert.equal(changes.length, 2);
});

test('a pending batch is pushed, with no paths, when the root falls back to the poll (#502)', async (t) => {
  const { tree, fs, changes } = setup(t, { exec: async () => ({ stdout: '' }) });
  await tree.lease('a-1', '/wt', 'L1', false);
  const [root] = fs.open(true);
  root.emit('change', 'a.txt');
  root.fail(new Error('EMFILE: too many open files'));
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'a-1' }]);
});

test('a checkout whose .git is a file (a worktree used as the checkout) watches the gitdir it names; one with a .git folder watches no more than the recursive watch (#502)', async (t) => {
  const { root, gitdir } = await worktreeRoot(t);
  const { tree, fs, changes, tick } = setup(t);
  await tree.lease('local:hive', root, 'L1', true);
  const git = fs.open(false).find((w) => w.path === gitdir);
  assert.ok(git, 'the gitdir is watched');
  git.emit('rename', 'index');
  tick(COALESCE_MS);
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'local:hive' }]);
  const plain = await tempDir(t, 'plain-');
  await mkdir(join(plain, '.git'));
  await tree.lease('local:other', plain, 'L2', true);
  assert.deepEqual(fs.open(false), [git], 'a .git folder is inside the recursive watch');
});
