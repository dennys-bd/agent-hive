import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { keepAwakeCommand, revealCommand, shutdownCommand, trashCommand, type PlatformCommand } from '../src/platform-commands.js';
import { tempDir } from './temp-dir.js';

const POWERSHELL = /^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/;
const onWindows = { skip: process.platform !== 'win32' && 'Windows only: runs on the Windows lane' };

// A win32 PowerShell command: Windows' own powershell.exe by full path, and the script it runs, decoded from -EncodedCommand.
function script([file, args]: PlatformCommand): string {
  assert.match(file, POWERSHELL);
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(args.length, 4);
  return Buffer.from(args[3], 'base64').toString('utf16le');
}

test('shutdownCommand is osascript on macOS, systemctl poweroff on Linux and shutdown.exe /s /t 0 on Windows (#233, #658, #646)', () => {
  assert.deepEqual(shutdownCommand('darwin'), ['osascript', ['-e', 'tell application "System Events" to shut down']]);
  assert.deepEqual(shutdownCommand('linux'), ['systemctl', ['poweroff']]);
  const [file, args] = shutdownCommand('win32');
  assert.match(file, /^[A-Za-z]:\\.*\\System32\\shutdown\.exe$/);
  assert.ok(win32.isAbsolute(file));
  assert.deepEqual(args, ['/s', '/t', '0']);
});

test('revealCommand is open -R on macOS and xdg-open on Linux, and a path with spaces stays one argv element (#629, #658)', () => {
  const path = '/work/my repo/hive 1';
  assert.deepEqual(revealCommand('darwin', path), ['open', ['-R', path]]);
  assert.deepEqual(revealCommand('linux', path), ['xdg-open', [path]]);
});

test('revealCommand opens the parent folder of a file on Linux, where xdg-open would launch the file; a folder opens itself (#818)', () => {
  assert.deepEqual(revealCommand('linux', '/work/my repo/src/a.ts', true), ['xdg-open', ['/work/my repo/src']]);
  assert.deepEqual(revealCommand('linux', '/work/my repo/src', false), ['xdg-open', ['/work/my repo/src']]);
  assert.deepEqual(revealCommand('darwin', '/work/my repo/src/a.ts', true), ['open', ['-R', '/work/my repo/src/a.ts']]);
});

test('revealCommand on Windows starts Explorer with the item selected, the path a quoted PowerShell literal, file or folder alike (#646)', () => {
  const text = script(revealCommand('win32', "C:\\work\\it's ‘mine’\\a.ts", true));
  assert.match(text, /Start-Process -FilePath '[A-Za-z]:\\[^']*\\explorer\.exe' -ArgumentList \('\/select,"' \+ 'C:\\work\\it''s ‘‘mine’’\\a\.ts' \+ '"'\)/);
  assert.equal(script(revealCommand('win32', 'C:\\work\\src', false)), script(revealCommand('win32', 'C:\\work\\src', true)));
});

test('any other platform throws a message naming the feature and the platform (#658)', () => {
  assert.throws(() => shutdownCommand('aix'), { message: 'Shutdown is not supported on aix' });
  assert.throws(() => revealCommand('aix', '/work/repo'), { message: 'Reveal is not supported on aix' });
});

test('trashCommand is /usr/bin/trash on macOS and gio trash on Linux, each path one argv element (#818)', () => {
  const paths = ['/work/my repo/a.txt', '/work/my repo/-b'];
  assert.deepEqual(trashCommand('darwin', paths), ['/usr/bin/trash', paths]);
  assert.deepEqual(trashCommand('linux', paths), ['gio', ['trash', '--', ...paths]]);
  assert.throws(() => trashCommand('aix', paths), { message: 'Trash is not supported on aix' });
});

test('trashCommand on Windows sends every path to the recycle bin, each a quoted PowerShell literal, and stops on the first error (#646)', () => {
  const text = script(trashCommand('win32', ['C:\\work\\a.txt', "C:\\work\\'; Remove-Item C:\\ #"]));
  assert.match(text, /\$ErrorActionPreference = 'Stop'/);
  assert.ok(text.includes("@('C:\\work\\a.txt', 'C:\\work\\''; Remove-Item C:\\ #')"), text);
  assert.match(text, /DeleteFile\(\$p, 'OnlyErrorDialogs', 'SendToRecycleBin'\)/);
  assert.match(text, /DeleteDirectory\(\$p, 'OnlyErrorDialogs', 'SendToRecycleBin'\)/);
});

test('keepAwakeCommand is caffeinate -di on macOS and systemd-inhibit idle:sleep on Linux, each ending with the given pid; any other platform throws (#226)', () => {
  assert.deepEqual(keepAwakeCommand('darwin', 4242), ['caffeinate', ['-di', '-w', '4242']]);
  assert.deepEqual(keepAwakeCommand('linux', 4242), ['systemd-inhibit', ['--what=idle:sleep', '--why=Agent Hive keep awake', 'tail', '--pid=4242', '-f', '/dev/null']]);
  assert.throws(() => keepAwakeCommand('aix', 4242), { message: 'Keep awake is not supported on aix' });
});

test('keepAwakeCommand on Windows holds the display and the machine awake until the given pid ends; a pid that is no integer throws (#646)', () => {
  const text = script(keepAwakeCommand('win32', 4242));
  assert.match(text, /SetThreadExecutionState\(2147483651\)/); // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
  assert.match(text, /Wait-Process -Id 4242$/);
  assert.throws(() => keepAwakeCommand('win32', 1.5), { message: 'Not a pid: 1.5' });
});

const run = promisify(execFile);

test('on Windows the trash command takes a file out of its folder and exits 0 (#646)', onWindows, async (t) => {
  const file = join(await tempDir(t, 'trash-'), "it's here.txt");
  await writeFile(file, 'x');
  const [cmd, args] = trashCommand(process.platform, [file]);
  await run(cmd, [...args]);
  assert.equal(existsSync(file), false);
});

test('on Windows the reveal command exits 0 (#646)', onWindows, async (t) => {
  const [cmd, args] = revealCommand(process.platform, await tempDir(t, 'reveal-'));
  await run(cmd, [...args]);
});
