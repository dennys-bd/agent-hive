import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { commandLine, okLine } from '../src/console.js';
import type { RunProcess } from '../src/machine.js';
import { posixShellEnv } from '../src/posix-shell.js';
import { clipStep, runSteps, type StepReport } from '../src/worktree-steps.js';
import { fakeMachine, runResult } from './fakes.js';
import { gone, isAlive } from './process-probe.js';
import { tempDir } from './temp-dir.js';
import { setupPhase, stepHarness, steps, teardownPhase } from './worktree-fakes.js';

test('DEL removes a file and a folder with its files, counts a missing path as done, removes a symlink without following it (trailing / or not), and never deletes through a symlinked folder (#654)', async (t) => {
  const h = await stepHarness(t);
  await mkdir(join(h.worktree, 'tmp', 'deep'), { recursive: true });
  await writeFile(join(h.worktree, 'tmp', 'a'), '');
  await writeFile(join(h.worktree, 'tmp', 'deep', 'b'), '');
  await writeFile(join(h.worktree, 'junk.log'), '');
  const kept = await tempDir(t, 'target-');
  await writeFile(join(kept, 'keep.md'), 'k');
  await symlink(kept, join(h.worktree, 'link'));
  await runSteps(h.machine, teardownPhase(h), h.workspace, h.worktree, steps('DEL tmp/\nDEL junk.log\nDEL nope\nDEL link/'), h.deps);
  for (const gone of ['tmp', 'junk.log', 'link']) await assert.rejects(lstat(join(h.worktree, gone)), { code: 'ENOENT' }, gone);
  assert.equal(await readFile(join(kept, 'keep.md'), 'utf8'), 'k', 'the link went, its target stayed');
  await symlink(kept, join(h.worktree, 'via'));
  await assert.rejects(runSteps(h.machine, setupPhase(h), h.workspace, h.worktree, steps('DEL via/keep.md'), h.deps), { message: 'setup failed at step 1 of 1 (line 1, DEL via/keep.md): outside the worktree' });
  assert.equal(await readFile(join(kept, 'keep.md'), 'utf8'), 'k');
});

const shownMs = (line: string): string => line.replace(/ok \d+ms/, 'ok Nms');

test('every step writes its header, its result line and ok with its time: COPY the files and where, DEL what went or that nothing was there (#654)', async (t) => {
  const h = await stepHarness(t);
  await mkdir(join(h.main, 'docs'));
  for (const name of ['a.md', 'b.md']) await writeFile(join(h.main, 'docs', name), '');
  await mkdir(join(h.worktree, 'tmp'));
  for (const name of ['a', 'b']) await writeFile(join(h.worktree, 'tmp', name), '');
  await runSteps(h.machine, setupPhase(h), h.workspace, h.worktree, steps('COPY docs/ notes/\nDEL tmp/\nDEL nope'), h.deps);
  assert.deepEqual(h.output.map(shownMs), [
    `${commandLine('> COPY docs/ notes/')}\n`, 'copied 2 files to notes/\n', `${okLine('ok Nms')}\n`,
    `${commandLine('> DEL tmp/')}\n`, 'deleted tmp/ (2 files)\n', `${okLine('ok Nms')}\n`,
    `${commandLine('> DEL nope')}\n`, 'nothing to delete: nope\n', `${okLine('ok Nms')}\n`,
  ]);
});

test('each step reports its kind, its place in the run, its time and how it went, never the line (#742)', async (t) => {
  const h = await stepHarness(t);
  await writeFile(join(h.main, '.env'), 'A=1\n');
  const reports: StepReport[] = [];
  const failing = fakeMachine({ run: async () => runResult(1, 'TOKEN=secret') });
  await assert.rejects(runSteps(failing, setupPhase(h), h.workspace, h.worktree, steps('COPY .env\nRUN cat .env'), { ...h.deps, onStepEnd: (report) => reports.push(report) }));
  assert.deepEqual(reports.map(({ durationMs: _ms, ...rest }) => rest), [{ kind: 'COPY', index: 0, ok: true }, { kind: 'RUN', index: 1, ok: false, code: 1 }]);
  assert.ok(reports.every((r) => Number.isInteger(r.durationMs) && r.durationMs >= 0));
});

test('a report callback that throws never replaces the step\'s own outcome: a failing step keeps its error, a good one still passes (#742)', async (t) => {
  const h = await stepHarness(t);
  await writeFile(join(h.main, '.env'), 'A=1\n');
  const onStepEnd = (): void => { throw new Error('report'); };
  assert.equal(await runSteps(h.machine, setupPhase(h), h.workspace, h.worktree, steps('COPY .env'), { ...h.deps, onStepEnd }), 1);
  const failing = fakeMachine({ run: async () => runResult(2, 'out') });
  await assert.rejects(runSteps(failing, setupPhase(h), h.workspace, h.worktree, steps('RUN false'), { ...h.deps, onStepEnd }), { message: /^setup failed at step 1 of 1 \(line 1, RUN false\)/ });
});

