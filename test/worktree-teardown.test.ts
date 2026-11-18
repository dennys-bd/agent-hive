import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Machine, RunProcess } from '../src/machine.js';
import type { Workspace } from '../src/types.js';
import { clearTeardownMarker, runTeardown, TEARDOWN_MARKER, type TeardownDeps } from '../src/worktree-teardown.js';
import { fakeMachine, runResult } from './fakes.js';
import { type AfterHost, tempDir } from './temp-dir.js';

interface Harness {
  workspace: Workspace; worktree: string; gitDir: string; deps: TeardownDeps; machine: Machine;
  git: string[][]; runs: { args: string[]; options: Pick<RunProcess, 'cwd' | 'timeoutMs'> }[]; lines: string[];
}

// The main checkout, the worktree and its git dir, each a temp folder; git answers only the git dir; RUN goes to `run`, else a fake that records.
async function harness(t: AfterHost, teardown: string, extra: Partial<Workspace> = {}, run?: Machine['run']): Promise<Harness> {
  const [repo, worktree] = await Promise.all([tempDir(t, 'repo-'), tempDir(t, 'wt-')]);
  const gitDir = join(repo, '.git', 'worktrees', basename(worktree));
  await mkdir(gitDir, { recursive: true });
  const git: string[][] = [];
  const runs: Harness['runs'] = [];
  const lines: string[] = [];
  // git answers only the main repo's common dir, and only when asked about the main repo: the worktree's own .git is the worker's
  const exec: Machine['exec'] = async (_file, args) => {
    git.push(args);
    assert.deepEqual(args, ['-C', repo, 'rev-parse', '--git-common-dir']);
    return { stdout: `${join(repo, '.git')}\n` };
  };
  const recorded: Machine['run'] = async (p) => {
    runs.push({ args: p.args, options: { cwd: p.cwd, timeoutMs: p.timeoutMs } });
    return runResult(0);
  };
  const machine = fakeMachine({ exec, run: run ?? recorded });
  const deps: TeardownDeps = { log: { info: (line) => lines.push(line) } };
  return { workspace: { name: 'hive', path: repo, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)', teardown, ...extra }, worktree, gitDir, deps, machine, git, runs, lines };
}

const marked = (h: Harness): Promise<boolean> => access(join(h.gitDir, TEARDOWN_MARKER)).then(() => true, () => false);

test('runTeardown skips without running anything: gone when the folder is not there, none without lines (no git), done once the marker is in the git dir (#654)', async (t) => {
  const h = await harness(t, 'RUN docker compose down');
  assert.deepEqual(await runTeardown(h.machine, h.workspace, join(h.worktree, 'missing'), h.deps), { outcome: 'gone', steps: 0 });
  const none = await harness(t, '# nothing yet\n');
  assert.deepEqual(await runTeardown(none.machine, none.workspace, none.worktree, none.deps), { outcome: 'none', steps: 0 });
  assert.deepEqual(none.git, [], 'no git without lines');
  await writeFile(join(h.gitDir, TEARDOWN_MARKER), '');
  assert.deepEqual(await runTeardown(h.machine, h.workspace, h.worktree, h.deps), { outcome: 'done', steps: 0 });
  assert.deepEqual(h.runs, [], 'nothing ran');
});

test('runTeardown runs its steps in the worktree with teardownTimeout, not setupTimeout, logs each without output, then writes its marker (#654)', async (t) => {
  const h = await harness(t, 'RUN docker compose down\nRUN true', { teardownTimeout: '2m', setupTimeout: '9m' });
  assert.deepEqual(await runTeardown(h.machine, h.workspace, h.worktree, h.deps), { outcome: 'ran', steps: 2 });
  assert.deepEqual(h.runs, [
    { args: ['-c', 'docker compose down'], options: { cwd: h.worktree, timeoutMs: 120_000 } },
    { args: ['-c', 'true'], options: { cwd: h.worktree, timeoutMs: 120_000 } },
  ]);
  assert.equal(await marked(h), true);
  assert.match(h.lines[0], /^teardown hive-wt-\w+ line 1: RUN docker compose down ok \(0\) \d+ms$/);
});

test('a failing teardown step throws teardown failed at line … with the output tail and writes no marker; a text that does not parse names the teardown (#654)', async (t) => {
  const failing: Machine['run'] = async () => runResult(1, 'Error: no such service');
  const h = await harness(t, 'RUN docker compose down', {}, failing);
  await assert.rejects(runTeardown(h.machine, h.workspace, h.worktree, h.deps), { message: 'teardown failed at step 1 of 1 (line 1, RUN docker compose down): the command exited with code 1\nError: no such service' });
  assert.equal(await marked(h), false);
  const bad = await harness(t, 'RUN true\nCOPY a b c');
  await assert.rejects(runTeardown(bad.machine, bad.workspace, bad.worktree, bad.deps), { message: 'teardown line 2: COPY takes a source and at most one destination' });
});

test('clearTeardownMarker deletes the marker, and is quiet without one, without the folder or when git names no git dir (#654)', async (t) => {
  const h = await harness(t, 'RUN true');
  await writeFile(join(h.gitDir, TEARDOWN_MARKER), '');
  await clearTeardownMarker(h.machine, h.workspace, h.worktree);
  assert.equal(await marked(h), false);
  await clearTeardownMarker(h.machine, h.workspace, h.worktree);
  await clearTeardownMarker(fakeMachine({ exec: async () => assert.fail('no git for a folder that is not there') }), h.workspace, join(h.worktree, 'missing'));
  await clearTeardownMarker(fakeMachine({ exec: async () => { throw new Error('fatal: not a git repository'); } }), h.workspace, h.worktree);
});

test('clearTeardownMarker does not throw when the marker cannot be deleted: a stale marker must never fail a spawn or an open (#654)', async (t) => {
  const h = await harness(t, 'RUN true');
  await mkdir(join(h.gitDir, TEARDOWN_MARKER)); // unlink fails with EISDIR / EPERM, not ENOENT
  await clearTeardownMarker(h.machine, h.workspace, h.worktree);
});

test('the teardown marker lands in the main repo\'s worktree dir even when the worker redirects the worktree\'s .git file (#654)', async (t) => {
  const h = await harness(t, 'RUN true');
  const elsewhere = await tempDir(t, 'elsewhere-');
  await writeFile(join(h.worktree, '.git'), `gitdir: ${elsewhere}\n`);
  assert.deepEqual(await runTeardown(h.machine, h.workspace, h.worktree, h.deps), { outcome: 'ran', steps: 1 });
  assert.equal(await marked(h), true);
  await assert.rejects(access(join(elsewhere, TEARDOWN_MARKER)));
  await clearTeardownMarker(h.machine, h.workspace, h.worktree);
  assert.equal(await marked(h), false);
});

test('the teardown marker is written without following a symlink left at its path (#654)', async (t) => {
  const h = await harness(t, 'RUN true');
  const victim = join(await tempDir(t, 'victim-'), 'file');
  await writeFile(victim, 'keep');
  await symlink(victim, join(h.gitDir, TEARDOWN_MARKER));
  assert.deepEqual(await runTeardown(h.machine, h.workspace, h.worktree, h.deps), { outcome: 'ran', steps: 1 });
  assert.equal(await readFile(victim, 'utf8'), 'keep');
  assert.equal((await lstat(join(h.gitDir, TEARDOWN_MARKER))).isFile(), true);
});

test('a teardown RUN gets the workspace\'s env: runTeardown hands its steps the workspace it was given, an orphan\'s included (#738)', async (t) => {
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const run: Machine['run'] = async (p) => { envs.push(p.env); return runResult(0); };
  const h = await harness(t, 'RUN docker compose down', { env: { COMPOSE_PROJECT_NAME: 'hive-dev' } }, run);
  assert.deepEqual(await runTeardown(h.machine, h.workspace, h.worktree, h.deps), { outcome: 'ran', steps: 1 });
  assert.equal(envs[0]?.COMPOSE_PROJECT_NAME, 'hive-dev');
});
