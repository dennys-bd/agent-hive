import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTerminal } from '../src/terminal.js';
import type { Exec } from '../src/types.js';

interface Call { file: string; args: string[] }
const ARGV = ['tmux', '-L', 'hive', 'attach', '-d', '-t', "it's"];
const QUOTED = "'tmux' '-L' 'hive' 'attach' '-d' '-t' 'it'\\''s'";
const isIterm = (args: string[]): boolean => args[1].includes('com.googlecode.iterm2');

// Records every command; `rejectWhen` makes the matching calls fail like a missing app would.
function fakeExec(rejectWhen?: (args: string[]) => boolean): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (rejectWhen?.(args)) throw new Error('osascript: iTerm2 not found');
    return { stdout: 'session-1\n' };
  };
  return { exec, calls };
}

test('darwin types the shell-quoted argv into an iTerm2 tab and stops there when it works', async () => {
  const { exec, calls } = fakeExec();
  await openTerminal(ARGV, { exec, platform: 'darwin', env: {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'osascript');
  assert.equal(calls[0].args[0], '-e');
  assert.ok(isIterm(calls[0].args));
  assert.equal(calls[0].args[2], QUOTED);
});

test('darwin falls back to Terminal.app with the same string when iTerm2 refuses; a Terminal.app failure propagates', async () => {
  const { exec, calls } = fakeExec(isIterm);
  await openTerminal(ARGV, { exec, platform: 'darwin', env: {} });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].file, 'osascript');
  assert.equal(calls[1].args[0], '-e');
  assert.ok(calls[1].args[1].includes('on run argv'));
  assert.ok(calls[1].args[1].includes('tell application "Terminal"'));
  assert.ok(calls[1].args[1].includes('do script (item 1 of argv)'));
  assert.ok(calls[1].args[1].includes('activate'));
  assert.equal(calls[1].args[2], QUOTED);
  const all = fakeExec(() => true);
  await assert.rejects(openTerminal(ARGV, { exec: all.exec, platform: 'darwin', env: {} }), /iTerm2 not found/);
  assert.equal(all.calls.length, 2, 'both apps were tried');
});

test('linux runs $TERMINAL, or x-terminal-emulator, with -e and the argv as is', async () => {
  const { exec, calls } = fakeExec();
  await openTerminal(ARGV, { exec, platform: 'linux', env: { TERMINAL: 'kitty' } });
  await openTerminal(ARGV, { exec, platform: 'linux', env: {} });
  assert.deepEqual(calls, [{ file: 'kitty', args: ['-e', ...ARGV] }, { file: 'x-terminal-emulator', args: ['-e', ...ARGV] }]);
});

test('any other platform rejects without running anything', async () => {
  const { exec, calls } = fakeExec();
  await assert.rejects(openTerminal(ARGV, { exec, platform: 'win32', env: {} }), { message: 'terminal não suportado em win32' });
  assert.equal(calls.length, 0);
});
