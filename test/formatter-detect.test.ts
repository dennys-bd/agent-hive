import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectFormatters, findCandidate } from '../src/formatter-detect.js';
import { tempDir } from './temp-dir.js';

// A tool for the test: a script in a temp folder, so no test depends on one installed on the machine
async function tool(path: string, mode = 0o755): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\ncat\n');
  await chmod(path, mode);
  return path;
}

test('the project\'s local binary wins over the PATH; a bare candidate is found on the PATH given (#749)', async (t) => {
  const folder = await tempDir(t, 'fmt-project-');
  const bin = await tempDir(t, 'fmt-bin-');
  const local = await tool(join(folder, 'node_modules', '.bin', 'prettier'));
  await tool(join(bin, 'prettier'));
  const gofmt = await tool(join(bin, 'gofmt'));
  assert.deepEqual(await detectFormatters(folder, ['prettier', 'gofmt'], bin), { prettier: local, gofmt });
});

test('a candidate that is not executable, or a folder, is skipped; a formatter with no candidate found is not installed (#749)', async (t) => {
  const folder = await tempDir(t, 'fmt-project-');
  const bin = await tempDir(t, 'fmt-bin-');
  await tool(join(folder, '.venv', 'bin', 'ruff'), 0o644);
  const ruff = await tool(join(bin, 'ruff'));
  await mkdir(join(bin, 'black'));
  assert.deepEqual(await detectFormatters(folder, ['ruff', 'black', 'taplo'], bin), { ruff });
  assert.deepEqual(await detectFormatters(folder, ['ruff'], ''), {}, 'an empty PATH finds no bare name');
});

test('findCandidate takes the first installed of a list: the project\'s copy, then the PATH\'s (#782)', async (t) => {
  const folder = await tempDir(t, 'fmt-project-');
  const bin = await tempDir(t, 'fmt-bin-');
  const candidates = ['node_modules/.bin/tsc', 'tsc'];
  const onPath = await tool(join(bin, 'tsc'));
  assert.equal(await findCandidate(candidates, folder, bin), onPath);
  const local = await tool(join(folder, 'node_modules', '.bin', 'tsc'));
  assert.equal(await findCandidate(candidates, folder, bin), local);
  assert.equal(await findCandidate(['mypy'], folder, ''), undefined);
});
