import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { type Machine, MachineError, toMachineError } from '../src/machine.js';
import { COALESCE_MS, createTreeWatch, FALLBACK_MS, gitDirOf, LEASE_TTL_MS, MAX_LEASES, MIN_PUSH_MS, pathKind, PATHS_CAP, TooManyLeasesError } from '../src/tree-watch.js';
import { GITDIR_FILE_MAX } from '../src/tree-watch-root.js';
import type { Exec, TreeChange } from '../src/types.js';
import { fakeMachine } from './fakes.js';
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

test('gitDirOf reads the gitdir: line of a worktree\'s .git file, a relative one against the folder holding it, with the machine\'s paths; other text names none (#502, #935)', () => {
  assert.equal(gitDirOf('gitdir: /repo/.git/worktrees/hive-1\n', '/wt', posix), '/repo/.git/worktrees/hive-1');
  assert.equal(gitDirOf('gitdir: ../repo/.git/worktrees/docs\n', '/wt/docs', posix), '/wt/repo/.git/worktrees/docs');
  assert.equal(gitDirOf('gitdir: C:/repo/.git/worktrees/hive-1\n', 'C:\\wt', win32), 'C:\\repo\\.git\\worktrees\\hive-1');
  assert.equal(gitDirOf('not a git file', '/wt', posix), undefined);
});

interface FakeWatcher { path: string; recursive: boolean; emit(filename: string | null): void; fail(err: Error): void; isClosed: boolean }

// A machine's watch with no file system (#935): a test emits each event and error itself. The rest of the machine is fakes.ts', the real disk
function fakeFs(): { watch: Machine['watch']; watchers: FakeWatcher[]; open(recursive?: boolean): FakeWatcher[] } {
  const watchers: FakeWatcher[] = [];
  const watch: Machine['watch'] = (path, { recursive }, onEvent, onError) => {
    const watcher: FakeWatcher = { path, recursive, emit: onEvent, fail: (err) => onError(toMachineError(err)), isClosed: false };
    watchers.push(watcher);
    return { close: () => { watcher.isClosed = true; } };
  };
  return { watch, watchers, open: (recursive) => watchers.filter((w) => !w.isClosed && (recursive === undefined || w.recursive === recursive)) };
}

const NO_GIT: Exec = async () => { throw new Error('a watching root runs no git'); };

function setup(t: TestContext, { exec = NO_GIT, watch }: { exec?: Exec; watch?: Machine['watch'] } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const fs = fakeFs();
  const changes: TreeChange[] = [];
  const warnings: string[] = [];
  const machine = fakeMachine({ exec, watch: watch ?? fs.watch });
  const tree = createTreeWatch({ log: { warn: (line) => warnings.push(line), debug: () => undefined }, notify: (change) => changes.push(change), now: () => Date.now() });
  t.after(() => tree.close());
  return { tree, fs, machine, changes, warnings, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('two leases on one root share one watcher, which closes once both are released (#502)', async (t) => {
  const { tree, fs, machine } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false, machine);
  await tree.lease('a-2', '/wt', 'L2', false, machine);
  assert.deepEqual(fs.open(true).map((w) => w.path), ['/wt']);
  tree.release('a-1', 'L1');
  assert.equal(fs.open(true).length, 1);
  tree.release('a-2', 'L2');
  tree.release('a-2', 'L2'); // an unknown lease is a no-op
  assert.deepEqual(fs.open(), []);
});

test('a lease not renewed within LEASE_TTL_MS expires and its root\'s watcher closes; a renewal starts the wait again (#502)', async (t) => {
  const { tree, fs, tick, machine } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false, machine);
  tick(LEASE_TTL_MS - 1);
  await tree.lease('a-1', '/wt', 'L1', false, machine);
  tick(LEASE_TTL_MS - 1);
  assert.equal(fs.open(true).length, 1, 'renewed');
  assert.equal(fs.watchers.length, 1, 'a renewal opens no second watcher');
  tick(1);
  assert.deepEqual(fs.open(), []);
});

test('a burst is one push COALESCE_MS after its first change, paths deduplicated and sorted; a burst inside the next second waits for that second to end (#502)', async (t) => {
  const { tree, fs, changes, tick, machine } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false, machine);
  const [root] = fs.open(true);
  for (const path of ['src/b.ts', 'src/a.ts', 'src/b.ts']) root.emit(path);
  tick(COALESCE_MS - 1);
  assert.deepEqual(changes, []);
  tick(1); // t = 250 ms
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'a-1', paths: ['src/a.ts', 'src/b.ts'] }]);
  tick(50); // t = 300 ms
  root.emit('src/c.ts');
  tick(MIN_PUSH_MS - 51); // t = 1249 ms: the second since the push at 250 ms is not over
  assert.equal(changes.length, 1);
  tick(1);
  assert.deepEqual(changes.at(-1), { type: 'tree', activityId: 'a-1', paths: ['src/c.ts'] });
});

