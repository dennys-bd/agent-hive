import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceBase } from '../src/fork.js';
import { taskDiff, taskPatch, commitDiff, DIFF_MAX_BYTES, diffBase, DiffTooLarge, isOverflow, fileHash, NoParentCommit, parseDiff, withHash } from '../src/diff.js';
import type { Activity, Task, Exec } from '../src/types.js';
import { tempHive } from './fakes.js';
import { tempDir, type AfterHost } from './temp-dir.js';
import type { WithWork } from './fixtures/work.js';

// git's output as lines, with the trailing newline git always prints.
const diff = (...lines: string[]): string => `${lines.join('\n')}\n`;

test('parseDiff numbers a modified file\'s lines from each hunk header, on the side each line exists on (#270)', () => {
  const text = diff(
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+2',
    ' three',
    '@@ -10,2 +10,3 @@ function tail() {',
    ' ten',
    '+ten and a half',
    ' eleven',
  );
  assert.deepEqual(parseDiff(text), [{
    path: 'src/a.ts', status: 'modified', hunks: [
      { header: '@@ -1,3 +1,3 @@', lines: [
        { kind: 'context', text: 'one', old: 1, new: 1 },
        { kind: 'del', text: 'two', old: 2 },
        { kind: 'add', text: '2', new: 2 },
        { kind: 'context', text: 'three', old: 3, new: 3 },
      ] },
      { header: '@@ -10,2 +10,3 @@ function tail() {', lines: [
        { kind: 'context', text: 'ten', old: 10, new: 10 },
        { kind: 'add', text: 'ten and a half', new: 11 },
        { kind: 'context', text: 'eleven', old: 11, new: 12 },
      ] },
    ],
  }]);
  assert.deepEqual(parseDiff(''), [], 'no change, no file');
});

test('parseDiff reads an added file (a path with a space included) and a deleted one, the deleted one under its old path (#270)', () => {
  const text = diff(
    'diff --git a/docs/my notes.md b/docs/my notes.md',
    'new file mode 100644',
    'index 0000000..3b18e51',
    '--- /dev/null',
    '+++ b/docs/my notes.md',
    '@@ -0,0 +1,2 @@',
    '+hello',
    '+world',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    'index 3b18e51..0000000',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  );
  assert.deepEqual(parseDiff(text), [
    { path: 'docs/my notes.md', status: 'added', hunks: [{ header: '@@ -0,0 +1,2 @@', lines: [{ kind: 'add', text: 'hello', new: 1 }, { kind: 'add', text: 'world', new: 2 }] }] },
    { path: 'old.txt', status: 'deleted', hunks: [{ header: '@@ -1 +0,0 @@', lines: [{ kind: 'del', text: 'bye', old: 1 }] }] },
  ]);
});

test('parseDiff reads a rename with no change, a rename with changes and a binary file, which has no hunk (#270)', () => {
  const text = diff(
    'diff --git a/a.txt b/b.txt',
    'similarity index 100%',
    'rename from a.txt',
    'rename to b.txt',
    'diff --git a/c.ts b/d.ts',
    'similarity index 80%',
    'rename from c.ts',
    'rename to d.ts',
    'index 1111111..2222222 100644',
    '--- a/c.ts',
    '+++ b/d.ts',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    'diff --git a/logo.png b/logo.png',
    'index 1111111..2222222 100644',
    'Binary files a/logo.png and b/logo.png differ',
  );
  assert.deepEqual(parseDiff(text), [
    { path: 'b.txt', oldPath: 'a.txt', status: 'renamed', hunks: [] },
    { path: 'd.ts', oldPath: 'c.ts', status: 'renamed', hunks: [{ header: '@@ -1 +1 @@', lines: [{ kind: 'del', text: 'x', old: 1 }, { kind: 'add', text: 'y', new: 1 }] }] },
    { path: 'logo.png', status: 'modified', binary: true, hunks: [] },
  ]);
});

