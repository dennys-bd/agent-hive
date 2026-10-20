import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandLine, okLine } from '../src/console.js';
import { parseSetup, type SetupStep } from '../src/setup-script.js';
import type { Exec, Workspace } from '../src/types.js';
import { clipStep, type Phase, RunFailure, type RunShell, runShell, runSteps, type StepDeps, type StepReport, WORKTREE_NAME } from '../src/worktree-steps.js';
import { type AfterHost, tempDir } from './temp-dir.js';

interface Harness { workspace: Workspace; main: string; worktree: string; home: string; deps: StepDeps; output: string[] }

// The main checkout, the worktree and a home folder, each a temp folder; the steps run no git.
async function harness(t: AfterHost): Promise<Harness> {
  const [main, worktree, home] = await Promise.all([tempDir(t, 'main-'), tempDir(t, 'wt-'), tempDir(t, 'home-')]);
  const output: string[] = [];
  const exec: Exec = async () => assert.fail('the steps run no git');
  const deps: StepDeps = { exec, log: { info: () => undefined }, output: (text) => output.push(text), home };
  return { workspace: { name: 'hive', path: main, env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }, main, worktree, home, deps, output };
}

const setupPhase = (h: Harness): Phase => ({ name: 'setup', from: h.main, fromName: 'hive', to: h.worktree, toName: WORKTREE_NAME });
const teardownPhase = (h: Harness): Phase => ({ name: 'teardown', from: h.worktree, fromName: WORKTREE_NAME, to: h.main, toName: 'hive' });
const steps = (text: string): SetupStep[] => parseSetup(text, { allowLoad: true });

test('COPY dir/ copies the folder\'s contents into the destination folder, COPY dir copies the folder to the destination path, COPY file name renames, no destination is the same path; nothing at the destination is deleted (#654)', async (t) => {
  const h = await harness(t);
  await mkdir(join(h.main, 'docs', 'superpowers', 'specs'), { recursive: true });
  await writeFile(join(h.main, 'docs', 'superpowers', 'specs', 'a.md'), 'a');
  await writeFile(join(h.main, 'docs', 'superpowers', 'b.md'), 'b');
  await writeFile(join(h.main, '.env'), 'A=1\n');
  await mkdir(join(h.worktree, 'docs'));
  await writeFile(join(h.worktree, 'docs', 'keep.md'), 'k');
  await runSteps(setupPhase(h), h.workspace, h.worktree, steps('COPY docs/superpowers/ docs/\nCOPY docs/superpowers notes\nCOPY .env .env.local\nCOPY docs'), h.deps);
  assert.equal(await readFile(join(h.worktree, 'docs', 'specs', 'a.md'), 'utf8'), 'a', 'the contents, into docs/');
  assert.equal(await readFile(join(h.worktree, 'docs', 'b.md'), 'utf8'), 'b');
  assert.equal(await readFile(join(h.worktree, 'notes', 'specs', 'a.md'), 'utf8'), 'a', 'the folder itself, as notes');
  assert.equal(await readFile(join(h.worktree, '.env.local'), 'utf8'), 'A=1\n');
  assert.equal(await readFile(join(h.worktree, 'docs', 'superpowers', 'b.md'), 'utf8'), 'b', 'no destination: the same path');
  assert.equal(await readFile(join(h.worktree, 'docs', 'keep.md'), 'utf8'), 'k', 'nothing at the destination is deleted');
  await assert.rejects(runSteps(setupPhase(h), h.workspace, h.worktree, steps('COPY .env/'), h.deps), { message: 'setup failed at step 1 of 1 (line 1, COPY .env/): not a folder in hive' });
});

test('the teardown copies from the worktree into the main checkout; ~/ expands with the injected home and an absolute destination is written as it is (#654)', async (t) => {
  const h = await harness(t);
  await mkdir(join(h.worktree, 'out'));
  await writeFile(join(h.worktree, 'out', 'dump.sql'), 'x');
  const elsewhere = await tempDir(t, 'abs-');
  await runSteps(teardownPhase(h), h.workspace, h.worktree, steps(`COPY out/dump.sql\nCOPY out/ ~/saved/\nCOPY out/dump.sql ${elsewhere}/d.sql`), h.deps);
  assert.equal(await readFile(join(h.main, 'out', 'dump.sql'), 'utf8'), 'x', 'into the main checkout');
  assert.equal(await readFile(join(h.home, 'saved', 'dump.sql'), 'utf8'), 'x');
  assert.equal(await readFile(join(elsewhere, 'd.sql'), 'utf8'), 'x');
});