test('each push goes once to every activity leased on the root, sorted, however many leases each holds; another root\'s activity hears nothing (#502)', async (t) => {
  const { tree, fs, changes, tick, machine } = setup(t);
  await tree.lease('a-2', '/wt', 'L1', false, machine);
  await tree.lease('a-1', '/wt', 'L2', false, machine);
  await tree.lease('a-1', '/wt', 'L3', false, machine); // a second window on a-1
  await tree.lease('a-3', '/other', 'L4', false, machine);
  fs.open(true).find((w) => w.path === '/wt')?.emit('a.txt');
  tick(COALESCE_MS);
  assert.deepEqual(changes.map((change) => change.activityId), ['a-1', 'a-2']);
});

test('the main .git\'s paths and, under a checkout, .hive/worktrees are dropped, and a push left with no path is not sent; the root\'s .git/index goes out with no paths (#502)', async (t) => {
  const { tree, fs, changes, tick, machine } = setup(t);
  await tree.lease('local:hive', '/repo', 'L1', true, machine);
  const [root] = fs.open(true);
  for (const path of ['.git/objects/ab/cd', '.git/refs/heads/main', '.git/logs/HEAD', 'docs/.git/index', '.hive/worktrees/hive-2-x/src/a.ts']) root.emit(path);
  tick(MIN_PUSH_MS * 2);
  assert.deepEqual(changes, []);
  root.emit('.git/index');
  tick(COALESCE_MS);
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'local:hive' }]);
});

test('a change with no file name, or more than PATHS_CAP paths, goes out with no paths; PATHS_CAP paths still go out (#502)', async (t) => {
  const { tree, fs, changes, tick, machine } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false, machine);
  const [root] = fs.open(true);
  root.emit(null);
  tick(COALESCE_MS);
  assert.deepEqual(changes.at(-1), { type: 'tree', activityId: 'a-1' });
  tick(MIN_PUSH_MS);
  for (let i = 0; i <= PATHS_CAP; i++) root.emit(`gen/${i}.ts`);
  tick(COALESCE_MS);
  assert.deepEqual(changes.at(-1), { type: 'tree', activityId: 'a-1' });
  tick(MIN_PUSH_MS);
  for (let i = 0; i < PATHS_CAP; i++) root.emit(`gen/${String(i).padStart(3, '0')}.ts`);
  tick(COALESCE_MS);
  assert.equal(changes.at(-1)?.paths?.length, PATHS_CAP);
});

test('close() closes every watcher and timer: a pending push and a lease\'s expiry never fire after it (#502)', async (t) => {
  const { tree, fs, changes, tick, machine } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false, machine);
  await tree.lease('a-2', '/other', 'L2', false, machine);
  fs.open(true)[0].emit('a.txt');
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
  const { tree, fs, changes, tick, machine } = setup(t);
  await tree.lease('a-1', root, 'L1', false, machine);
  const git = fs.open(false).find((w) => w.path === gitdir);
  assert.ok(git, 'the gitdir is watched');
  for (const name of ['index.lock', 'HEAD.lock', 'ORIG_HEAD', 'FETCH_HEAD', 'logs']) git.emit(name);
  tick(MIN_PUSH_MS);
  assert.deepEqual(changes, []);
  git.emit('index'); // git renames index.lock over index
  tick(COALESCE_MS);
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'a-1' }]);
  tick(MIN_PUSH_MS);
  git.emit('HEAD');
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
  const { tree, fs, changes, tick, machine } = setup(t);
  await tree.watchNested(machine, root, 'docs');
  assert.equal(fs.watchers.length, 0, 'no lease: nothing is watched');
  await tree.lease('a-1', root, 'L1', false, machine);
  await tree.watchNested(machine, root, 'docs');
  await tree.watchNested(machine, root, 'docs');
  await tree.watchNested(machine, root, 'vendor/lib');
  assert.deepEqual(fs.open(false).map((w) => w.path).sort(), [docsGitdir, gitdir, join(root, 'vendor', 'lib', '.git')].sort());
  fs.open(false).find((w) => w.path === docsGitdir)?.emit('index');
  tick(COALESCE_MS);
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'a-1', paths: ['docs'] }]);
  tree.release('a-1', 'L1');
  assert.deepEqual(fs.open(), []);
});

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve)); // a poll's git answer lands on the next turn
const ENOSPC = Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });

