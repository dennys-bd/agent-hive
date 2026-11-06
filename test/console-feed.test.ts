import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandChannel, createConsoleStore } from '../src/console.js';
import { feedConsole, TIMED_OUT_EXIT } from '../src/console-feed.js';
import { createPtyHost } from '../src/pty-host.js';
import { fakePtys } from './fakes.js';

const CTRL_C_EXIT = 0xc000013a; // one code a ConPTY's program exits with when its pty is killed (#644)
const MAX_LINES = 1000;
const TIMEOUT = '30s';
const TIMEOUT_MS = 30_000;

// A command terminal's run C1 fed into its console as server-spawn.ts feeds it: the pty a fake, the store real, and its Stop the host's kill
function fed(timeout?: string) {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn('C1', ['/bin/sh', '-c', 'make'], '/wt', {});
  const store = createConsoleStore(() => MAX_LINES);
  const ends: number[] = [];
  const isFed = feedConsole({ ptys: host, consoleStore: store }, commandChannel('hive', 'make'), 'C1', {
    label: '#C1', timeout, onTimeout: () => host.kill('C1'), onEnd: (code) => ends.push(code),
  });
  assert.equal(isFed, true);
  return { host, pty: ptys[0], store, ends };
}

test('a run the host killed ends its console as done, whatever code the pty exits with: 0 under macOS\'s pty, 1 or 0xC000013A under ConPTY (#644)', () => {
  for (const code of [0, 1, CTRL_C_EXIT]) {
    const { host, pty, store, ends } = fed();
    host.kill('C1');
    pty.exit(code);
    assert.deepEqual([ends, store.channels()[0]?.status], [[0], 'done'], String(code));
  }
});

test('a run that exits 1 on its own still ends its console as failed (#644)', () => {
  const { pty, store, ends } = fed();
  pty.exit(1);
  assert.deepEqual([ends, store.channels()[0]?.status], [[1], 'failed']);
});

test('a run its timeout stopped ends with TIMED_OUT_EXIT whatever its kill exited with: the timeout wins over the kill it caused (#537, #644)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const code of [0, 1, CTRL_C_EXIT]) {
    const { pty, store, ends } = fed(TIMEOUT);
    t.mock.timers.tick(TIMEOUT_MS);
    assert.equal(pty.killed, 1, 'the timeout killed it through the host');
    pty.exit(code);
    assert.deepEqual([ends, store.channels()[0]?.status], [[TIMED_OUT_EXIT], 'failed'], String(code));
  }
});
