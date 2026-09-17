import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerCommand } from '../src/spawn-iterm.js';
import { attachArgv, spawnTmuxWorker, TMUX_SOCKET } from '../src/spawn-tmux.js';
import type { Exec } from '../src/types.js';
import { LAUNCH } from './fakes.js';

interface Call { file: string; args: string[]; env?: NodeJS.ProcessEnv }

// Records every command; `failing` makes the calls whose args include that word reject.
function fakeExec(failing?: string): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args, env: opts?.env });
    if (failing && args.includes(failing)) throw new Error(`${failing} boom`);
    return { stdout: '' };
  };
  return { exec, calls };
}

function handlers() {
  const errors: string[] = [];
  let exits = 0;
  return { errors, exits: () => exits, handlers: { onError: (m: string) => errors.push(m), onExit: () => { exits += 1; } } };
}
const noTerminal = async (): Promise<void> => {};
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('spawnTmuxWorker starts a detached session named after the slug, in the repo, 200x50, running workerCommand with the hive env', () => {
  const { exec, calls } = fakeExec();
  spawnTmuxWorker(LAUNCH, handlers().handlers, { exec, openTerminal: noTerminal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'tmux');
  assert.deepEqual(calls[0].args, [
    '-L', TMUX_SOCKET, 'new-session', '-d', '-s', 'hive-1-task', '-c', '/repo', '-x', '200', '-y', '50', workerCommand(LAUNCH),
  ]);
  assert.equal(calls[0].env?.HIVE_WORKER_ID, 'W1');
  assert.equal(calls[0].env?.HIVE_PORT, '4242');
  assert.equal(calls[0].env?.CLAUDECODE, undefined, 'the tmux server is born without it, or the child would refuse to start');
  assert.equal(TMUX_SOCKET, 'hive');
});

test('a new-session that fails reports the error and the exit, once', async () => {
  const { exec } = fakeExec('new-session');
  const h = handlers();
  spawnTmuxWorker(LAUNCH, h.handlers, { exec, openTerminal: noTerminal });
  await tick();
  assert.deepEqual(h.errors, ['tmux: new-session boom']);
  assert.equal(h.exits(), 1);
});

test('kill runs kill-session and reports the exit once, even when kill-session fails', async () => {
  const ok = fakeExec();
  const h = handlers();
  const handle = spawnTmuxWorker(LAUNCH, h.handlers, { exec: ok.exec, openTerminal: noTerminal });
  handle.kill();
  await tick();
  assert.deepEqual(ok.calls[1], { file: 'tmux', args: ['-L', TMUX_SOCKET, 'kill-session', '-t', 'hive-1-task'], env: undefined });
  assert.equal(h.exits(), 1);
  assert.deepEqual(h.errors, []);
  handle.kill();
  await tick();
  assert.equal(h.exits(), 1, 'a second kill does not exit twice');
  const failing = fakeExec('kill-session');
  const h2 = handlers();
  spawnTmuxWorker(LAUNCH, h2.handlers, { exec: failing.exec, openTerminal: noTerminal }).kill();
  await tick();
  assert.deepEqual(h2.errors, ['tmux: kill-session boom']);
  assert.equal(h2.exits(), 1, 'the session is given as gone either way');
});

test('focus opens a terminal on the attach argv; attachArgv detaches other clients so the newest terminal wins', async () => {
  const opened: string[][] = [];
  const handle = spawnTmuxWorker(LAUNCH, handlers().handlers, { exec: fakeExec().exec, openTerminal: async (argv) => { opened.push(argv); } });
  await handle.focus();
  assert.deepEqual(opened, [['tmux', '-L', 'hive', 'attach', '-d', '-t', 'hive-1-task']]);
  assert.deepEqual(attachArgv('s'), ['tmux', '-L', TMUX_SOCKET, 'attach', '-d', '-t', 's']);
});