test('parseDiff skips "\\ No newline at end of file" and keeps a hunk line that looks like a header (---, +++) as content (#270)', () => {
  const text = diff(
    'diff --git a/a.md b/a.md',
    'index 1111111..2222222 100644',
    '--- a/a.md',
    '+++ b/a.md',
    '@@ -1,2 +1,2 @@',
    '---- old rule',
    '+++ new rule',
    ' last',
    '\\ No newline at end of file',
  );
  assert.deepEqual(parseDiff(text), [{
    path: 'a.md', status: 'modified', hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [
      { kind: 'del', text: '--- old rule', old: 1 },
      { kind: 'add', text: '++ new rule', new: 1 },
      { kind: 'context', text: 'last', old: 2, new: 2 },
    ] }],
  }]);
});

const run: Exec = promisify(execFile);
const gone = (path: string): Promise<boolean> => access(path).then(() => false, () => true);
const BASE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const MODIFIED = diff('diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-one', '+two');
const OVERFLOW = (): Error => Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });

interface Call { args: string[]; index?: string; maxBuffer?: number }

// A fake git whose real index is a file on disk: rev-parse answers its path, the diff answers MODIFIED or throws `fail`. Every call is
// recorded with the GIT_INDEX_FILE and the maxBuffer it ran with.
async function fakeGit(t: AfterHost, fail?: unknown): Promise<{ exec: Exec; calls: Call[]; realIndex: string }> {
  const realIndex = join(await tempDir(t, 'index-'), 'index');
  await writeFile(realIndex, 'the real index');
  const calls: Call[] = [];
  const exec: Exec = async (_file, args, opts) => {
    const index = opts?.env?.GIT_INDEX_FILE;
    calls.push({ args, ...(index === undefined ? {} : { index }), ...(opts?.maxBuffer === undefined ? {} : { maxBuffer: opts.maxBuffer }) });
    if (args.includes('rev-parse')) return { stdout: `${realIndex}\n` };
    if (args.includes('diff') && fail !== undefined) throw fail;
    return { stdout: args.includes('diff') ? MODIFIED : '' };
  };
  return { exec, calls, realIndex };
}
const copyOf = (calls: Call[]): string => calls[1]?.index ?? assert.fail('add ran without GIT_INDEX_FILE');

test('taskDiff runs add -A and diff --cached on a copy of the worktree\'s index in a temp dir, capped at DIFF_MAX_BYTES; the real index is never touched and the temp dir goes afterwards (#270)', async (t) => {
  const { exec, calls, realIndex } = await fakeGit(t);
  assert.deepEqual(await taskDiff('/wt', BASE, exec), parseDiff(MODIFIED).map(withHash));
  const copy = copyOf(calls);
  assert.notEqual(copy, realIndex);
  assert.deepEqual(calls, [
    { args: ['-C', '/wt', 'rev-parse', '--git-path', 'index'] },
    { args: ['-C', '/wt', '-c', 'core.fsmonitor=false', 'add', '-A'], index: copy, maxBuffer: DIFF_MAX_BYTES },
    { args: ['-C', '/wt', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', 'diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/', '--end-of-options', BASE], index: copy, maxBuffer: DIFF_MAX_BYTES },
  ]);
  assert.equal(await readFile(realIndex, 'utf8'), 'the real index');
  assert.ok(await gone(dirname(copy)), 'the temp dir is removed');
});

test('taskDiff rejects with git\'s own words, or DiffTooLarge past maxBuffer, and removes the temp dir either way (#270)', async (t) => {
  const failing = await fakeGit(t, Object.assign(new Error('Command failed: git diff'), { stderr: 'fatal: bad object a1b2c3d\n' }));
  await assert.rejects(taskDiff('/wt', BASE, failing.exec), { message: 'fatal: bad object a1b2c3d' });
  assert.ok(await gone(dirname(copyOf(failing.calls))), 'removed on failure too');
  const large = await fakeGit(t, OVERFLOW());
  await assert.rejects(taskDiff('/wt', BASE, large.exec), DiffTooLarge);
  assert.ok(await gone(dirname(copyOf(large.calls))));
});

test('isOverflow recognises execFile\'s own rejection when the output passes maxBuffer, and nothing else (#270)', async () => {
  const err = await run('git', ['--version'], { maxBuffer: 1 }).then(() => assert.fail('git --version fit in one byte'), (e: unknown) => e);
  assert.equal(isOverflow(err), true);
  assert.equal(isOverflow(OVERFLOW()), true);
  assert.equal(isOverflow(new Error('fatal: bad object')), false);
  assert.equal(isOverflow(undefined), false);
});

test('taskDiff on a real repo shows a commit, an unstaged edit on top and an untracked file, never a gitignored one, and leaves the real index as it was (#270)', async (t) => {
  const { repo } = await tempHive(t);
  const git = (...args: string[]) => run('git', ['-C', repo, '-c', 'user.name=Hive', '-c', 'user.email=hive@example.invalid', '-c', 'commit.gpgsign=false', ...args]);
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await git('add', 'a.txt');
  await git('commit', '--quiet', '-m', 'base');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n');
  await git('commit', '--quiet', '-am', 'second');
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(repo, 'ignored.txt'), 'secret\n');
  await writeFile(join(repo, 'new.txt'), 'fresh\n');
  const status = (await git('status', '--porcelain')).stdout;
  const files = await taskDiff(repo, base, run);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [['.gitignore', 'added'], ['a.txt', 'modified'], ['new.txt', 'added']]);
  assert.deepEqual(files[1].hunks[0].lines.map((l) => [l.kind, l.text]), [['context', 'one'], ['add', 'two'], ['add', 'three']]);
  assert.equal((await git('status', '--porcelain')).stdout, status, 'the real index is untouched: new.txt is still untracked');
});

