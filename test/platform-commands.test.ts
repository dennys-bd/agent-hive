import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepAwakeCommand, revealCommand, shutdownCommand, trashCommand } from '../src/platform-commands.js';

test('shutdownCommand is osascript on macOS and systemctl poweroff on Linux (#233, #658)', () => {
  assert.deepEqual(shutdownCommand('darwin'), ['osascript', ['-e', 'tell application "System Events" to shut down']]);
  assert.deepEqual(shutdownCommand('linux'), ['systemctl', ['poweroff']]);
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

test('any other platform throws a message naming the feature and the platform (#658)', () => {
  assert.throws(() => shutdownCommand('win32'), { message: 'Shutdown is not supported on win32' });
  assert.throws(() => revealCommand('win32', '/work/repo'), { message: 'Reveal is not supported on win32' });
});

test('trashCommand is /usr/bin/trash on macOS and gio trash on Linux, each path one argv element (#818)', () => {
  const paths = ['/work/my repo/a.txt', '/work/my repo/-b'];
  assert.deepEqual(trashCommand('darwin', paths), ['/usr/bin/trash', paths]);
  assert.deepEqual(trashCommand('linux', paths), ['gio', ['trash', '--', ...paths]]);
  assert.throws(() => trashCommand('win32', paths), { message: 'Trash is not supported on win32' });
});

test('keepAwakeCommand is caffeinate -di on macOS and systemd-inhibit idle:sleep on Linux, each ending with the given pid; any other platform throws (#226)', () => {
  assert.deepEqual(keepAwakeCommand('darwin', 4242), ['caffeinate', ['-di', '-w', '4242']]);
  assert.deepEqual(keepAwakeCommand('linux', 4242), ['systemd-inhibit', ['--what=idle:sleep', '--why=Agent Hive keep awake', 'tail', '--pid=4242', '-f', '/dev/null']]);
  assert.throws(() => keepAwakeCommand('win32', 4242), { message: 'Keep awake is not supported on win32' });
});
