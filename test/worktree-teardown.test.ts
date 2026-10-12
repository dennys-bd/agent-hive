import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Exec, Workspace } from '../src/types.js';
import { clearTeardownMarker, runTeardown, TEARDOWN_MARKER, type TeardownDeps } from '../src/worktree-teardown.js';
import { RunFailure, type RunOptions, type RunShell } from '../src/worktree-steps.js';
import { type AfterHost, tempDir } from './temp-dir.js';

interface Harness {
  workspace: Workspace; worktree: string; gitDir: string; deps: TeardownDeps;
  git: string[][]; runs: { args: string[]; options: Pick<RunOptions, 'cwd' | 'timeoutMs'> }[]; lines: string[];
}

// The main checkout, the worktree and its git dir, each a temp folder; git answers only the git dir; RUN goes to `run`, else a fake that records.
async function harness(t: AfterHost, teardown: string, extra: Partial<Workspace> = {}, run?: RunShell): Promise<Harness> {
  const [repo, worktree] = await Promise.all([tempDir(t, 'repo-'), tempDir(t, 'wt-')]);
  const gitDir = join(repo, '.git', 'worktrees', basename(worktree));
  await mkdir(gitDir, { recursive: true });
  const git: string[][] = [];
  const runs: Harness['runs'] = [];
  const lines: string[] = [];
  // git answers only the main repo's common dir, and only when asked about the main repo: the worktree's own .git is the worker's
  const exec: Exec = async (_file, args) => {
    git.push(args);
    assert.deepEqual(args, ['-C', repo, 'rev-parse', '--git-common-dir']);
    return { stdout: `${join(repo, '.git')}\n` };
  };
  const recorded: RunShell = async (_file, args, options) => {
    runs.push({ args, options: { cwd: options.cwd, timeoutMs: options.timeoutMs } });
  };
  const deps: TeardownDeps = { exec, log: { info: (line) => lines.push(line) }, run: run ?? recorded };
  return { workspace: { name: 'hive', path: repo, env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', teardown, ...extra }, worktree, gitDir, deps, git, runs, lines };
}

const marked = (h: Harness): Promise<boolean> => access(join(h.gitDir, TEARDOWN_MARKER)).then(() => true, () => false);

test('runTeardown skips without running anything: gone when the folder is not there, none without lines (no git), done once the marker is in the git dir (#654)', async (t) => {
  const h = await harness(t, 'RUN docker compose down');
  assert.deepEqual(await runTeardown(h.workspace, join(h.worktree, 'missing'), h.deps), { outcome: 'gone', steps: 0 });
  const none = await harness(t, '# nothing yet\n');
  assert.deepEqual(await runTeardown(none.workspace, none.worktree, none.deps), { outcome: 'none', steps: 0 });
  assert.deepEqual(none.git, [], 'no git without lines');
  await writeFile(join(h.gitDir, TEARDOWN_MARKER), '');
  assert.deepEqual(await runTeardown(h.workspace, h.worktree, h.deps), { outcome: 'done', steps: 0 });
  assert.deepEqual(h.runs, [], 'nothing ran');
});

test('runTeardown runs its steps in the worktree with teardownTimeout, not setupTimeout, logs each without output, then writes its marker (#654)', async (t) => {
  const h = await harness(t, 'RUN docker compose down\nRUN true', { teardownTimeout: '2m', setupTimeout: '9m' });
  assert.deepEqual(await runTeardown(h.workspace, h.worktree, h.deps), { outcome: 'ran', steps: 2 });
  assert.deepEqual(h.runs, [
    { args: ['-c', 'docker compose down'], options: { cwd: h.worktree, timeoutMs: 120_000 } },
    { args: ['-c', 'true'], options: { cwd: h.worktree, timeoutMs: 120_000 } },
  ]);
  assert.equal(await marked(h), true);
  assert.match(h.lines[0], /^teardown hive-wt-\w+ line 1: RUN docker compose down ok \(0\) \d+ms$/);
});

test('a failing teardown step throws teardown failed at line … with the output tail and writes no marker; a text that does not parse names the teardown (#654)', async (t) => {
  const failing: RunShell = async () => {
    throw new RunFailure(1, 'Error: no such service');
  };
  const h = await harness(t, 'RUN docker compose down', {}, failing);
  await assert.rejects(runTeardown(h.workspace, h.worktree, h.deps), { message: 'teardown failed at line 1 (RUN docker compose down): exit 1\nError: no such service' });
  assert.equal(await marked(h), false);
  const bad = await harness(t, 'RUN true\nCOPY a b c');
  await assert.rejects(runTeardown(bad.workspace, bad.worktree, bad.deps), { message: 'teardown line 2: COPY takes a source and at most one destination' });
});

test('clearTeardownMarker deletes the marker, and is quiet without one, without the folder or when git names no git dir (#654)', async (t) => {
  const h = await harness(t, 'RUN true');
  await writeFile(join(h.gitDir, TEARDOWN_MARKER), '');
  await clearTeardownMarker(h.workspace, h.worktree, h.deps.exec);
  assert.equal(await marked(h), false);
  await clearTeardownMarker(h.workspace, h.worktree, h.deps.exec);
  await clearTeardownMarker(h.workspace, join(h.worktree, 'missing'), async () => assert.fail('no git for a folder that is not there'));
  await clearTeardownMarker(h.workspace, h.worktree, async () => { throw new Error('fatal: not a git repository'); });
});

test('clearTeardownMarker does not throw when the marker cannot be deleted: a stale marker must never fail a spawn or an open (#654)', async (t) => {
  const h = await harness(t, 'RUN true');
  await mkdir(join(h.gitDir, TEARDOWN_MARKER)); // unlink fails with EISDIR / EPERM, not ENOENT
  await clearTeardownMarker(h.workspace, h.worktree, h.deps.exec);
});

test('the teardown marker lands in the main repo\'s worktree dir even when the worker redirects the worktree\'s .git file (#654)', async (t) => {
  const h = await harness(t, 'RUN true');
  const elsewhere = await tempDir(t, 'elsewhere-');
  await writeFile(join(h.worktree, '.git'), `gitdir: ${elsewhere}\n`);
  assert.deepEqual(await runTeardown(h.workspace, h.worktree, h.deps), { outcome: 'ran', steps: 1 });
  assert.equal(await marked(h), true);
  await assert.rejects(access(join(elsewhere, TEARDOWN_MARKER)));
  await clearTeardownMarker(h.workspace, h.worktree, h.deps.exec);
  assert.equal(await marked(h), false);
});

test('the teardown marker is written without following a symlink left at its path (#654)', async (t) => {
  const h = await harness(t, 'RUN true');
  const victim = join(await tempDir(t, 'victim-'), 'file');
  await writeFile(victim, 'keep');
  await symlink(victim, join(h.gitDir, TEARDOWN_MARKER));
  assert.deepEqual(await runTeardown(h.workspace, h.worktree, h.deps), { outcome: 'ran', steps: 1 });
  assert.equal(await readFile(victim, 'utf8'), 'keep');
  assert.equal((await lstat(join(h.gitDir, TEARDOWN_MARKER))).isFile(), true);
});

test('a teardown RUN gets the workspace\'s env: runTeardown hands its steps the workspace it was given, an orphan\'s included (#738)', async (t) => {
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const run: RunShell = async (_file, _args, options) => { envs.push(options.env); };
  const h = await harness(t, 'RUN docker compose down', { env: { COMPOSE_PROJECT_NAME: 'hive-dev' } }, run);
  assert.deepEqual(await runTeardown(h.workspace, h.worktree, h.deps), { outcome: 'ran', steps: 1 });
  assert.equal(envs[0]?.COMPOSE_PROJECT_NAME, 'hive-dev');
});
