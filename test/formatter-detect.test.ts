import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectFormatters, findCandidate, findOnPath } from '../src/formatter-detect.js';
import { HOST } from '../src/host-fs.js';
import { fakeFiles, fakeMachine } from './fake-machine.js';
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
  assert.deepEqual(await detectFormatters(fakeMachine(), folder, ['prettier', 'gofmt'], bin), { prettier: local, gofmt });
});

test('a candidate that is not executable, or a folder, is skipped; a formatter with no candidate found is not installed (#749)', POSIX_ONLY, async (t) => {
  const folder = await tempDir(t, 'fmt-project-');
  const bin = await tempDir(t, 'fmt-bin-');
  await tool(join(folder, '.venv', 'bin', 'ruff'), 0o644);
  const ruff = await tool(join(bin, 'ruff'));
  await mkdir(join(bin, 'black'));
  assert.deepEqual(await detectFormatters(fakeMachine(), folder, ['ruff', 'black', 'taplo'], bin), { ruff });
  assert.deepEqual(await detectFormatters(fakeMachine(), folder, ['ruff'], ''), {}, 'an empty PATH finds no bare name');
});

test('findCandidate takes the first installed of a list: the project\'s copy, then the PATH\'s (#782)', POSIX_ONLY, async (t) => {
  const folder = await tempDir(t, 'fmt-project-');
  const bin = await tempDir(t, 'fmt-bin-');
  const candidates = ['node_modules/.bin/tsc', 'tsc'];
  const onPath = await tool(join(bin, 'tsc'));
  assert.equal(await findCandidate(fakeMachine(), candidates, folder, bin), onPath);
  const local = await tool(join(folder, 'node_modules', '.bin', 'tsc'));
  assert.equal(await findCandidate(fakeMachine(), candidates, folder, bin), local);
  assert.equal(await findCandidate(fakeMachine(), ['mypy'], folder, ''), undefined);
});

test('on win32 the lookup goes by PATHEXT: go.exe, prettier.cmd and ruff.exe are found, an extensionless file is missed (#632)', async () => {
  const path = 'C:\\Go\\bin;C:\\npm';
  const isFile = (file: string): boolean => ['c:\\go\\bin\\go.exe', 'c:\\npm\\prettier', 'c:\\npm\\prettier.cmd', 'c:\\npm\\black'].includes(file.toLowerCase());
  const lookup = { platform: 'win32' as const, isFile };
  assert.equal(await findOnPath(HOST.fs, 'go', path, lookup), 'C:\\Go\\bin\\go.exe');
  assert.equal(await findOnPath(HOST.fs, 'black', path, lookup), undefined, 'no PATHEXT match');
  const machine = fakeMachine({ info: { platform: 'win32' }, fs: fakeFiles('C:\\Go\\bin\\go.exe', 'C:\\npm\\prettier', 'C:\\npm\\prettier.cmd', 'C:\\project\\.venv\\Scripts\\ruff.exe', 'C:\\npm\\black') });
  assert.equal(await findCandidate(machine, ['.venv/Scripts/ruff'], 'C:\\project', path), 'C:\\project\\.venv\\Scripts\\ruff.exe');
  assert.deepEqual(await detectFormatters(machine, 'C:\\project', ['prettier', 'black'], path), { prettier: 'C:\\npm\\prettier.cmd' });
});

test('with no path given the lookup reads the machine\'s own PATH (#160)', POSIX_ONLY, async (t) => {
  const bin = await tempDir(t, 'fmt-bin-');
  const gofmt = await tool(join(bin, 'gofmt'));
  assert.deepEqual(await detectFormatters(fakeMachine({ info: { path: bin } }), await tempDir(t, 'fmt-project-'), ['gofmt']), { gofmt });
});