// A watch that fails to start as Machine.watch does (#935): onError on the next microtask, never a throw
const FAILING_WATCH: Machine['watch'] = (_path, _options, _onEvent, onError) => {
  queueMicrotask(() => onError(toMachineError(ENOSPC)));
  return { close: () => undefined };
};

test('a watch that throws switches its root to one git status every FALLBACK_MS, logged once; a tick matching the last output pushes nothing, one that differs pushes once per activity with no paths; close() stops it (#502)', async (t) => {
  const outputs = ['# branch.head main\0', '# branch.head main\0', '# branch.head other\0'];
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => { calls.push(args); return { stdout: outputs[Math.min(calls.length, outputs.length) - 1] }; };
  const { tree, changes, warnings, tick, machine } = setup(t, { exec, watch: FAILING_WATCH });
  await tree.lease('a-1', '/wt', 'L1', false, machine);
  await tree.lease('a-2', '/wt', 'L2', false, machine); // one poll per root, shared
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
  await tree.watchNested(machine, '/wt', 'docs'); // the fallback watches no nested repository
  tree.close();
  tick(FALLBACK_MS * 3);
  await settle();
  assert.equal(calls.length, 3, 'close() stops the poll');
});

test('a watcher\'s error closes the root\'s watchers and falls back to the poll, logged once per root however often it fails (#502)', async (t) => {
  const { root } = await worktreeRoot(t);
  const { tree, fs, warnings, machine } = setup(t, { exec: async () => ({ stdout: '' }) });
  await tree.lease('a-1', root, 'L1', false, machine);
  fs.open(true)[0].fail(new Error('EMFILE: too many open files'));
  assert.deepEqual(fs.open(), [], 'the tree\'s and the gitdir\'s watchers are closed');
  tree.release('a-1', 'L1');
  await tree.lease('a-1', root, 'L2', false, machine); // a fresh watcher on the same root
  fs.open(true)[0].fail(new Error('EMFILE: too many open files'));
  assert.equal(warnings.length, 1);
});

test('release removes only a lease of the activity that holds it: another activity\'s id, or an unknown one, is a no-op (#502)', async (t) => {
  const { tree, fs, machine } = setup(t);
  await tree.lease('a-1', '/wt', 'L1', false, machine);
  tree.release('a-2', 'L1');
  tree.release('a-1', 'never');
  assert.equal(fs.open(true).length, 1, 'still leased');
  tree.release('a-1', 'L1');
  assert.deepEqual(fs.open(), []);
});

test('at MAX_LEASES leases a new id is refused with TooManyLeasesError, a renewal of a held id always succeeds, and a release makes room (#502)', async (t) => {
  const { tree, fs, machine } = setup(t);
  for (let i = 0; i < MAX_LEASES; i++) await tree.lease('a-1', '/wt', `L${i}`, false, machine);
  await assert.rejects(tree.lease('a-1', '/wt', 'extra', false, machine), TooManyLeasesError);
  await tree.lease('a-1', '/wt', 'L0', false, machine);
  assert.equal(fs.watchers.length, 1);
  tree.release('a-1', 'L0');
  await tree.lease('a-1', '/wt', 'extra', false, machine);
});

test('the push spacing runs on a monotonic clock: the wall clock stepping back an hour delays no push (#502)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const fs = fakeFs();
  const changes: TreeChange[] = [];
  const tree = createTreeWatch({ log: { warn: () => undefined, debug: () => undefined }, notify: (change) => changes.push(change) });
  const machine = fakeMachine({ exec: NO_GIT, watch: fs.watch });
  t.after(() => tree.close());
  t.mock.timers.tick(3_600_000);
  await tree.lease('a-1', '/wt', 'L1', false, machine);
  const [root] = fs.open(true);
  root.emit('a.txt');
  t.mock.timers.tick(COALESCE_MS);
  assert.equal(changes.length, 1);
  t.mock.timers.setTime(0);
  root.emit('b.txt');
  t.mock.timers.tick(MIN_PUSH_MS);
  assert.equal(changes.length, 2);
});