test('a relative destination through a symlinked folder is refused, and so is a teardown source that leads out of the worktree through a symlink; nothing is written (#654)', async (t) => {
  const h = await harness(t);
  const outside = await tempDir(t, 'outside-');
  await writeFile(join(h.worktree, 'notes.md'), 'n');
  await symlink(outside, join(h.main, 'docs'));
  await assert.rejects(runSteps(teardownPhase(h), h.workspace, h.worktree, steps('COPY notes.md docs/notes.md'), h.deps), { message: 'teardown failed at step 1 of 1 (line 1, COPY notes.md docs/notes.md): outside hive' });
  await assert.rejects(access(join(outside, 'notes.md')), { code: 'ENOENT' });
  await writeFile(join(outside, 'secret'), 's');
  await symlink(join(outside, 'secret'), join(h.worktree, 'leak'));
  await assert.rejects(runSteps(teardownPhase(h), h.workspace, h.worktree, steps('COPY leak'), h.deps), { message: 'teardown failed at step 1 of 1 (line 1, COPY leak): outside the worktree' });
  await assert.rejects(access(join(h.main, 'leak')), { code: 'ENOENT' });
});

test('a folder destination is checked through its last segment too: a committed symlink there is refused in both phases and nothing is written outside (#654)', async (t) => {
  const h = await harness(t);
  const outside = await tempDir(t, 'outside-');
  await mkdir(join(h.main, 'src'));
  await writeFile(join(h.main, 'src', 'a.md'), 'a');
  await mkdir(join(h.worktree, 'src'));
  await writeFile(join(h.worktree, 'src', 'a.md'), 'a');
  await mkdir(join(h.main, 'out'));
  await symlink(outside, join(h.main, 'out', 'link'));
  await mkdir(join(h.worktree, 'out'));
  await symlink(outside, join(h.worktree, 'out', 'link'));
  await assert.rejects(runSteps(teardownPhase(h), h.workspace, h.worktree, steps('COPY src/ out/link/'), h.deps), { message: 'teardown failed at step 1 of 1 (line 1, COPY src/ out/link/): outside hive' });
  await assert.rejects(runSteps(setupPhase(h), h.workspace, h.worktree, steps('COPY src/ out/link'), h.deps), { message: 'setup failed at step 1 of 1 (line 1, COPY src/ out/link): outside the worktree' });
  await assert.rejects(runSteps(setupPhase(h), h.workspace, h.worktree, steps('COPY src/a.md out/link/'), h.deps), { message: 'setup failed at step 1 of 1 (line 1, COPY src/a.md out/link/): outside the worktree' });
  await assert.rejects(access(join(outside, 'a.md')), { code: 'ENOENT' });
});

test('COPY file folder/ copies the file into that folder under its own name, creating the folder, under the home folder too (#654)', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.main, '.env'), 'A=1\n');
  await runSteps(setupPhase(h), h.workspace, h.worktree, steps('COPY .env conf/\nCOPY .env ~/dir/'), h.deps);
  assert.equal(await readFile(join(h.worktree, 'conf', '.env'), 'utf8'), 'A=1\n');
  assert.equal(await readFile(join(h.home, 'dir', '.env'), 'utf8'), 'A=1\n');
});

test('DEL removes a file and a folder with its files, counts a missing path as done, removes a symlink without following it (trailing / or not), and never deletes through a symlinked folder (#654)', async (t) => {
  const h = await harness(t);
  await mkdir(join(h.worktree, 'tmp', 'deep'), { recursive: true });
  await writeFile(join(h.worktree, 'tmp', 'a'), '');
  await writeFile(join(h.worktree, 'tmp', 'deep', 'b'), '');
  await writeFile(join(h.worktree, 'junk.log'), '');
  const kept = await tempDir(t, 'target-');
  await writeFile(join(kept, 'keep.md'), 'k');
  await symlink(kept, join(h.worktree, 'link'));
  await runSteps(teardownPhase(h), h.workspace, h.worktree, steps('DEL tmp/\nDEL junk.log\nDEL nope\nDEL link/'), h.deps);
  for (const gone of ['tmp', 'junk.log', 'link']) await assert.rejects(lstat(join(h.worktree, gone)), { code: 'ENOENT' }, gone);
  assert.equal(await readFile(join(kept, 'keep.md'), 'utf8'), 'k', 'the link went, its target stayed');
  await symlink(kept, join(h.worktree, 'via'));
  await assert.rejects(runSteps(setupPhase(h), h.workspace, h.worktree, steps('DEL via/keep.md'), h.deps), { message: 'setup failed at step 1 of 1 (line 1, DEL via/keep.md): outside the worktree' });
  assert.equal(await readFile(join(kept, 'keep.md'), 'utf8'), 'k');
});

