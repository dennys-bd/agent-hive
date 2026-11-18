import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runSteps } from '../src/worktree-steps.js';
import { fakeMachine } from './fakes.js';
import { tempDir } from './temp-dir.js';
import { setupPhase, stepHarness, steps, teardownPhase } from './worktree-fakes.js';

test('COPY dir/ copies the folder\'s contents into the destination folder, COPY dir copies the folder to the destination path, COPY file name renames, no destination is the same path; nothing at the destination is deleted (#654)', async (t) => {
  const h = await stepHarness(t);
  await mkdir(join(h.main, 'docs', 'superpowers', 'specs'), { recursive: true });
  await writeFile(join(h.main, 'docs', 'superpowers', 'specs', 'a.md'), 'a');
  await writeFile(join(h.main, 'docs', 'superpowers', 'b.md'), 'b');
  await writeFile(join(h.main, '.env'), 'A=1\n');
  await mkdir(join(h.worktree, 'docs'));
  await writeFile(join(h.worktree, 'docs', 'keep.md'), 'k');
  await runSteps(h.machine, setupPhase(h), h.workspace, h.worktree, steps('COPY docs/superpowers/ docs/\nCOPY docs/superpowers notes\nCOPY .env .env.local\nCOPY docs'), h.deps);
  assert.equal(await readFile(join(h.worktree, 'docs', 'specs', 'a.md'), 'utf8'), 'a', 'the contents, into docs/');
  assert.equal(await readFile(join(h.worktree, 'docs', 'b.md'), 'utf8'), 'b');
  assert.equal(await readFile(join(h.worktree, 'notes', 'specs', 'a.md'), 'utf8'), 'a', 'the folder itself, as notes');
  assert.equal(await readFile(join(h.worktree, '.env.local'), 'utf8'), 'A=1\n');
  assert.equal(await readFile(join(h.worktree, 'docs', 'superpowers', 'b.md'), 'utf8'), 'b', 'no destination: the same path');
  assert.equal(await readFile(join(h.worktree, 'docs', 'keep.md'), 'utf8'), 'k', 'nothing at the destination is deleted');
  await assert.rejects(runSteps(h.machine, setupPhase(h), h.workspace, h.worktree, steps('COPY .env/'), h.deps), { message: 'setup failed at step 1 of 1 (line 1, COPY .env/): not a folder in hive' });
});

test('the teardown copies from the worktree into the main checkout; ~/ expands with the injected home and an absolute destination is written as it is (#654)', async (t) => {
  const h = await stepHarness(t);
  await mkdir(join(h.worktree, 'out'));
  await writeFile(join(h.worktree, 'out', 'dump.sql'), 'x');
  const elsewhere = await tempDir(t, 'abs-');
  await runSteps(h.machine, teardownPhase(h), h.workspace, h.worktree, steps(`COPY out/dump.sql\nCOPY out/ ~/saved/\nCOPY out/dump.sql ${elsewhere}/d.sql`), h.deps);
  assert.equal(await readFile(join(h.main, 'out', 'dump.sql'), 'utf8'), 'x', 'into the main checkout');
  assert.equal(await readFile(join(h.home, 'saved', 'dump.sql'), 'utf8'), 'x');
  assert.equal(await readFile(join(elsewhere, 'd.sql'), 'utf8'), 'x');
});

test('a relative destination through a symlinked folder is refused, and so is a teardown source that leads out of the worktree through a symlink; nothing is written (#654)', async (t) => {
  const h = await stepHarness(t);
  const outside = await tempDir(t, 'outside-');
  await writeFile(join(h.worktree, 'notes.md'), 'n');
  await symlink(outside, join(h.main, 'docs'));
  await assert.rejects(runSteps(h.machine, teardownPhase(h), h.workspace, h.worktree, steps('COPY notes.md docs/notes.md'), h.deps), { message: 'teardown failed at step 1 of 1 (line 1, COPY notes.md docs/notes.md): outside hive' });
  await assert.rejects(access(join(outside, 'notes.md')), { code: 'ENOENT' });
  await writeFile(join(outside, 'secret'), 's');
  await symlink(join(outside, 'secret'), join(h.worktree, 'leak'));
  await assert.rejects(runSteps(h.machine, teardownPhase(h), h.workspace, h.worktree, steps('COPY leak'), h.deps), { message: 'teardown failed at step 1 of 1 (line 1, COPY leak): outside the worktree' });
  await assert.rejects(access(join(h.main, 'leak')), { code: 'ENOENT' });
});

