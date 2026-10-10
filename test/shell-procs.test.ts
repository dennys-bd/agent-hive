import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { shellCwd, strayAgents, wakeDir } from '../src/shell-procs.js';
import type { Exec } from '../src/types.js';
import { tempDir } from './temp-dir.js';

// A pgrep and an lsof that answer from a table keyed by the whole argv, and fail on anything else, as pgrep does on no match
const table = (answers: Record<string, string>): { exec: Exec; calls: string[][] } => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const key = [file, ...args].join(' ');
    if (!(key in answers)) throw Object.assign(new Error('no match'), { code: 1 });
    return { stdout: answers[key] };
  };
  return { exec, calls };
};

test('shellCwd reads the shell under the pty\'s sh -c with pgrep, then its cwd with lsof in field mode (#696)', async () => {
  const { exec, calls } = table({ 'pgrep -P 4000': '4001\n', 'lsof -a -p 4001 -d cwd -Fn': 'p4001\nfcwd\nn/repo/src\n' });
  assert.equal(await shellCwd(4000, exec), '/repo/src');
  assert.deepEqual(calls, [['pgrep', '-P', '4000'], ['lsof', '-a', '-p', '4001', '-d', 'cwd', '-Fn']]);
});

test('shellCwd answers nothing with no pty, no shell under it, or an lsof that fails (#696)', async () => {
  assert.equal(await shellCwd(undefined, table({}).exec), undefined);
  assert.equal(await shellCwd(4000, table({}).exec), undefined, 'pgrep matched nothing');
  assert.equal(await shellCwd(4000, table({ 'pgrep -P 4000': '4001\n' }).exec), undefined, 'lsof failed: the shell is already gone');
});

test('wakeDir keeps the held cwd while it is a directory on disk, else the start dir (#696)', async (t) => {
  const root = await tempDir(t, 'wake-');
  const held = join(root, 'src');
  await mkdir(held);
  assert.equal(await wakeDir(held, root), held);
  assert.equal(await wakeDir(join(root, 'gone'), root), root);
});

test('strayAgents names the agents under the shell that no captured session holds, skipping the shim itself (#696)', async () => {
  const { exec } = table({
    'pgrep -P 100': '200\n', // the pty's sh -c, then the shell
    'pgrep -lf -P 200': '301 /bin/sh /h/bin/claude fix it\n302 claude --resume abc\n303 vim notes\n',
    'pgrep -lf -P 301': '401 /usr/local/bin/claude --mcp-config x --session-id S1 fix it\n',
  });
  const shim = '/h/bin/claude';
  assert.deepEqual(await strayAgents(100, { captured: ['S1'], shim }, exec), ['claude'], 'the resumed one only: S1 is captured');
  assert.deepEqual(await strayAgents(100, { captured: [], shim }, exec), ['claude', 'claude']);
  assert.deepEqual(await strayAgents(undefined, { captured: [], shim }, exec), []);
});
