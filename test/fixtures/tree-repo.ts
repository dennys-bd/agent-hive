import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Exec } from '../../src/types.js';
import { tempDir, type AfterHost } from '../temp-dir.js';

export const realExec: Exec = promisify(execFile);
const IDENTITY = ['-c', 'user.name=Hive', '-c', 'user.email=hive@example.invalid', '-c', 'commit.gpgsign=false'];

/** git in `cwd` with a test identity, so a commit works on a CI runner with no global config. */
export const gitAt = (cwd: string, ...args: string[]): Promise<{ stdout: string }> => realExec('git', ['-C', cwd, ...IDENTITY, ...args]);

async function put(root: string, path: string, text = path): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

/** #502's fixture, every case the tree read must keep drawing the same: a folder of only ignored files (logs/), a mixed folder (build/: a
 *  tracked file and an ignored one), an ignored folder (node_modules/), an untracked folder with a subfolder (newdir/), an untracked nested
 *  repository (vendor/lib), an empty folder, a modification, a staged delete and a rename. */
export async function treeRepo(t: AfterHost): Promise<string> {
  const repo = await tempDir(t, 'tree-');
  await realExec('git', ['init', '--quiet', '--initial-branch=main', repo]);
  await put(repo, '.gitignore', '*.log\nnode_modules/\n');
  for (const path of ['a.txt', 'build/keep.txt', 'gone.txt', 'old.ts', 'src/b.ts']) await put(repo, path);
  await gitAt(repo, 'add', '-A');
  await gitAt(repo, 'commit', '--quiet', '-m', 'init');
  await put(repo, 'src/b.ts', 'changed');
  await gitAt(repo, 'rm', '--quiet', 'gone.txt');
  await gitAt(repo, 'mv', 'old.ts', 'moved.ts');
  for (const path of ['newdir/x.ts', 'newdir/sub/y.ts', 'logs/a.log', 'logs/b.log', 'debug.log', 'build/app.log', 'node_modules/pkg/index.js', 'vendor/lib/README.md']) await put(repo, path);
  await mkdir(join(repo, 'empty'));
  await realExec('git', ['init', '--quiet', join(repo, 'vendor', 'lib')]);
  return repo;
}