const shownMs = (line: string): string => line.replace(/ok \d+ms/, 'ok Nms');

test('every step writes its header, its result line and ok with its time: COPY the files and where, DEL what went or that nothing was there (#654)', async (t) => {
  const h = await harness(t);
  await mkdir(join(h.main, 'docs'));
  for (const name of ['a.md', 'b.md']) await writeFile(join(h.main, 'docs', name), '');
  await mkdir(join(h.worktree, 'tmp'));
  for (const name of ['a', 'b']) await writeFile(join(h.worktree, 'tmp', name), '');
  await runSteps(setupPhase(h), h.workspace, h.worktree, steps('COPY docs/ notes/\nDEL tmp/\nDEL nope'), h.deps);
  assert.deepEqual(h.output.map(shownMs), [
    `${commandLine('> COPY docs/ notes/')}\n`, 'copied 2 files to notes/\n', `${okLine('ok Nms')}\n`,
    `${commandLine('> DEL tmp/')}\n`, 'deleted tmp/ (2 files)\n', `${okLine('ok Nms')}\n`,
    `${commandLine('> DEL nope')}\n`, 'nothing to delete: nope\n', `${okLine('ok Nms')}\n`,
  ]);
});

test('a teardown COPY never plants the worktree\'s symlinks in the main checkout (#654)', async (t) => {
  const h = await harness(t);
  await mkdir(join(h.worktree, 'reports'));
  await writeFile(join(h.worktree, 'reports', 'a.md'), 'a');
  await symlink(h.home, join(h.worktree, 'reports', 'link'));
  await runSteps(teardownPhase(h), h.workspace, h.worktree, steps('COPY reports/'), h.deps);
  assert.equal(await readFile(join(h.main, 'reports', 'a.md'), 'utf8'), 'a');
  await assert.rejects(lstat(join(h.main, 'reports', 'link')), { code: 'ENOENT' });
});

test('a COPY merging a folder into an existing destination symlink is refused, in both phases (#654)', async (t) => {
  const outside = await tempDir(t, 'outside-');
  const setup = await harness(t);
  await mkdir(join(setup.main, 'reports', 'link'), { recursive: true });
  await writeFile(join(setup.main, 'reports', 'link', 'x.md'), 'x');
  await mkdir(join(setup.worktree, 'reports'));
  await symlink(outside, join(setup.worktree, 'reports', 'link'));
  await assert.rejects(runSteps(setupPhase(setup), setup.workspace, setup.worktree, steps('COPY reports/'), setup.deps), { message: 'setup failed at step 1 of 1 (line 1, COPY reports/): outside the worktree' });
  const teardown = await harness(t);
  await mkdir(join(teardown.worktree, 'reports', 'link'), { recursive: true });
  await writeFile(join(teardown.worktree, 'reports', 'link', 'x.md'), 'x');
  await mkdir(join(teardown.main, 'reports'));
  await symlink(outside, join(teardown.main, 'reports', 'link'));
  await assert.rejects(runSteps(teardownPhase(teardown), teardown.workspace, teardown.worktree, steps('COPY reports/ reports/'), teardown.deps), { message: 'teardown failed at step 1 of 1 (line 1, COPY reports/ reports/): outside hive' });
  await assert.rejects(lstat(join(outside, 'x.md')), { code: 'ENOENT' });
});

test('each step reports its kind, its place in the run, its time and how it went, never the line (#742)', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.main, '.env'), 'A=1\n');
  const reports: StepReport[] = [];
  const failing: RunShell = async () => {
    throw new RunFailure(1, 'TOKEN=secret');
  };
  await assert.rejects(runSteps(setupPhase(h), h.workspace, h.worktree, steps('COPY .env\nRUN cat .env'), { ...h.deps, run: failing, onStepEnd: (report) => reports.push(report) }));
  assert.deepEqual(reports.map(({ durationMs: _ms, ...rest }) => rest), [{ kind: 'COPY', index: 0, ok: true }, { kind: 'RUN', index: 1, ok: false, code: 1 }]);
  assert.ok(reports.every((r) => Number.isInteger(r.durationMs) && r.durationMs >= 0));
});

