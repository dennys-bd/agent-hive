import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveActivityPath } from '../src/ide.js';
import { tempDir, type AfterHost } from './temp-dir.js';

// What the server injects (#258): the real realpath, and a stat that says whether the path is a regular file
const DISK = { realpath: (path: string) => realpath(path), isFile: (path: string) => stat(path).then((s) => s.isFile(), () => false) };

// A workspace whose worktree holds docs/spec.md and whose main checkout holds docs/plan.md, a file outside both, and a symlink in the worktree
// that points at it. Real paths throughout: macOS's tmpdir is itself a symlink, and resolveActivityPath answers the real path.
async function layout(t: AfterHost): Promise<{ workspace: string; worktree: string; secret: string }> {
  const workspace = await realpath(await tempDir(t, 'ide-'));
  const worktree = join(workspace, '.hive', 'worktrees', 'hive-1-x');
  await mkdir(join(worktree, 'docs'), { recursive: true });
  await mkdir(join(workspace, 'docs'));
  await writeFile(join(worktree, 'docs', 'spec.md'), '# spec');
  await writeFile(join(workspace, 'docs', 'plan.md'), '# plan');
  const secret = join(await realpath(await tempDir(t, 'out-')), 'secret.txt');
  await writeFile(secret, 'x');
  await symlink(secret, join(worktree, 'link.txt'));
  return { workspace, worktree, secret };
}

test('resolveActivityPath resolves any existing file: in the worktree, in the main checkout by a ../ path, outside both by an absolute path or a symlink, and the workspace once the worktree is gone; a folder or a missing file is missing (#697)', async (t) => {
  const { workspace, worktree, secret } = await layout(t);
  const at = (path: string) => resolveActivityPath({ worktree, workspace, path, ...DISK });
  assert.deepEqual(await at('docs/spec.md'), { file: join(worktree, 'docs', 'spec.md'), base: 'worktree' });
  assert.deepEqual(await at('../../../docs/plan.md'), { file: join(workspace, 'docs', 'plan.md'), base: 'workspace' }, 'a ../ path from the worktree to the main checkout');
  assert.deepEqual(await at(secret), { file: secret, base: 'outside' }, 'an absolute path in neither folder');
  assert.deepEqual(await at('link.txt'), { file: secret, base: 'outside' }, 'a symlink out leads to its real target');
  assert.deepEqual(await at('docs'), { reason: 'missing' }, 'a folder is no file');
  assert.deepEqual(await at('docs/nope.md'), { reason: 'missing' });
  await rm(worktree, { recursive: true });
  assert.deepEqual(await at('docs/plan.md'), { file: join(workspace, 'docs', 'plan.md'), base: 'workspace' }, 'the workspace is the base once the worktree is gone');
});