test('a progress file that cannot be written never fails the setup: the step passed, the run goes on and only a resume is lost (#390)', async (t) => {
  const h = await stepHarness(t);
  const ran: string[] = [];
  const recording = fakeMachine({ run: async (p) => { ran.push(String(p.args.at(-1))); return runResult(0); } });
  const resume = { skip: 0, passed: async (): Promise<void> => { throw new Error('EACCES'); } };
  assert.equal(await runSteps(recording, setupPhase(h), h.workspace, h.worktree, steps('RUN a\nRUN b'), { ...h.deps, resume }), 2);
  assert.equal(ran.length, 2);
});

test('a RUN step gets the Hive\'s env with the workspace\'s on top, and only the Hive\'s when the workspace sets none (#738)', async (t) => {
  const h = await stepHarness(t);
  const seen: (NodeJS.ProcessEnv | undefined)[] = [];
  const recording = fakeMachine({ run: async (p) => { seen.push(p.env); return runResult(0); } });
  const env = { GREETING: 'hi', PATH: '/ws/bin' };
  await runSteps(recording, setupPhase(h), { ...h.workspace, env }, h.worktree, steps('RUN true'), h.deps);
  await runSteps(recording, teardownPhase(h), h.workspace, h.worktree, steps('RUN true'), h.deps);
  const own = posixShellEnv(process.platform); // #631: {} off win32
  assert.deepEqual(seen, [{ ...process.env, ...own, ...env }, { ...process.env, ...own }]);
});

test('a RUN hands the workspace\'s env to the child, never in its line, and the child inherits the Hive\'s env without it (#738)', async (t) => {
  const h = await stepHarness(t);
  const real = fakeMachine(); // the real runDetached
  const printed = async (line: string, env: Record<string, string> = {}): Promise<string> => {
    const before = h.output.length;
    await runSteps(real, setupPhase(h), { ...h.workspace, env }, h.worktree, steps(`RUN ${line}`), h.deps);
    return h.output.slice(before).join('');
  };
  assert.ok((await printed('printf %s "$HIVE_738_NAME"', { HIVE_738_NAME: 'from the workspace' })).includes('from the workspace'));
  // not $PATH: MSYS rewrites it into its own /c/… form on Windows
  process.env.HIVE_738_INHERITED = 'from the Hive';
  t.after(async () => { delete process.env.HIVE_738_INHERITED; });
  assert.ok((await printed('printf %s "$HIVE_738_INHERITED"')).includes('from the Hive'));
});

// long enough for node to start and write pids.json on a loaded machine or the Windows runner; shorter flaked with ENOENT
const RUN_TREE_TIMEOUT_MS = 12_000;
test('a RUN step that passes its timeout leaves no process of its tree: the node its line started and that node\'s own child are both gone (#637)', { timeout: 60_000 }, async (t) => {
  const h = await stepHarness(t);
  const pids = join(h.worktree, 'pids.json');
  // a failed assertion must not leave the pair idling: these are the test's own pids, killed only while alive
  t.after(async () => {
    const written = await readFile(pids, 'utf8').then((text) => JSON.parse(text) as number[], () => []);
    for (const pid of written.filter(isAlive)) process.kill(pid, 'SIGKILL');
  });
  // node, not sleep: $! in Git's sh is an MSYS pid, while process.pid is the one taskkill and process.kill know. Written whole (tmp + rename),
  // so the test never reads half a file.
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { renameSync, writeFileSync } = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "writeFileSync(process.env.HIVE_637_PIDS + '.tmp', JSON.stringify([process.pid, g.pid]));",
    "renameSync(process.env.HIVE_637_PIDS + '.tmp', process.env.HIVE_637_PIDS);",
    'setInterval(() => {}, 1000);',
  ].join(' ');
  // through the env, never the line: the paths stay out of the shell's quoting on every OS
  const workspace = { ...h.workspace, env: { HIVE_637_NODE: process.execPath, HIVE_637_SCRIPT: script, HIVE_637_PIDS: pids } };
  const phase = { ...setupPhase(h), timeout: `${RUN_TREE_TIMEOUT_MS / 1000}s` };
  const err = await runSteps(fakeMachine(), phase, workspace, h.worktree, steps('RUN "$HIVE_637_NODE" -e "$HIVE_637_SCRIPT"'), h.deps).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof Error && err.message.includes('timed out after'), String(err));
  const [child, grandchild] = JSON.parse(await readFile(pids, 'utf8')) as [number, number];
  assert.equal(await gone(child), true, 'the node the line started');
  assert.equal(await gone(grandchild), true, 'the node it started in turn');
});