test('a report callback that throws never replaces the step\'s own outcome: a failing step keeps its error, a good one still passes (#742)', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.main, '.env'), 'A=1\n');
  const onStepEnd = (): void => { throw new Error('report'); };
  assert.equal(await runSteps(setupPhase(h), h.workspace, h.worktree, steps('COPY .env'), { ...h.deps, onStepEnd }), 1);
  const failing: RunShell = async () => { throw new RunFailure(2, 'out'); };
  await assert.rejects(runSteps(setupPhase(h), h.workspace, h.worktree, steps('RUN false'), { ...h.deps, run: failing, onStepEnd }), { message: /^setup failed at step 1 of 1 \(line 1, RUN false\)/ });
});

test('a progress file that cannot be written never fails the setup: the step passed, the run goes on and only a resume is lost (#390)', async (t) => {
  const h = await harness(t);
  const ran: string[] = [];
  const recording: RunShell = async (_file, args) => { ran.push(String(args.at(-1))); };
  const resume = { skip: 0, passed: async (): Promise<void> => { throw new Error('EACCES'); } };
  assert.equal(await runSteps(setupPhase(h), h.workspace, h.worktree, steps('RUN a\nRUN b'), { ...h.deps, run: recording, resume }), 2);
  assert.equal(ran.length, 2);
});

test('a RUN step gets the Hive\'s env with the workspace\'s on top, and only the Hive\'s when the workspace sets none (#738)', async (t) => {
  const h = await harness(t);
  const seen: (NodeJS.ProcessEnv | undefined)[] = [];
  const recording: RunShell = async (_file, _args, options) => { seen.push(options.env); };
  const env = { GREETING: 'hi', PATH: '/ws/bin' };
  await runSteps(setupPhase(h), { ...h.workspace, env }, h.worktree, steps('RUN true'), { ...h.deps, run: recording });
  await runSteps(teardownPhase(h), h.workspace, h.worktree, steps('RUN true'), { ...h.deps, run: recording });
  assert.deepEqual(seen, [{ ...process.env, ...env }, { ...process.env }]);
});

test('runShell hands options.env to the child, never in its line, and the child inherits the Hive\'s env without it (#738)', async (t) => {
  const cwd = await tempDir(t, 'run-');
  const printed = async (line: string, env?: NodeJS.ProcessEnv): Promise<string> => {
    const chunks: string[] = [];
    await runShell('/bin/sh', ['-c', line], { cwd, onOutput: (text) => chunks.push(text), ...(env === undefined ? {} : { env }) });
    return chunks.join('');
  };
  assert.equal(await printed('printf %s "$HIVE_738_NAME"', { ...process.env, HIVE_738_NAME: 'from the workspace' }), 'from the workspace');
  assert.equal(await printed('printf %s "$PATH"'), process.env.PATH ?? '');
});

test('a RUN that exits with no output names its place, its line and its code in words, and hints at a line that hides its errors; a teardown says teardown (#267)', async (t) => {
  const h = await harness(t);
  const silent: RunShell = async () => { throw new RunFailure(128, ''); };
  await assert.rejects(runSteps(setupPhase(h), h.workspace, h.worktree, steps('RUN git worktree add . x 2>/dev/null\nRUN true'), { ...h.deps, run: silent }), {
    message: 'setup failed at step 1 of 2 (line 1, RUN git worktree add . x 2>/dev/null): the command exited with code 128 and printed nothing; if the line sends its errors to /dev/null, remove that to see why',
  });
  let ran = 0;
  const secondFails: RunShell = async () => { ran += 1; if (ran === 2) throw new RunFailure(3, 'Error: no such service'); };
  await assert.rejects(runSteps(teardownPhase(h), h.workspace, h.worktree, steps('RUN true\nRUN docker compose down'), { ...h.deps, run: secondFails }), {
    message: 'teardown failed at step 2 of 2 (line 2, RUN docker compose down): the command exited with code 3\nError: no such service',
  });
});

test('a step longer than 160 characters or 2 lines is cut with … in the failure, so a long setup line cannot bury the reason (#267)', async (t) => {
  assert.equal(clipStep('a\nb\nc'), 'a\nb…');
  assert.equal(clipStep('x'.repeat(160)), 'x'.repeat(160));
  assert.equal(clipStep('x'.repeat(161)), `${'x'.repeat(160)}…`);
  const h = await harness(t);
  const line = `RUN ${'x'.repeat(200)}`;
  const failing: RunShell = async () => { throw new RunFailure(1, 'boom'); };
  await assert.rejects(runSteps(setupPhase(h), h.workspace, h.worktree, steps(line), { ...h.deps, run: failing }), {
    message: `setup failed at step 1 of 1 (line 1, ${line.slice(0, 160)}…): the command exited with code 1\nboom`,
  });
});
