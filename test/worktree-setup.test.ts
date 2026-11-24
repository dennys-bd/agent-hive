import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandLine, okLine } from '../src/console.js';
import type { Machine, RunProcess } from '../src/machine.js';
import type { Exec, Workspace } from '../src/types.js';
import { HOST_PATHS } from './fake-machine.js';
import { hasSetup, isSetUp, needsSetup, runSetup, SETUP_MARKER, SETUP_PROGRESS, type SetupDeps, withReused } from '../src/worktree-setup.js';
import { fakeMachine, runResult } from './fakes.js';
import { tempDir, type AfterHost } from './temp-dir.js';

interface Harness {
  workspace: Workspace; worktree: string; gitDir: string; deps: SetupDeps; machine: Machine;
  git: string[][]; // every git argv after 'git'
  runs: { args: string[]; options: Pick<RunProcess, 'cwd' | 'timeoutMs'> }[]; // every RUN the fake shell received
  steps: string[]; // what onStep saw
  lines: string[]; // what the log got
  output: string[]; // what the console run got (#351)
}

// The main checkout, the worktree and its git dir, each a temp folder. git answers only the git dir; RUN goes to `run`, else a fake that
// records it and succeeds.
async function harness(t: AfterHost, setup: string, run?: Machine['run'], extra: Partial<Workspace> = {}): Promise<Harness> {
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
  const recorded: Machine['run'] = async (p) => {
    runs.push({ args: p.args, options: { cwd: p.cwd, timeoutMs: p.timeoutMs } });
    return runResult(0);
  };
  const machine = fakeMachine({ exec, run: run ?? recorded });
  const deps: SetupDeps = { log: { info: (line) => lines.push(line) }, onStep: (step) => steps.push(step), output: (text) => output.push(text) };
  return { workspace: { name: 'hive', path: repo, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)', setup, ...extra }, worktree, gitDir, deps, machine, git, runs, steps, lines, output };
}

const marked = (h: Harness): Promise<boolean> => access(join(h.gitDir, SETUP_MARKER)).then(() => true, () => false);

test('runSetup does nothing for an empty setup or one of comments only (no git, no marker), nor once the worktree\'s git dir has the marker (#299)', async (t) => {
  for (const setup of ['', '# later\n\n']) {
    const h = await harness(t, setup);
    await runSetup(h.machine, h.workspace, h.worktree, h.deps);
    assert.deepEqual([h.git, h.steps, await marked(h)], [[], [], false], JSON.stringify(setup));
  }
  const h = await harness(t, 'RUN pnpm install');
  await writeFile(join(h.gitDir, SETUP_MARKER), '');
  await runSetup(h.machine, h.workspace, h.worktree, h.deps);
  assert.deepEqual(h.git, [['-C', h.worktree, 'rev-parse', '--absolute-git-dir']]);
  assert.deepEqual([h.steps, h.runs], [[], []], 'set up already: a respawn or a Continue skips it');
});

test('runSetup runs the steps in order in the worktree: COPY copies a file and a folder from the main checkout, RUN goes to /bin/sh -c with the workspace\'s timeout; onStep sees each, the log names each without contents, and the marker comes last (#299)', async (t) => {
  const h = await harness(t, 'COPY .env\n# deps\nRUN pnpm install --frozen-lockfile\nCOPY config/local', undefined, { setupTimeout: '7m' });
  await writeFile(join(h.workspace.path, '.env'), 'TOKEN=secret\n');
  await mkdir(join(h.workspace.path, 'config', 'local', 'deep'), { recursive: true });
  await writeFile(join(h.workspace.path, 'config', 'local', 'deep', 'a.json'), '{}');
  await runSetup(h.machine, h.workspace, h.worktree, h.deps);
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
  await assert.rejects(runSetup(missing.machine, missing.workspace, missing.worktree, missing.deps), { message: 'setup failed at step 1 of 1 (line 1, COPY .env): not found in hive' });
  assert.equal(await marked(missing), false);
  const outside = await harness(t, 'RUN true\nCOPY .env');
  const elsewhere = await tempDir(t, 'outside-');
  await writeFile(join(elsewhere, 'secrets'), 'x');
  await symlink(join(elsewhere, 'secrets'), join(outside.workspace.path, '.env'));
  await assert.rejects(runSetup(outside.machine, outside.workspace, outside.worktree, outside.deps), { message: 'setup failed at step 2 of 2 (line 2, COPY .env): outside hive' });
  await assert.rejects(readFile(join(outside.worktree, '.env')), 'nothing was copied');
  assert.equal(await marked(outside), false);
});

test('a RUN that fails or times out stops the setup at its line: the reason and the output tail go to the error, only the code to the log, later steps never run and no marker is written (#299)', async (t) => {
  const seen: string[] = [];
  const failing: Machine['run'] = async (p) => {
    seen.push(`${p.args[1]} ${p.timeoutMs}`);
    return runResult(p.args[1] === 'pnpm test' ? 'timeout' : 1, 'npm ERR! TOKEN=secret\nnpm ERR! boom');
  };
  const h = await harness(t, 'RUN pnpm install\nCOPY .env', failing);
  await assert.rejects(runSetup(h.machine, h.workspace, h.worktree, h.deps), { message: 'setup failed at step 1 of 2 (line 1, RUN pnpm install): the command exited with code 1\nnpm ERR! TOKEN=secret\nnpm ERR! boom' });
  assert.deepEqual([seen, h.steps, await marked(h)], [['pnpm install undefined'], ['RUN pnpm install'], false], 'no setupTimeout, no limit (#511); the COPY never ran');
  assert.match(h.lines[0], /line 1: RUN pnpm install failed \(1\) \d+ms$/);
  assert.ok(!h.lines.join('\n').includes('secret'), 'a command\'s output never reaches the log');
  const slow = await harness(t, 'RUN pnpm test', failing, { setupTimeout: '90s' });
  await assert.rejects(runSetup(slow.machine, slow.workspace, slow.worktree, slow.deps), { message: 'setup failed at step 1 of 1 (line 1, RUN pnpm test): timed out after 90s\nnpm ERR! TOKEN=secret\nnpm ERR! boom' });
  assert.deepEqual(seen.at(-1), 'pnpm test 90000', 'setupTimeout reaches the shell as ms (#511)');
  assert.match(slow.lines[0], /failed \(timeout\) \d+ms$/);
});

test('LOAD expands the file\'s steps in place, read from the main checkout at every run; a LOAD inside it, a bad line or a missing file fails at the LOAD\'s line before any step runs (#299)', async (t) => {
  const h = await harness(t, 'COPY .env\nLOAD setup/worktree.hive\nRUN echo done');
  await writeFile(join(h.workspace.path, '.env'), 'A=1\n');
  await mkdir(join(h.workspace.path, 'setup'));
  await writeFile(join(h.workspace.path, 'setup', 'worktree.hive'), '# shared\nRUN pnpm install\nRUN pnpm build\n');
  await runSetup(h.machine, h.workspace, h.worktree, h.deps);
  assert.deepEqual(h.steps, ['COPY .env', 'RUN pnpm install', 'RUN pnpm build', 'RUN echo done']);
  const fails = async (file: string | undefined, message: string): Promise<void> => {
    const f = await harness(t, 'RUN true\nLOAD setup.hive');
    if (file !== undefined) await writeFile(join(f.workspace.path, 'setup.hive'), file);
    await assert.rejects(runSetup(f.machine, f.workspace, f.worktree, f.deps), { message });
    assert.deepEqual([f.steps, await marked(f)], [[], false], 'a LOAD is read before any step runs');
  };
  await fails('RUN a\nLOAD other.hive\n', 'setup failed at line 2 (LOAD setup.hive): line 2: LOAD cannot be used inside a loaded file');
  await fails('FROM node\n', 'setup failed at line 2 (LOAD setup.hive): line 1: unknown instruction (COPY, RUN, LOAD or DEL)'); // the loaded file's text is never echoed
  await fails(undefined, 'setup failed at line 2 (LOAD setup.hive): not found in hive');
});

// A RUN through the machine's real run (runDetached), the way runSetup reaches it; the failure is the step's reason, as the task shows it
const realRun = async (t: AfterHost, line: string, extra: Partial<Workspace> = {}, deps: Partial<SetupDeps> = {}): Promise<{ h: Harness; err: unknown }> => {
  const h = await harness(t, `RUN ${line}`, fakeMachine().run, extra);
  const err = await runSetup(h.machine, h.workspace, h.worktree, { ...h.deps, ...deps }).then(() => undefined, (e: unknown) => e);
  return { h, err };
};

test('a RUN runs the machine\'s shell in the worktree with stdin closed: exit 0 passes; a non-zero exit fails with its code and the last 20 lines of output, stderr included; a prompt fails at once (#299)', async (t) => {
  const ok = await realRun(t, 'echo ok > here.txt');
  assert.equal(ok.err, undefined);
  assert.equal(await readFile(join(ok.h.worktree, 'here.txt'), 'utf8'), 'ok\n', 'it ran in the worktree');
  const long = await realRun(t, 'for i in $(seq 1 30); do echo line $i; done; exit 3');
  assert.equal((long.err as Error).message, `setup failed at step 1 of 1 (line 1, RUN for i in $(seq 1 30); do echo line $i; done; exit 3): the command exited with code 3\n${Array.from({ length: 20 }, (_, i) => `line ${i + 11}`).join('\n')}`, 'the last 20 lines only');
  assert.match(((await realRun(t, 'echo oops >&2; exit 2')).err as Error).message, /code 2\noops$/);
  assert.match(((await realRun(t, 'read answer')).err as Error).message, /code 1/, 'stdin is closed: read gets EOF instead of waiting');
});

test('a RUN that outlives its timeout is killed with its whole process group and fails with timeout and the output so far (#299)', async (t) => {
  const began = Date.now(); // 2 s, not less: under the full suite's load sh may not have echoed yet
  const { err } = await realRun(t, 'echo started; sleep 30 & wait', { setupTimeout: '2s' });
  assert.equal((err as Error).message, 'setup failed at step 1 of 1 (line 1, RUN echo started; sleep 30 & wait): timed out after 2s\nstarted');
  assert.ok(Date.now() - began < 10_000, 'the sleep sh started died with it: its open stdout would otherwise hold the close for 30 s');
});

test('a COPY whose destination folder in the worktree is a symlink out of it fails and writes nothing outside the worktree (#299)', async (t) => {
  const h = await harness(t, 'COPY config/app.env');
  const outside = await tempDir(t, 'outside-');
  await mkdir(join(h.workspace.path, 'config'));
  await writeFile(join(h.workspace.path, 'config', 'app.env'), 'TOKEN=secret\n');
  await symlink(outside, join(h.worktree, 'config')); // a branch that committed config -> somewhere else
  await assert.rejects(runSetup(h.machine, h.workspace, h.worktree, h.deps), /^Error: setup failed at step 1 of 1 \(line 1, COPY config\/app.env\): outside the worktree$/);
  await assert.rejects(access(join(outside, 'app.env')), { code: 'ENOENT' });
  assert.equal(await marked(h), false);
});

test('a bad line in a LOADed file is refused without echoing the file\'s text, which may be a secret (#299)', async (t) => {
  const h = await harness(t, 'LOAD .env');
  await writeFile(join(h.workspace.path, '.env'), 'NPM_TOKEN=abc123\n');
  await assert.rejects(runSetup(h.machine, h.workspace, h.worktree, h.deps), (err: Error) => !err.message.includes('abc123') && /line 1: unknown instruction/.test(err.message));
});

test('a RUN keeps a bounded tail of output that has no newlines (#299)', async (t) => {
  const { err } = await realRun(t, 'head -c 200000 /dev/zero | tr "\\0" x; exit 3');
  const tail = (err as Error).message.split('\n')[1] ?? '';
  assert.match((err as Error).message, /code 3\n/);
  assert.ok(tail.length > 0 && tail.length <= 8192, `tail of ${tail.length} chars`);
});

test('runSetup writes a header line per step to output and hands it a RUN\'s output as it comes, never to the log; nothing when there is nothing to run (#351)', async (t) => {
  const talking: Machine['run'] = async (p) => {
    p.onOutput?.('added 12 packages\n');
    return runResult(0);
  };
  const h = await harness(t, 'COPY .env\nRUN pnpm install', talking);
  await writeFile(join(h.workspace.path, '.env'), 'A=1\n');
  assert.equal(await runSetup(h.machine, h.workspace, h.worktree, h.deps), 2);
  const shownMs = (line: string): string => line.replace(/ok \d+ms/, 'ok Nms');
  assert.deepEqual(h.output.map(shownMs), [
    `${commandLine('> COPY .env')}\n`, 'copied 1 files to .env\n', `${okLine('ok Nms')}\n`,
    `${commandLine('> RUN pnpm install')}\n`, 'added 12 packages\n', `${okLine('ok Nms')}\n`,
  ]);
  assert.ok(h.lines.every((l) => !l.includes('added')), 'the output never reaches the log');
  const none = await harness(t, '# later\n');
  await runSetup(none.machine, none.workspace, none.worktree, none.deps);
  assert.deepEqual(none.output, []);
});

test('an abort fails the running RUN with stopped, and a step not yet started fails with stopped before it runs; no marker is written (#351)', async (t) => {
  const controller = new AbortController();
  const stoppedMidway: Machine['run'] = async (p) => {
    assert.equal(p.signal, controller.signal, 'the signal reaches the RUN');
    controller.abort(); // a Stop on the task while the step runs; the machine's run then answers as below
    return runResult('stopped');
  };
  const h = await harness(t, 'RUN pnpm install\nCOPY .env', stoppedMidway);
  await assert.rejects(runSetup(h.machine, h.workspace, h.worktree, { ...h.deps, signal: controller.signal }), { message: 'setup failed at step 1 of 2 (line 1, RUN pnpm install): stopped' });
  assert.deepEqual([h.steps, await marked(h)], [['RUN pnpm install'], false]);
  assert.match(h.lines[0], /line 1: RUN pnpm install failed \(stopped\) \d+ms$/);
  const before = await harness(t, 'COPY .env');
  await assert.rejects(runSetup(before.machine, before.workspace, before.worktree, { ...before.deps, signal: AbortSignal.abort() }), { message: 'setup failed at step 1 of 1 (line 1, COPY .env): stopped' });
  assert.deepEqual([before.steps, before.output], [[], []], 'a step not yet started never runs');
});

test('needsSetup is false with no steps (no git) or once the marker is in the git dir, true otherwise; hasSetup reads the text only, and a text that does not parse counts, so its error reaches the user (#351)', async (t) => {
  const empty = await harness(t, '# nothing\n');
  assert.equal(await needsSetup(empty.machine, empty.workspace, empty.worktree), false);
  assert.deepEqual(empty.git, [], 'no git without steps');
  const h = await harness(t, 'RUN pnpm install');
  assert.equal(await needsSetup(h.machine, h.workspace, h.worktree), true);
  await writeFile(join(h.gitDir, SETUP_MARKER), '');
  assert.equal(await needsSetup(h.machine, h.workspace, h.worktree), false);
  assert.deepEqual([hasSetup(h.workspace, HOST_PATHS), hasSetup(empty.workspace, HOST_PATHS), hasSetup({ ...h.workspace, setup: 'FROM node' }, HOST_PATHS)], [true, false, true]);
});

test('isSetUp is true only for a worktree folder already there whose marker is in its git dir: a missing folder asks no git, and git that names no git dir counts as not set up (#351)', async (t) => {
  const h = await harness(t, 'RUN pnpm install');
  assert.equal(await isSetUp(h.machine, h.workspace, join(h.worktree, 'gone')), false);
  assert.deepEqual(h.git, [], 'no git for a folder that is not there');
  assert.equal(await isSetUp(h.machine, h.workspace, h.worktree), false, 'marker missing');
  await writeFile(join(h.gitDir, SETUP_MARKER), '');
  assert.equal(await isSetUp(h.machine, h.workspace, h.worktree), true);
  const notGit = fakeMachine({ exec: async () => { throw new Error('fatal: not a git repository'); } });
  assert.equal(await isSetUp(notGit, h.workspace, h.worktree), false);
});

test('a RUN hands every chunk to the console as it comes; an abort kills the whole group and fails with stopped; an aborted signal never starts it (#351)', async (t) => {
  const both = await realRun(t, 'echo one; echo two >&2');
  assert.deepEqual(both.h.output.join('').split(/\r?\n/).filter((l) => l === 'one' || l === 'two').sort(), ['one', 'two'], 'stdout and stderr, whole');
  const controller = new AbortController();
  const began = Date.now();
  const stopped = await realRun(t, 'echo started; sleep 30 & wait', {}, { signal: controller.signal, output: () => controller.abort() }); // stopped once it printed
  assert.match((stopped.err as Error).message, /: stopped$/);
  assert.ok(Date.now() - began < 10_000, 'the sleep sh started died with it');
  const never = await realRun(t, 'echo ran > ran.txt', {}, { signal: AbortSignal.abort() });
  assert.match((never.err as Error).message, /: stopped$/);
  await assert.rejects(access(join(never.h.worktree, 'ran.txt')), { code: 'ENOENT' });
});

test('a RUN without a timeout arms no timer: a step that outlasts nothing still resolves (#511)', async (t) => {
  assert.equal((await realRun(t, 'sleep 0.2')).err, undefined);
});

test('a setup that fails at its third step records two done; the next run skips them and starts at the third, its reports counting the skipped ones; success writes the marker and removes the record (#390)', async (t) => {
  let isFailing = true;
  const run: Machine['run'] = async (p) => (isFailing && p.args[1] === 'three' ? runResult(1) : runResult(0));
  const h = await harness(t, 'RUN one\nRUN two\nRUN three\nRUN four', run);
  const plans: [string[], number][] = [];
  const reports: number[] = [];
  const deps: SetupDeps = { ...h.deps, onPlan: (steps, skipped) => plans.push([steps, skipped]), onStepEnd: (report) => reports.push(report.index) };
  await assert.rejects(runSetup(h.machine, h.workspace, h.worktree, deps), { message: /^setup failed at step 3 of 4 \(line 3, RUN three\)/ });
  const record = JSON.parse(await readFile(join(h.gitDir, SETUP_PROGRESS), 'utf8')) as { steps: string; done: number };
  assert.equal(record.done, 2);
  assert.match(record.steps, /^[0-9a-f]{64}$/);
  isFailing = false;
  assert.equal(await runSetup(h.machine, h.workspace, h.worktree, deps), 2, 'two steps ran');
  assert.deepEqual(h.steps.slice(3), ['RUN three', 'RUN four']);
  assert.deepEqual(reports, [0, 1, 2, 2, 3], 'index counts the skipped steps');
  assert.deepEqual(plans, [[['RUN one', 'RUN two', 'RUN three', 'RUN four'], 0], [['RUN one', 'RUN two', 'RUN three', 'RUN four'], 2]]);
  assert.equal(await marked(h), true);
  await assert.rejects(access(join(h.gitDir, SETUP_PROGRESS)), { code: 'ENOENT' });
});

test('a setup edited since the failure, or a record that does not read, starts again from its first step (#390)', async (t) => {
  const failing: Machine['run'] = async (p) => (p.args[1] === 'three' ? runResult(1) : runResult(0));
  const h = await harness(t, 'RUN one\nRUN two\nRUN three', failing);
  await assert.rejects(runSetup(h.machine, h.workspace, h.worktree, h.deps));
  const edited = { ...h.workspace, setup: 'RUN one\nRUN 2\nRUN three' };
  await assert.rejects(runSetup(h.machine, edited, h.worktree, h.deps));
  assert.deepEqual(h.steps.slice(3), ['RUN one', 'RUN 2', 'RUN three'], 'another list: from the first step');
  await writeFile(join(h.gitDir, SETUP_PROGRESS), 'not json');
  await assert.rejects(runSetup(h.machine, edited, h.worktree, h.deps));
  assert.deepEqual(h.steps.slice(6), ['RUN one', 'RUN 2', 'RUN three']);
});

test('withReused adds the reused branch to a failed setup\'s reason, and leaves the error as it is when the branch was made (#267)', () => {
  const err = new Error('setup failed at step 1 of 1 (line 1, RUN x): the command exited with code 1');
  assert.equal((withReused(err, 'hive/7-fix') as Error).message, `${err.message}\nThe worktree reused the existing branch hive/7-fix.`);
  assert.equal(withReused(err, undefined), err);
});
