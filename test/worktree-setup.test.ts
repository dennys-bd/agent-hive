import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandLine, okLine } from '../src/console.js';
import type { Exec, Workspace } from '../src/types.js';
import { hasSetup, isSetUp, needsSetup, runSetup, SETUP_MARKER, type SetupDeps } from '../src/worktree-setup.js';
import { RunFailure, type RunOptions, runShell } from '../src/worktree-steps.js';
import { tempDir, type AfterHost } from './temp-dir.js';

interface Harness {
  workspace: Workspace; worktree: string; gitDir: string; deps: SetupDeps;
  git: string[][]; // every git argv after 'git'
  runs: { args: string[]; options: Pick<RunOptions, 'cwd' | 'timeoutMs'> }[]; // every RUN the fake shell received
  steps: string[]; // what onStep saw
  lines: string[]; // what the log got
  output: string[]; // what the console run got (#351)
}

// The main checkout, the worktree and its git dir, each a temp folder. git answers only the git dir; RUN goes to `run`, else a fake that
// records it and succeeds.
async function harness(t: AfterHost, setup: string, run?: SetupDeps['run'], extra: Partial<Workspace> = {}): Promise<Harness> {
  const [repo, worktree, gitDir] = await Promise.all([tempDir(t, 'repo-'), tempDir(t, 'wt-'), tempDir(t, 'gitdir-')]);
  const git: string[][] = [];
  const runs: Harness['runs'] = [];
  const steps: string[] = [];
  const lines: string[] = [];
  const output: string[] = [];
  const exec: Exec = async (_file, args) => {
    git.push(args);
    return { stdout: `${gitDir}\n` };
  };
  const recorded: SetupDeps['run'] = async (_file, args, options) => {
    runs.push({ args, options: { cwd: options.cwd, timeoutMs: options.timeoutMs } });
  };
  const deps: SetupDeps = {
    exec, log: { info: (line) => lines.push(line) }, onStep: (step) => steps.push(step), output: (text) => output.push(text), run: run ?? recorded,
  };
  return { workspace: { name: 'hive', path: repo, env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', setup, ...extra }, worktree, gitDir, deps, git, runs, steps, lines, output };
}

const marked = (h: Harness): Promise<boolean> => access(join(h.gitDir, SETUP_MARKER)).then(() => true, () => false);

test('runSetup does nothing for an empty setup or one of comments only (no git, no marker), nor once the worktree\'s git dir has the marker (#299)', async (t) => {
  for (const setup of ['', '# later\n\n']) {
    const h = await harness(t, setup);
    await runSetup(h.workspace, h.worktree, h.deps);
    assert.deepEqual([h.git, h.steps, await marked(h)], [[], [], false], JSON.stringify(setup));
  }
  const h = await harness(t, 'RUN pnpm install');
  await writeFile(join(h.gitDir, SETUP_MARKER), '');
  await runSetup(h.workspace, h.worktree, h.deps);
  assert.deepEqual(h.git, [['-C', h.worktree, 'rev-parse', '--absolute-git-dir']]);
  assert.deepEqual([h.steps, h.runs], [[], []], 'set up already: a respawn or a Continue skips it');
});

test('runSetup runs the steps in order in the worktree: COPY copies a file and a folder from the main checkout, RUN goes to /bin/sh -c with the workspace\'s timeout; onStep sees each, the log names each without contents, and the marker comes last (#299)', async (t) => {
  const h = await harness(t, 'COPY .env\n# deps\nRUN pnpm install --frozen-lockfile\nCOPY config/local', undefined, { setupTimeout: '7m' });
  await writeFile(join(h.workspace.path, '.env'), 'TOKEN=secret\n');
  await mkdir(join(h.workspace.path, 'config', 'local', 'deep'), { recursive: true });
  await writeFile(join(h.workspace.path, 'config', 'local', 'deep', 'a.json'), '{}');
  await runSetup(h.workspace, h.worktree, h.deps);
  assert.deepEqual(h.steps, ['COPY .env', 'RUN pnpm install --frozen-lockfile', 'COPY config/local']);
  assert.equal(await readFile(join(h.worktree, '.env'), 'utf8'), 'TOKEN=secret\n');
  assert.equal(await readFile(join(h.worktree, 'config', 'local', 'deep', 'a.json'), 'utf8'), '{}');
  assert.deepEqual(h.runs, [{ args: ['-c', 'pnpm install --frozen-lockfile'], options: { cwd: h.worktree, timeoutMs: 7 * 60_000 } }]);
  assert.equal(await marked(h), true);
  assert.equal(h.lines.length, 3);
  assert.match(h.lines[0], /^setup hive-wt-\w+ line 1: COPY \.env ok \(0\) \d+ms$/);
  assert.match(h.lines[1], /^setup hive-wt-\w+ line 3: RUN pnpm install --frozen-lockfile ok \(0\) \d+ms$/);
  assert.ok(h.lines.every((l) => !l.includes('secret')), 'a copied file is named, never read into the log');
});

test('a COPY whose source is missing, or a symlink that leads out of the workspace, fails the setup at its line and writes no marker (#299)', async (t) => {
  const missing = await harness(t, 'COPY .env');
  await assert.rejects(runSetup(missing.workspace, missing.worktree, missing.deps), { message: 'setup failed at line 1 (COPY .env): not found in hive' });
  assert.equal(await marked(missing), false);
  const outside = await harness(t, 'RUN true\nCOPY .env');
  const elsewhere = await tempDir(t, 'outside-');
  await writeFile(join(elsewhere, 'secrets'), 'x');
  await symlink(join(elsewhere, 'secrets'), join(outside.workspace.path, '.env'));
  await assert.rejects(runSetup(outside.workspace, outside.worktree, outside.deps), { message: 'setup failed at line 2 (COPY .env): outside hive' });
  await assert.rejects(readFile(join(outside.worktree, '.env')), 'nothing was copied');
  assert.equal(await marked(outside), false);
});

test('a RUN that fails or times out stops the setup at its line: the reason and the output tail go to the error, only the code to the log, later steps never run and no marker is written (#299)', async (t) => {
  const seen: string[] = [];
  const failing: SetupDeps['run'] = async (_file, args, options) => {
    seen.push(`${args[1]} ${options.timeoutMs}`);
    throw new RunFailure(args[1] === 'pnpm test' ? 'timeout' : 1, 'npm ERR! TOKEN=secret\nnpm ERR! boom');
  };
  const h = await harness(t, 'RUN pnpm install\nCOPY .env', failing);
  await assert.rejects(runSetup(h.workspace, h.worktree, h.deps), { message: 'setup failed at line 1 (RUN pnpm install): exit 1\nnpm ERR! TOKEN=secret\nnpm ERR! boom' });
  assert.deepEqual([seen, h.steps, await marked(h)], [['pnpm install undefined'], ['RUN pnpm install'], false], 'no setupTimeout, no limit (#511); the COPY never ran');
  assert.match(h.lines[0], /line 1: RUN pnpm install failed \(1\) \d+ms$/);
  assert.ok(!h.lines.join('\n').includes('secret'), 'a command\'s output never reaches the log');
  const slow = await harness(t, 'RUN pnpm test', failing, { setupTimeout: '90s' });
  await assert.rejects(runSetup(slow.workspace, slow.worktree, slow.deps), { message: 'setup failed at line 1 (RUN pnpm test): timed out after 90s\nnpm ERR! TOKEN=secret\nnpm ERR! boom' });
  assert.deepEqual(seen.at(-1), 'pnpm test 90000', 'setupTimeout reaches the shell as ms (#511)');
  assert.match(slow.lines[0], /failed \(timeout\) \d+ms$/);
});

test('LOAD expands the file\'s steps in place, read from the main checkout at every run; a LOAD inside it, a bad line or a missing file fails at the LOAD\'s line before any step runs (#299)', async (t) => {
  const h = await harness(t, 'COPY .env\nLOAD setup/worktree.hive\nRUN echo done');
  await writeFile(join(h.workspace.path, '.env'), 'A=1\n');
  await mkdir(join(h.workspace.path, 'setup'));
  await writeFile(join(h.workspace.path, 'setup', 'worktree.hive'), '# shared\nRUN pnpm install\nRUN pnpm build\n');
  await runSetup(h.workspace, h.worktree, h.deps);
  assert.deepEqual(h.steps, ['COPY .env', 'RUN pnpm install', 'RUN pnpm build', 'RUN echo done']);
  const fails = async (file: string | undefined, message: string): Promise<void> => {
    const f = await harness(t, 'RUN true\nLOAD setup.hive');
    if (file !== undefined) await writeFile(join(f.workspace.path, 'setup.hive'), file);
    await assert.rejects(runSetup(f.workspace, f.worktree, f.deps), { message });
    assert.deepEqual([f.steps, await marked(f)], [[], false], 'a LOAD is read before any step runs');
  };
  await fails('RUN a\nLOAD other.hive\n', 'setup failed at line 2 (LOAD setup.hive): line 2: LOAD cannot be used inside a loaded file');
  await fails('FROM node\n', 'setup failed at line 2 (LOAD setup.hive): line 1: unknown instruction (COPY, RUN, LOAD or DEL)'); // the loaded file's text is never echoed
  await fails(undefined, 'setup failed at line 2 (LOAD setup.hive): not found in hive');
});

test('runShell runs /bin/sh in the cwd with stdin closed: exit 0 resolves; a non-zero exit rejects with its code and the last 20 lines of output, stderr included; a prompt fails at once (#299)', async (t) => {
  const cwd = await tempDir(t, 'run-');
  await runShell('/bin/sh', ['-c', 'echo ok > here.txt'], { cwd, timeoutMs: 30_000 });
  assert.equal(await readFile(join(cwd, 'here.txt'), 'utf8'), 'ok\n', 'it ran in the worktree');
  const failure = async (command: string): Promise<RunFailure> => {
    try {
      await runShell('/bin/sh', ['-c', command], { cwd, timeoutMs: 30_000 });
    } catch (err) {
      assert.ok(err instanceof RunFailure, String(err));
      return err;
    }
    return assert.fail(`${command} resolved`);
  };
  const long = await failure('for i in $(seq 1 30); do echo line $i; done; exit 3');
  assert.deepEqual([long.code, long.message], [3, 'exit 3']);
  assert.deepEqual(long.tail.split('\n'), Array.from({ length: 20 }, (_, i) => `line ${i + 11}`), 'the last 20 lines only');
  assert.equal((await failure('echo oops >&2; exit 2')).tail, 'oops');
  assert.equal((await failure('read answer')).code, 1, 'stdin is closed: read gets EOF instead of waiting');
});

test('runShell kills the whole process group when a step outlives its timeout and rejects with timeout and the output so far (#299)', async (t) => {
  const cwd = await tempDir(t, 'run-');
  const began = Date.now(); // 2 s, not less: under the full suite's load sh may not have echoed yet
  const err = await runShell('/bin/sh', ['-c', 'echo started; sleep 30 & wait'], { cwd, timeoutMs: 2_000 }).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof RunFailure, String(err));
  assert.deepEqual([err.code, err.message, err.tail], ['timeout', 'timed out', 'started']);
  assert.ok(Date.now() - began < 10_000, 'the sleep sh started died with it: its open stdout would otherwise hold the close for 30 s');
});

test('a COPY whose destination folder in the worktree is a symlink out of it fails and writes nothing outside the worktree (#299)', async (t) => {
  const h = await harness(t, 'COPY config/app.env');
  const outside = await tempDir(t, 'outside-');
  await mkdir(join(h.workspace.path, 'config'));
  await writeFile(join(h.workspace.path, 'config', 'app.env'), 'TOKEN=secret\n');
  await symlink(outside, join(h.worktree, 'config')); // a branch that committed config -> somewhere else
  await assert.rejects(runSetup(h.workspace, h.worktree, h.deps), /^Error: setup failed at line 1 \(COPY config\/app.env\): outside the worktree$/);
  await assert.rejects(access(join(outside, 'app.env')), { code: 'ENOENT' });
  assert.equal(await marked(h), false);
});

test('a bad line in a LOADed file is refused without echoing the file\'s text, which may be a secret (#299)', async (t) => {
  const h = await harness(t, 'LOAD .env');
  await writeFile(join(h.workspace.path, '.env'), 'NPM_TOKEN=abc123\n');
  await assert.rejects(runSetup(h.workspace, h.worktree, h.deps), (err: Error) => !err.message.includes('abc123') && /line 1: unknown instruction/.test(err.message));
});

test('runShell keeps a bounded tail of output that has no newlines (#299)', async () => {
  const failure = await runShell('/bin/sh', ['-c', 'head -c 200000 /dev/zero | tr "\\0" x; exit 3'], { cwd: tmpdir(), timeoutMs: 30_000 }).then(() => undefined, (err: unknown) => err);
  assert.ok(failure instanceof RunFailure);
  assert.equal(failure.code, 3);
  assert.ok(failure.tail.length <= 8192, `tail of ${failure.tail.length} chars`);
});

test('runSetup writes a header line per step to output and hands it a RUN\'s output as it comes, never to the log; nothing when there is nothing to run (#351)', async (t) => {
  const talking: SetupDeps['run'] = async (_file, _args, options) => {
    options.onOutput?.('added 12 packages\n');
  };
  const h = await harness(t, 'COPY .env\nRUN pnpm install', talking);
  await writeFile(join(h.workspace.path, '.env'), 'A=1\n');
  assert.equal(await runSetup(h.workspace, h.worktree, h.deps), 2);
  const shownMs = (line: string): string => line.replace(/ok \d+ms/, 'ok Nms');
  assert.deepEqual(h.output.map(shownMs), [
    `${commandLine('> COPY .env')}\n`, 'copied 1 files to .env\n', `${okLine('ok Nms')}\n`,
    `${commandLine('> RUN pnpm install')}\n`, 'added 12 packages\n', `${okLine('ok Nms')}\n`,
  ]);
  assert.ok(h.lines.every((l) => !l.includes('added')), 'the output never reaches the log');
  const none = await harness(t, '# later\n');
  await runSetup(none.workspace, none.worktree, none.deps);
  assert.deepEqual(none.output, []);
});

test('an abort fails the running RUN with stopped, and a step not yet started fails with stopped before it runs; no marker is written (#351)', async (t) => {
  const controller = new AbortController();
  const stoppedMidway: SetupDeps['run'] = async (_file, _args, options) => {
    assert.equal(options.signal, controller.signal, 'the signal reaches the RUN');
    controller.abort(); // a Stop on the task while the step runs; runShell then rejects as below
    throw new RunFailure('stopped', '');
  };
  const h = await harness(t, 'RUN pnpm install\nCOPY .env', stoppedMidway);
  await assert.rejects(runSetup(h.workspace, h.worktree, { ...h.deps, signal: controller.signal }), { message: 'setup failed at line 1 (RUN pnpm install): stopped' });
  assert.deepEqual([h.steps, await marked(h)], [['RUN pnpm install'], false]);
  assert.match(h.lines[0], /line 1: RUN pnpm install failed \(stopped\) \d+ms$/);
  const before = await harness(t, 'COPY .env');
  await assert.rejects(runSetup(before.workspace, before.worktree, { ...before.deps, signal: AbortSignal.abort() }), { message: 'setup failed at line 1 (COPY .env): stopped' });
  assert.deepEqual([before.steps, before.output], [[], []], 'a step not yet started never runs');
});

test('needsSetup is false with no steps (no git) or once the marker is in the git dir, true otherwise; hasSetup reads the text only, and a text that does not parse counts, so its error reaches the user (#351)', async (t) => {
  const empty = await harness(t, '# nothing\n');
  assert.equal(await needsSetup(empty.workspace, empty.worktree, empty.deps.exec), false);
  assert.deepEqual(empty.git, [], 'no git without steps');
  const h = await harness(t, 'RUN pnpm install');
  assert.equal(await needsSetup(h.workspace, h.worktree, h.deps.exec), true);
  await writeFile(join(h.gitDir, SETUP_MARKER), '');
  assert.equal(await needsSetup(h.workspace, h.worktree, h.deps.exec), false);
  assert.deepEqual([hasSetup(h.workspace), hasSetup(empty.workspace), hasSetup({ ...h.workspace, setup: 'FROM node' })], [true, false, true]);
});

test('isSetUp is true only for a worktree folder already there whose marker is in its git dir: a missing folder asks no git, and git that names no git dir counts as not set up (#351)', async (t) => {
  const h = await harness(t, 'RUN pnpm install');
  assert.equal(await isSetUp(h.workspace, join(h.worktree, 'gone'), h.deps.exec), false);
  assert.deepEqual(h.git, [], 'no git for a folder that is not there');
  assert.equal(await isSetUp(h.workspace, h.worktree, h.deps.exec), false, 'marker missing');
  await writeFile(join(h.gitDir, SETUP_MARKER), '');
  assert.equal(await isSetUp(h.workspace, h.worktree, h.deps.exec), true);
  assert.equal(await isSetUp(h.workspace, h.worktree, async () => { throw new Error('fatal: not a git repository'); }), false);
});

test('runShell hands every chunk to onOutput as it comes; an abort kills the whole group and rejects with stopped; an aborted signal never starts it (#351)', async (t) => {
  const cwd = await tempDir(t, 'run-');
  const chunks: string[] = [];
  await runShell('/bin/sh', ['-c', 'echo one; echo two >&2'], { cwd, timeoutMs: 30_000, onOutput: (text) => chunks.push(text) });
  assert.deepEqual(chunks.join('').split('\n').filter(Boolean).sort(), ['one', 'two'], 'stdout and stderr, whole');
  const controller = new AbortController();
  const began = Date.now();
  const options = { cwd, timeoutMs: 30_000, signal: controller.signal, onOutput: () => controller.abort() }; // stopped once it printed
  const err = await runShell('/bin/sh', ['-c', 'echo started; sleep 30 & wait'], options).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof RunFailure, String(err));
  assert.deepEqual([err.code, err.message], ['stopped', 'stopped']);
  assert.ok(Date.now() - began < 10_000, 'the sleep sh started died with it');
  const never = await runShell('/bin/sh', ['-c', 'echo ran > ran.txt'], { cwd, timeoutMs: 30_000, signal: AbortSignal.abort() }).then(() => undefined, (e: unknown) => e);
  assert.ok(never instanceof RunFailure && never.code === 'stopped', String(never));
  await assert.rejects(access(join(cwd, 'ran.txt')), { code: 'ENOENT' });
});

test('runShell without timeoutMs arms no timer: a step that outlasts nothing still resolves (#511)', async (t) => {
  const cwd = await tempDir(t, 'run-');
  await runShell('/bin/sh', ['-c', 'sleep 0.2'], { cwd });
});
