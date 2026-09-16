import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HIVE_BIN = fileURLToPath(new URL('../../bin/hive.js', import.meta.url));

test('hive exits 2 with a build hint when dist/src/main.js is missing', async () => {
  // copy the script into a tree without dist/ (and without node_modules, so electron is never resolved)
  const root = await mkdtemp(join(tmpdir(), 'hive-cli-'));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await copyFile(HIVE_BIN, join(root, 'bin', 'hive.js'));
  await assert.rejects(
    execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), root]),
    (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? '', /pnpm build/);
      return true;
    },
  );
});

test('hive exits 1 with an install hint when electron is not installed', async () => {
  // fake dist/src/main.js so the build check passes, but no node_modules/electron, so require('electron') throws
  const root = await mkdtemp(join(tmpdir(), 'hive-cli-'));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(root, 'dist', 'src', 'main.js'), '');
  await copyFile(HIVE_BIN, join(root, 'bin', 'hive.js'));
  await assert.rejects(
    execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), root]),
    (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr ?? '', /pnpm install/);
      return true;
    },
  );
});