test('diffBase: the stage scope is the recorded stage start, with no git; the worktree scope is merge-base HEAD with the task\'s chosen base, else origin/<baseBranch>, else origin/HEAD, named by its short sha and that ref (#270)', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    return { stdout: `${BASE}\n` };
  };
  const START = 'f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1';
  const task: WithWork = { item: { itemId: 'I1', id: '1', title: 'T', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true };
  // #629: the stage start is the activity's
  assert.deepEqual(await diffBase(task, { stageStart: { stage: 'dev', commit: START } }, { remote: 'origin' }, '/wt', 'stage', exec), { commit: START, label: 'f0e1d2c' });
  assert.deepEqual(calls, []);
  const cases: [Pick<Activity, 'base'> | undefined, Pick<WorkspaceBase, 'remote' | 'branch'>, string][] = [ // #629: the chosen base is the activity's
    [{ base: { ref: 'origin/feature-x', tellWorker: false } }, { remote: 'origin', branch: 'develop' }, 'origin/feature-x'],
    [{}, { remote: 'origin', branch: 'develop' }, 'origin/develop'],
    [undefined, { remote: 'origin' }, 'origin/HEAD'],
    [undefined, { remote: 'upstream', branch: 'devtest' }, 'upstream/devtest'], // #854: a fork's base remote and the workspace's own base
  ];
  for (const [live, base, ref] of cases) {
    assert.deepEqual(await diffBase(task, live, base, '/wt', 'worktree', exec), { commit: BASE, label: `a1b2c3d (${ref})` }, ref);
  }
  assert.deepEqual(calls, ['origin/feature-x', 'origin/develop', 'origin/HEAD', 'upstream/devtest'].map((ref) => ['-C', '/wt', 'merge-base', '--end-of-options', 'HEAD', ref]));
});