test('on the Windows lane: a RUN step goes through the real machine run and Git\'s sh.exe with System32 ahead of Git on PATH; its output and a non-zero exit code come back (#631)', { skip: process.platform !== 'win32' }, async (t) => {
  const saved = process.env.PATH ?? '';
  process.env.PATH = `${win32.join(process.env.SystemRoot ?? assert.fail('no SystemRoot'), 'System32')};${saved}`;
  t.after(async () => { process.env.PATH = saved; });
  const h = await stepHarness(t);
  await runSteps(fakeMachine(), setupPhase(h), h.workspace, h.worktree, steps('RUN printf %s hi'), h.deps);
  assert.ok(h.output.join('').includes('hi'), h.output.join(''));
  await assert.rejects(runSteps(fakeMachine(), setupPhase(h), h.workspace, h.worktree, steps('RUN printf partial; exit 3'), h.deps), {
    message: 'setup failed at step 1 of 1 (line 1, RUN printf partial; exit 3): the command exited with code 3\npartial',
  });
});

test('a RUN that exits with no output names its place, its line and its code in words, and hints at a line that hides its errors; a teardown says teardown (#267)', async (t) => {
  const h = await stepHarness(t);
  const silent = fakeMachine({ run: async () => runResult(128) });
  await assert.rejects(runSteps(silent, setupPhase(h), h.workspace, h.worktree, steps('RUN git worktree add . x 2>/dev/null\nRUN true'), h.deps), {
    message: 'setup failed at step 1 of 2 (line 1, RUN git worktree add . x 2>/dev/null): the command exited with code 128 and printed nothing; if the line sends its errors to /dev/null, remove that to see why',
  });
  let ran = 0;
  const secondFails = fakeMachine({ run: async () => { ran += 1; return ran === 2 ? runResult(3, 'Error: no such service') : runResult(0); } });
  await assert.rejects(runSteps(secondFails, teardownPhase(h), h.workspace, h.worktree, steps('RUN true\nRUN docker compose down'), h.deps), {
    message: 'teardown failed at step 2 of 2 (line 2, RUN docker compose down): the command exited with code 3\nError: no such service',
  });
});

test('a step longer than 160 characters or 2 lines is cut with … in the failure, so a long setup line cannot bury the reason (#267)', async (t) => {
  assert.equal(clipStep('a\nb\nc'), 'a\nb…');
  assert.equal(clipStep('x'.repeat(160)), 'x'.repeat(160));
  assert.equal(clipStep('x'.repeat(161)), `${'x'.repeat(160)}…`);
  const h = await stepHarness(t);
  const line = `RUN ${'x'.repeat(200)}`;
  const failing = fakeMachine({ run: async () => runResult(1, 'boom') });
  await assert.rejects(runSteps(failing, setupPhase(h), h.workspace, h.worktree, steps(line), h.deps), {
    message: `setup failed at step 1 of 1 (line 1, ${line.slice(0, 160)}…): the command exited with code 1\nboom`,
  });
});

test('a RUN step runs its line through the machine\'s run with the machine\'s shell in the worktree, and its output reaches the console (#159)', async (t) => {
  const h = await stepHarness(t);
  const seen: RunProcess[] = [];
  const machine = fakeMachine({ info: { shell: 'machine-sh' }, run: async (p) => { seen.push(p); p.onOutput?.('built\n'); return runResult(0); } });
  await runSteps(machine, setupPhase(h), h.workspace, h.worktree, steps('RUN pnpm build'), h.deps);
  assert.deepEqual([seen[0]?.command, seen[0]?.args, seen[0]?.cwd], ['machine-sh', ['-c', 'pnpm build'], h.worktree]);
  assert.ok(h.output.join('').includes('built\n'), 'the console run gets the output live');
});

test('a RUN the machine could not start fails with the machine\'s words; a timeout keeps its code for the Start dialog (#159)', async (t) => {
  const h = await stepHarness(t);
  const missing = fakeMachine({ run: async () => ({ code: 'ENOENT', stdout: Buffer.alloc(0), stderr: '', tail: '', failure: 'machine-sh not found' }) });
  await assert.rejects(runSteps(missing, setupPhase(h), h.workspace, h.worktree, steps('RUN true'), h.deps), { message: /: machine-sh not found$/ });
  const reports: StepReport[] = [];
  const late = fakeMachine({ run: async () => runResult('timeout', 'slow') });
  await assert.rejects(runSteps(late, { ...setupPhase(h), timeout: '5m' }, h.workspace, h.worktree, steps('RUN sleep 600'), { ...h.deps, onStepEnd: (r) => reports.push(r) }), { message: /timed out after 5m\nslow$/ });
  assert.equal(reports[0]?.code, 'timeout');
});
