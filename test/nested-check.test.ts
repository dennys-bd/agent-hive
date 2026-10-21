import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { detectNested, nestedRepoProblem } from '../src/nested-check.js';
import { tempDir } from './temp-dir.js';

// #653 with the real git: why a path cannot be a nested repo, and the ones the Hive suggests.

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, '-c', 'user.email=hive@example.invalid', '-c', 'user.name=Hive', '-c', 'commit.gpgsign=false', ...args])).stdout.trim();

test('nestedRepoProblem names each cause in order: a bad path, no repository, not its top level (naming it), a submodule, tracked, not ignored; an ignored nested repo has none (#653)', async (t) => {
  const ws = await realpath(await tempDir(t, 'outer-'));
  await git(ws, 'init', '--quiet', '-b', 'main');
  await writeFile(join(ws, '.gitignore'), 'docs/\n');
  await mkdir(join(ws, 'vendor'));
  await writeFile(join(ws, 'vendor', 'a.js'), '');
  await git(ws, 'add', '.gitignore', 'vendor/a.js');
  await git(ws, 'commit', '--quiet', '-m', 'vendor');
  await git(ws, 'init', '--quiet', 'vendor'); // tracked by the workspace, then made a repository
  await git(ws, 'init', '--quiet', 'docs');
  await mkdir(join(ws, 'docs', 'agent'));
  await mkdir(join(ws, 'src'));
  await git(ws, 'init', '--quiet', 'ee'); // a repository the workspace's git does not ignore
  const lib = await tempDir(t, 'lib-');
  await git(lib, 'init', '--quiet', '-b', 'main');
  await writeFile(join(lib, 'lib.md'), 'lib');
  await git(lib, 'add', 'lib.md');
  await git(lib, 'commit', '--quiet', '-m', 'lib');
  await git(ws, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', lib, 'lib');
  const paths = ['../x', 'gone', 'src', 'docs/agent', 'lib', 'vendor', 'ee', 'docs'];
  assert.deepEqual(await Promise.all(paths.map((path) => nestedRepoProblem(ws, path))), [
    { cause: 'badPath' }, { cause: 'notRepo' }, { cause: 'notRepo' }, { cause: 'notTopLevel', root: 'docs' },
    { cause: 'submodule' }, { cause: 'tracked' }, { cause: 'notIgnored' }, undefined,
  ]);
});

test('detectNested finds the ignored folders that are git repositories, outside .hive, minus the paths it skips (#653)', async (t) => {
  const ws = await realpath(await tempDir(t, 'outer-'));
  await git(ws, 'init', '--quiet', '-b', 'main');
  await writeFile(join(ws, '.gitignore'), 'docs/\nsite/\nbuild/\n.hive/\n');
  for (const path of ['docs', 'site', '.hive/inner', 'ee']) await git(ws, 'init', '--quiet', path); // ee is not ignored
  await mkdir(join(ws, 'build'));
  await writeFile(join(ws, 'build', 'out.js'), '');
  assert.deepEqual(await detectNested(ws, []), ['docs', 'site']);
  assert.deepEqual(await detectNested(ws, ['docs']), ['site']);
});
