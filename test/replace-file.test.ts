import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { renameSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import type { Readable } from 'node:stream';
import { writeAtomically } from '../src/daemon-files.js';
import { writeAtomic } from '../src/server-editor.js';
import { tempDir } from './temp-dir.js';
import { RETRY_DELAYS_MS, replaceFile, replaceFileSync } from '../src/replace-file.js';

const TMP = 'target.json.tmp';
const TARGET = 'target.json';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename '${TMP}' -> '${TARGET}'`), { code });

// A rename that fails with codes[n] on its nth call, then with `always` (when given) or succeeds; both entry points share it
function renamer(codes: readonly string[], always?: string) {
  const calls: Array<[string, string]> = [];
  const thrown: Error[] = [];
  const renameSync = (from: string, to: string): void => {
    calls.push([from, to]);
    const code = codes[calls.length - 1] ?? always;
    if (code === undefined) return;
    const err = errno(code);
    thrown.push(err);
    throw err;
  };
  return { calls, thrown, renameSync, rename: async (from: string, to: string): Promise<void> => renameSync(from, to) };
}

// The waits between tries, recorded instead of waited
function sleeper() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number): Promise<void> => { waits.push(ms); }, sleepSync: (ms: number): void => { waits.push(ms); } };
}

test('win32: EPERM, EBUSY then EACCES are retried after 10, 20 and 40 ms and the fourth rename lands (#629)', async () => {
  const fake = renamer(['EPERM', 'EBUSY', 'EACCES']);
  const { waits, sleep } = sleeper();
  await replaceFile(TMP, TARGET, { platform: 'win32', rename: fake.rename, sleep });
  assert.deepEqual(fake.calls, Array.from({ length: 4 }, () => [TMP, TARGET]));
  assert.deepEqual(waits, [10, 20, 40]);
});

test('win32: the sync entry point retries the same way, waiting through sleepSync (#629)', () => {
  const fake = renamer(['EPERM', 'EBUSY', 'EACCES']);
  const { waits, sleepSync } = sleeper();
  replaceFileSync(TMP, TARGET, { platform: 'win32', renameSync: fake.renameSync, sleepSync });
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(waits, [10, 20, 40]);
});

test('win32: a rename that always fails EBUSY throws its last error after 8 calls, having waited every delay (#629)', async () => {
  const fake = renamer([], 'EBUSY');
  const { waits, sleep } = sleeper();
  await assert.rejects(replaceFile(TMP, TARGET, { platform: 'win32', rename: fake.rename, sleep }), (err: unknown) => err === fake.thrown.at(-1));
  assert.equal(fake.calls.length, 8);
  assert.deepEqual(waits, [...RETRY_DELAYS_MS]);

  const sync = renamer([], 'EBUSY');
  const slept = sleeper();
  assert.throws(() => replaceFileSync(TMP, TARGET, { platform: 'win32', renameSync: sync.renameSync, sleepSync: slept.sleepSync }), (err: unknown) => err === sync.thrown.at(-1));
  assert.deepEqual([sync.calls.length, slept.waits], [8, [...RETRY_DELAYS_MS]]);
});

test('win32: ENOENT is thrown on the first call, with no wait (#629)', async () => {
  const fake = renamer(['ENOENT']);
  const { waits, sleep, sleepSync } = sleeper();
  await assert.rejects(replaceFile(TMP, TARGET, { platform: 'win32', rename: fake.rename, sleep }), { code: 'ENOENT' });
  assert.throws(() => replaceFileSync(TMP, TARGET, { platform: 'win32', renameSync: renamer(['ENOENT']).renameSync, sleepSync }), { code: 'ENOENT' });
  assert.deepEqual([fake.calls.length, waits], [1, []]);
});

test('darwin and linux: EPERM is a real permission problem, thrown on the first call with no wait, by both entry points (#629)', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const fake = renamer(['EPERM']);
    const sync = renamer(['EPERM']);
    const { waits, sleep, sleepSync } = sleeper();
    await assert.rejects(replaceFile(TMP, TARGET, { platform, rename: fake.rename, sleep }), { code: 'EPERM' }, platform);
    assert.throws(() => replaceFileSync(TMP, TARGET, { platform, renameSync: sync.renameSync, sleepSync }), { code: 'EPERM' }, platform);
    assert.deepEqual([fake.calls.length, sync.calls.length, waits], [1, 1, []], platform);
  }
});

// A Node handle cannot hold the lock: libuv opens files with FILE_SHARE_DELETE, so a Node reader never blocks the rename. PowerShell opens
// the target with Read sharing only, says so, holds it ~300 ms (inside the 1.3 s window) and closes it. The path comes through the env,
// never through the script's text.
const HOLD_SCRIPT = "$f = [IO.File]::Open($env:HIVE_HOLD_PATH, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('open'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 300; $f.Close()";
const LOCK_CODES = ['EPERM', 'EBUSY', 'EACCES'];
// Room for powershell.exe to start on a cold runner
const WIN32_ONLY = { skip: process.platform !== 'win32' && 'Windows only: runs on the Windows lane', timeout: 30_000 };

function lineArrives(stream: Readable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let text = '';
    stream.on('data', (chunk) => {
      text += String(chunk);
      if (text.includes(line)) resolve();
    });
    stream.once('end', () => reject(new Error(`the holder ended before it printed "${line}"`)));
  });
}

// Starts the holder and resolves once the target is open; the returned promise is its exit
async function holdOpen(path: string): Promise<Promise<unknown>> {
  const root = process.env.SystemRoot;
  assert.ok(root, 'SystemRoot is not set');
  const exe = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const holder = execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', HOLD_SCRIPT], { env: { ...process.env, HIVE_HOLD_PATH: path }, windowsHide: true });
  const exited = once(holder, 'exit');
  await lineArrives(holder.stdout!, 'open');
  return exited;
}

test('win32: writeAtomically over a file another process holds open lands once that process closes it (#629)', WIN32_ONLY, async (t) => {
  const target = join(await tempDir(t, 'replace-'), 'hive.port');
  await writeFile(target, 'old\n');
  const exited = await holdOpen(target);
  // the hold really blocks a plain rename, so the write below can only land through the retry
  writeFileSync(`${target}.probe`, 'probe');
  assert.throws(() => renameSync(`${target}.probe`, target), (err: unknown) => LOCK_CODES.includes(String((err as NodeJS.ErrnoException).code)));
  writeAtomically(target, 'new\n');
  assert.equal(await readFile(target, 'utf8'), 'new\n');
  await exited;
});

test('win32: writeAtomic over a file another handle holds open for reading lands once the handle closes (#629)', WIN32_ONLY, async (t) => {
  const target = join(await tempDir(t, 'replace-'), 'notes.md');
  await writeFile(target, 'old');
  const exited = await holdOpen(target);
  await writeAtomic(target, 'new');
  assert.equal(await readFile(target, 'utf8'), 'new');
  await exited;
});
