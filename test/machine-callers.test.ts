import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// #932: every call that reads a workspace's checkout names its machine. A call with no workspace and no activity takes machines.local by name;
// LOCAL_DISK is the local machine's own definition (machine-local-disk.ts since #941, re-exported by machine-local.ts) and the boot's proposal
// of its cwd, where no workspace exists yet.
const SRC = fileURLToPath(new URL('../../src', import.meta.url)); // from dist/test

// Each source file's code, its whole-line comments left out: a comment may name what the code no longer does
async function sources(): Promise<[string, string][]> {
  const names = (await readdir(SRC, { recursive: true })).filter((name) => /\.tsx?$/.test(name));
  const code = (text: string): string => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  return Promise.all(names.map(async (name): Promise<[string, string]> => [name.split(sep).join('/'), code(await readFile(join(SRC, name), 'utf8'))]));
}

test('no call in src/ resolves a machine from nothing: machineFor({}) is gone (#932)', async () => {
  assert.deepEqual((await sources()).filter(([, text]) => text.includes('machineFor({})')).map(([name]) => name), []);
});

test('LOCAL_DISK is only the local machine\'s definition and the boot\'s proposal (#932)', async () => {
  assert.deepEqual(
    (await sources()).filter(([, text]) => /\bLOCAL_DISK\b/.test(text)).map(([name]) => name).sort(),
    ['hive.ts', 'machine-local-disk.ts', 'machine-local.ts'],
  );
});
