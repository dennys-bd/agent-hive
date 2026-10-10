import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { historyPath, readScrollback, removeTerminalFiles, restoreScrollbacks, scrollbackPath, terminalsDir } from '../src/terminal-files.js';
import type { Terminal } from '../src/types.js';
import { tempDir } from './temp-dir.js';

test('removeTerminalFiles drops a terminal\'s ring and history, and a file never written is no error (#696)', async (t) => {
  const home = await tempDir(t, 'home-');
  await mkdir(terminalsDir(home), { recursive: true });
  await writeFile(scrollbackPath(home, 'T1'), 'ring');
  await writeFile(historyPath(home, 'T1'), 'ls\n');
  await writeFile(historyPath(home, 'T2'), 'pwd\n');
  await removeTerminalFiles(home, 'T1');
  await removeTerminalFiles(home, 'T3');
  assert.deepEqual(await readdir(terminalsDir(home)), ['T2.history']);
});

test('readScrollback reads a ring back, none for a terminal that never slept; restoreScrollbacks hands each sleeping terminal\'s saved ring over (#696)', async (t) => {
  const home = await tempDir(t, 'home-');
  await mkdir(terminalsDir(home), { recursive: true });
  await writeFile(scrollbackPath(home, 'T1'), 'ring');
  assert.deepEqual([await readScrollback(home, 'T1'), await readScrollback(home, 'T2')], ['ring', undefined]);
  const at = '2026-10-03T10:00:00.000Z';
  const terminals: Terminal[] = [
    { terminalId: 'T1', activityId: 'a', startedAt: at, cwd: '/repo', asleep: true }, { terminalId: 'T2', activityId: 'a', startedAt: at, cwd: '/repo', asleep: true },
  ];
  const restored: [string, string][] = [];
  await restoreScrollbacks(home, terminals, (id, text) => restored.push([id, text]));
  assert.deepEqual(restored, [['T1', 'ring']]);
});