test('a pending batch is pushed, with no paths, when the root falls back to the poll (#502)', async (t) => {
  const { tree, fs, changes, machine } = setup(t, { exec: async () => ({ stdout: '' }) });
  await tree.lease('a-1', '/wt', 'L1', false, machine);
  const [root] = fs.open(true);
  root.emit('a.txt');
  root.fail(new Error('EMFILE: too many open files'));
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'a-1' }]);
});

test('a checkout whose .git is a file (a worktree used as the checkout) watches the gitdir it names; one with a .git folder watches no more than the recursive watch (#502)', async (t) => {
  const { root, gitdir } = await worktreeRoot(t);
  const { tree, fs, changes, tick, machine } = setup(t);
  await tree.lease('local:hive', root, 'L1', true, machine);
  const git = fs.open(false).find((w) => w.path === gitdir);
  assert.ok(git, 'the gitdir is watched');
  git.emit('index');
  tick(COALESCE_MS);
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'local:hive' }]);
  const plain = await tempDir(t, 'plain-');
  await mkdir(join(plain, '.git'));
  await tree.lease('local:other', plain, 'L2', true, machine);
  assert.deepEqual(fs.open(false), [git], 'a .git folder is inside the recursive watch');
});

test('two machines leasing the same root path get a watcher each, and each push reaches only its own machine\'s activities (#935)', async (t) => {
  const { tree, fs, machine, changes, tick } = setup(t);
  const other: Machine = { ...machine, id: 'wsl:X' };
  await tree.lease('a-1', '/wt', 'L1', false, machine);
  await tree.lease('a-2', '/wt', 'L2', false, other);
  const [onLocal, onOther] = fs.open(true);
  assert.deepEqual([onLocal.path, onOther.path], ['/wt', '/wt']);
  onOther.emit('a.txt');
  tick(COALESCE_MS);
  assert.deepEqual(changes, [{ type: 'tree', activityId: 'a-2', paths: ['a.txt'] }]);
  await tree.watchNested(other, '/wt', 'docs'); // keyed by machine too: no lease mix-up, nothing to watch here
  tree.release('a-2', 'L2');
  assert.deepEqual(fs.open(true), [onLocal], 'releasing one machine\'s lease closes only its watcher');
});

test('a pushed path is spelled as the root\'s machine names it, whatever the host: a linux machine keeps a \\ in a name, a win32 one turns it into / (#935)', async (t) => {
  const { tree, fs, changes, tick } = setup(t);
  const onLinux = fakeMachine({ exec: NO_GIT, watch: fs.watch, info: { platform: 'linux' } });
  const onWindows = fakeMachine({ exec: NO_GIT, watch: fs.watch, info: { platform: 'win32' } });
  await tree.lease('a-1', '/linux-wt', 'L1', false, onLinux);
  await tree.lease('a-2', '/win-wt', 'L2', false, onWindows);
  const [linux, windows] = fs.open(true);
  linux.emit('src/a\\b.ts');
  windows.emit('src\\c.ts');
  tick(COALESCE_MS);
  assert.deepEqual(changes, [
    { type: 'tree', activityId: 'a-1', paths: ['src/a\\b.ts'] },
    { type: 'tree', activityId: 'a-2', paths: ['src/c.ts'] },
  ]);
});

test('a root\'s .git is looked up on its machine, joined with its machine\'s paths: a win32 machine asks for C:\\wt\\.git on any host (#935)', async (t) => {
  const { tree, fs } = setup(t);
  const asked: string[] = [];
  const lstat = async (path: string): Promise<never> => { asked.push(path); throw new MachineError(`ENOENT: ${path}`, { code: 'ENOENT' }); };
  const onWindows = fakeMachine({ exec: NO_GIT, watch: fs.watch, info: { platform: 'win32' }, fs: { lstat: lstat as Machine['fs']['lstat'] } });
  await tree.lease('a-1', 'C:\\wt', 'L1', false, onWindows);
  assert.deepEqual(asked, ['C:\\wt\\.git']);
  assert.deepEqual(fs.open(false), [], 'no .git: no gitdir watched');
});

test('a .git file over GITDIR_FILE_MAX names no gitdir: only the tree is watched (#935)', async (t) => {
  const root = await tempDir(t, 'wt-');
  await writeFile(join(root, '.git'), `gitdir: ${root}\n${'#'.repeat(GITDIR_FILE_MAX)}`);
  const { tree, fs, machine } = setup(t);
  await tree.lease('a-1', root, 'L1', false, machine);
  assert.deepEqual([fs.open(true).map((w) => w.path), fs.open(false)], [[root], []]);
});