test('a folder destination is checked through its last segment too: a committed symlink there is refused in both phases and nothing is written outside (#654)', async (t) => {
  const h = await stepHarness(t);
  const outside = await tempDir(t, 'outside-');
  await mkdir(join(h.main, 'src'));
  await writeFile(join(h.main, 'src', 'a.md'), 'a');
  await mkdir(join(h.worktree, 'src'));
  await writeFile(join(h.worktree, 'src', 'a.md'), 'a');
  await mkdir(join(h.main, 'out'));
  await symlink(outside, join(h.main, 'out', 'link'));
  await mkdir(join(h.worktree, 'out'));
  await symlink(outside, join(h.worktree, 'out', 'link'));
  await assert.rejects(runSteps(h.machine, teardownPhase(h), h.workspace, h.worktree, steps('COPY src/ out/link/'), h.deps), { message: 'teardown failed at step 1 of 1 (line 1, COPY src/ out/link/): outside hive' });
  await assert.rejects(runSteps(h.machine, setupPhase(h), h.workspace, h.worktree, steps('COPY src/ out/link'), h.deps), { message: 'setup failed at step 1 of 1 (line 1, COPY src/ out/link): outside the worktree' });
  await assert.rejects(runSteps(h.machine, setupPhase(h), h.workspace, h.worktree, steps('COPY src/a.md out/link/'), h.deps), { message: 'setup failed at step 1 of 1 (line 1, COPY src/a.md out/link/): outside the worktree' });
  await assert.rejects(access(join(outside, 'a.md')), { code: 'ENOENT' });
});

test('COPY file folder/ copies the file into that folder under its own name, creating the folder, under the home folder too (#654)', async (t) => {
  const h = await stepHarness(t);
  await writeFile(join(h.main, '.env'), 'A=1\n');
  await runSteps(h.machine, setupPhase(h), h.workspace, h.worktree, steps('COPY .env conf/\nCOPY .env ~/dir/'), h.deps);
  assert.equal(await readFile(join(h.worktree, 'conf', '.env'), 'utf8'), 'A=1\n');
  assert.equal(await readFile(join(h.home, 'dir', '.env'), 'utf8'), 'A=1\n');
});

test('a teardown COPY never plants the worktree\'s symlinks in the main checkout (#654)', async (t) => {
  const h = await stepHarness(t);
  await mkdir(join(h.worktree, 'reports'));
  await writeFile(join(h.worktree, 'reports', 'a.md'), 'a');
  await symlink(h.home, join(h.worktree, 'reports', 'link'));
  await runSteps(h.machine, teardownPhase(h), h.workspace, h.worktree, steps('COPY reports/'), h.deps);
  assert.equal(await readFile(join(h.main, 'reports', 'a.md'), 'utf8'), 'a');
  await assert.rejects(lstat(join(h.main, 'reports', 'link')), { code: 'ENOENT' });
});

test('a COPY merging a folder into an existing destination symlink is refused, in both phases (#654)', async (t) => {
  const outside = await tempDir(t, 'outside-');
  const setup = await stepHarness(t);
  await mkdir(join(setup.main, 'reports', 'link'), { recursive: true });
  await writeFile(join(setup.main, 'reports', 'link', 'x.md'), 'x');
  await mkdir(join(setup.worktree, 'reports'));
  await symlink(outside, join(setup.worktree, 'reports', 'link'));
  await assert.rejects(runSteps(setup.machine, setupPhase(setup), setup.workspace, setup.worktree, steps('COPY reports/'), setup.deps), { message: 'setup failed at step 1 of 1 (line 1, COPY reports/): outside the worktree' });
  const teardown = await stepHarness(t);
  await mkdir(join(teardown.worktree, 'reports', 'link'), { recursive: true });
  await writeFile(join(teardown.worktree, 'reports', 'link', 'x.md'), 'x');
  await mkdir(join(teardown.main, 'reports'));
  await symlink(outside, join(teardown.main, 'reports', 'link'));
  await assert.rejects(runSteps(teardown.machine, teardownPhase(teardown), teardown.workspace, teardown.worktree, steps('COPY reports/ reports/'), teardown.deps), { message: 'teardown failed at step 1 of 1 (line 1, COPY reports/ reports/): outside hive' });
  await assert.rejects(lstat(join(outside, 'x.md')), { code: 'ENOENT' });
});

test('a ~/ destination resolves against the machine\'s home, never the host\'s (#159)', async (t) => {
  const h = await stepHarness(t);
  const machineHome = await tempDir(t, 'machine-home-');
  await writeFile(join(h.worktree, 'dump.sql'), 'x');
  await runSteps(fakeMachine({ info: { homedir: machineHome } }), teardownPhase(h), h.workspace, h.worktree, steps('COPY dump.sql ~/saved/'), h.deps);
  assert.equal(await readFile(join(machineHome, 'saved', 'dump.sql'), 'utf8'), 'x');
});