test('diffBase rejects with git\'s own words when merge-base fails (#270)', async () => {
  const task: Task = { item: { itemId: 'I1', id: '1', title: 'T', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true };
  const exec: Exec = async () => {
    throw Object.assign(new Error('Command failed: git merge-base'), { stderr: 'fatal: Not a valid object name origin/HEAD\n' });
  };
  await assert.rejects(diffBase(task, undefined, { remote: 'origin' }, '/wt', 'worktree', exec), { message: 'fatal: Not a valid object name origin/HEAD' });
});

const TASK: Task = { item: { itemId: 'I1', id: '1', title: 'T', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true };

test('diffBase: the commit scope is HEAD^ as a sha named with HEAD^; commitDiff diffs HEAD^ against HEAD with the pinned flags and no index copy (#591)', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    return { stdout: args.includes('rev-parse') ? `${BASE}\n` : MODIFIED };
  };
  assert.deepEqual(await diffBase(TASK, undefined, { remote: 'origin' }, '/wt', 'commit', exec), { commit: BASE, label: 'a1b2c3d (HEAD^)' });
  assert.deepEqual(await commitDiff('/wt', exec), parseDiff(MODIFIED).map(withHash));
  assert.deepEqual(calls, [
    ['-C', '/wt', 'rev-parse', '--verify', '--quiet', 'HEAD^^{commit}'],
    ['-C', '/wt', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/', '--end-of-options', 'HEAD^', 'HEAD'],
  ]);
});

test('diffBase for a checkpoint answers its restore point, labelled with its number (#619)', async () => {
  const exec: Exec = async () => { throw new Error('no git for a checkpoint base'); };
  const checkpoint = { n: 3, commit: 'c3d4e5f6a7b8c3d4e5f6a7b8c3d4e5f6a7b8c3d4' };
  assert.deepEqual(await diffBase(TASK, undefined, { remote: 'origin' }, '/wt', 'checkpoint', exec, checkpoint), { commit: checkpoint.commit, label: 'c3d4e5f (checkpoint 3)' });
  await assert.rejects(diffBase(TASK, undefined, { remote: 'origin' }, '/wt', 'checkpoint', exec));
});

test('commitDiff on a real repo shows the last commit alone, never the uncommitted work; a root commit has no parent (#591)', async (t) => {
  const { repo } = await tempHive(t);
  const git = (...args: string[]) => run('git', ['-C', repo, '-c', 'user.name=Hive', '-c', 'user.email=hive@example.invalid', '-c', 'commit.gpgsign=false', ...args]);
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await git('add', 'a.txt');
  await git('commit', '--quiet', '-m', 'root');
  await assert.rejects(diffBase(TASK, undefined, { remote: 'origin' }, repo, 'commit', run), NoParentCommit);
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n');
  await git('commit', '--quiet', '-am', 'second');
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(repo, 'new.txt'), 'fresh\n');
  assert.equal((await diffBase(TASK, undefined, { remote: 'origin' }, repo, 'commit', run)).commit, (await git('rev-parse', 'HEAD^')).stdout.trim());
  const files = await commitDiff(repo, run);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [['a.txt', 'modified']]);
  assert.deepEqual(files[0].hunks[0].lines.map((l) => [l.kind, l.text]), [['context', 'one'], ['add', 'two']]);
});

test('fileHash changes with a hunk, the status or the old path, never with the path or the file order (#591)', () => {
  const [file] = parseDiff(MODIFIED);
  const hash = fileHash(file);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(fileHash({ ...file, path: 'elsewhere.txt' }), hash);
  assert.notEqual(fileHash({ ...file, hunks: [{ ...file.hunks[0], lines: file.hunks[0].lines.slice(1) }] }), hash);
  assert.notEqual(fileHash({ ...file, status: 'renamed', oldPath: 'b.txt' }), hash);
  const two = parseDiff(`${MODIFIED}${MODIFIED.replaceAll('a.txt', 'b.txt')}`).map(withHash);
  assert.deepEqual([...two].reverse().map((f) => f.hash).reverse(), two.map((f) => f.hash));
});

test('taskPatch gives the stat and the patch of the worktree against a base, untracked files included, the real index untouched (#877)', async (t) => {
  const { repo } = await tempHive(t);
  const git = (...args: string[]) => run('git', ['-C', repo, '-c', 'user.name=Hive', '-c', 'user.email=hive@example.invalid', '-c', 'commit.gpgsign=false', ...args]);
  await writeFile(join(repo, 'a.ts'), 'one\n');
  await git('add', 'a.ts');
  await git('commit', '--quiet', '-m', 'base');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  await writeFile(join(repo, 'a.ts'), 'one\ntwo\n');
  await writeFile(join(repo, 'new.ts'), 'fresh\n');
  const { stat, patch } = await taskPatch(repo, base, run);
  assert.match(stat, /a\.ts +\| +\d+/);
  assert.match(stat, /new\.ts/);
  assert.match(patch, /^diff --git a\/a\.ts b\/a\.ts/m);
  assert.match(patch, /\+\+\+ b\/new\.ts/);
  assert.equal((await git('status', '--porcelain')).stdout.includes('?? new.ts'), true, 'the real index never took the add');
});
