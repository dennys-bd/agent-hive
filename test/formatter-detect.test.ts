import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectFormatters, findCandidate, findOnPath } from '../src/formatter-detect.js';
import { tempDir } from './temp-dir.js';

// The POSIX tests make real tools with mode bits, which Windows has not; the win32 lookup is tested below on a faked file system
const POSIX_ONLY = { skip: process.platform === 'win32' && 'POSIX only: file modes and extensionless tools' };

// A tool for the test: a script in a temp folder, so no test depends on one installed on the machine
async function tool(path: string, mode = 0o755): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\ncat\n');
  await chmod(path, mode);
  return path;
}

test('the project\'s local binary wins over the PATH; a bare candidate is found on the PATH given (#749)', POSIX_ONLY, async (t) => {
  const folder = await tempDir(t, 'fmt-project-');
  const bin = await tempDir(t, 'fmt-bin-');
  const local = await tool(join(folder, 'node_modules', '.bin', 'prettier'));
  await tool(join(bin, 'prettier'));
  const gofmt = await tool(join(bin, 'gofmt'));
  assert.deepEqual(await detectFormatters(folder, ['prettier', 'gofmt'], bin), { prettier: local, gofmt });
});

test('a candidate that is not executable, or a folder, is skipped; a formatter with no candidate found is not installed (#749)', POSIX_ONLY, async (t) => {
  const folder = await tempDir(t, 'fmt-project-');
  const bin = await tempDir(t, 'fmt-bin-');
  await tool(join(folder, '.venv', 'bin', 'ruff'), 0o644);
  const ruff = await tool(join(bin, 'ruff'));
  await mkdir(join(bin, 'black'));
  assert.deepEqual(await detectFormatters(folder, ['ruff', 'black', 'taplo'], bin), { ruff });
  assert.deepEqual(await detectFormatters(folder, ['ruff'], ''), {}, 'an empty PATH finds no bare name');
});

test('findCandidate takes the first installed of a list: the project\'s copy, then the PATH\'s (#782)', POSIX_ONLY, async (t) => {
  const folder = await tempDir(t, 'fmt-project-');
  const bin = await tempDir(t, 'fmt-bin-');
  const candidates = ['node_modules/.bin/tsc', 'tsc'];
  const onPath = await tool(join(bin, 'tsc'));
  assert.equal(await findCandidate(candidates, folder, bin), onPath);
  const local = await tool(join(folder, 'node_modules', '.bin', 'tsc'));
  assert.equal(await findCandidate(candidates, folder, bin), local);
  assert.equal(await findCandidate(['mypy'], folder, ''), undefined);
});

// A Windows file system of the given files, case-insensitive as NTFS is
const fakeFs = (...files: string[]) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (file: string): boolean => set.has(file.toLowerCase());
};

test('on win32 the lookup goes by PATHEXT: go.exe, prettier.cmd and ruff.exe are found, an extensionless file is missed (#632)', async () => {
  const path = 'C:\\Go\\bin;C:\\npm';
  const isFile = fakeFs('C:\\Go\\bin\\go.exe', 'C:\\npm\\prettier', 'C:\\npm\\prettier.cmd', 'C:\\project\\.venv\\Scripts\\ruff.exe', 'C:\\npm\\black');
  const lookup = { platform: 'win32' as const, isFile };
  assert.equal(await findOnPath('go', path, lookup), 'C:\\Go\\bin\\go.exe');
  assert.equal(await findOnPath('black', path, lookup), undefined, 'no PATHEXT match');
  assert.equal(await findCandidate(['.venv/Scripts/ruff'], 'C:\\project', path, lookup), 'C:\\project\\.venv\\Scripts\\ruff.exe');
  assert.deepEqual(await detectFormatters('C:\\project', ['prettier', 'black'], path, lookup), { prettier: 'C:\\npm\\prettier.cmd' });
});
