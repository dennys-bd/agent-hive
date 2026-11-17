import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RunProcess } from '../src/machine.js';
import { RUN_OVER, RUN_STOPPED, RUN_TIMEOUT, runDetached } from '../src/machine-run.js';
import { posixShell } from '../src/posix-shell.js';
import { NO_POSIX_SIGNALS } from './posix-only.js';

// node itself as the child: the same script runs on macOS, Linux and the Windows lane
const node = (script: string, more: Partial<RunProcess> = {}): RunProcess => ({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: process.env, ...more });
const SETTLE_MAX_MS = 1000;
const LIMIT_MS = 10_000; // what would end a run whose cap or abort did not settle it
const GONE_TRIES = 100;
const GONE_MS = 20;

test('the input reaches stdin and the output comes back whole, with no failure (#158)', async () => {
  const ran = await runDetached(node('process.stdin.pipe(process.stdout)', { input: 'hello' }));
  assert.deepEqual([ran.code, ran.stdout.toString('utf8'), ran.failure], [0, 'hello', undefined]);
});

test('with no input stdin is closed: a read ends at once instead of waiting (#158)', async () => {
  const ran = await runDetached(node("process.stdin.on('end', () => process.stdout.write('eof')).resume()", { timeoutMs: LIMIT_MS }));
  assert.equal(ran.stdout.toString('utf8'), 'eof');
});

test('every chunk of either stream reaches onOutput as it comes, and the tail keeps the last lines (#158)', async () => {
  const seen: string[] = [];
  const ran = await runDetached(node("process.stdout.write('one\\n'); setTimeout(() => process.stderr.write('two\\n'), 50)", { onOutput: (text) => seen.push(text) }));
  assert.equal(seen.join(''), 'one\ntwo\n');
  assert.equal(ran.tail, 'one\ntwo');
});

test('output over maxBytes settles at once with its failure, never waiting for the process (#158)', async () => {
  const ran = await runDetached(node("process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)", { maxBytes: 1024, timeoutMs: LIMIT_MS }));
  assert.deepEqual([ran.code, ran.failure], [RUN_OVER, 'output over 1024 bytes']);
});

test('a non-zero exit answers its code, its failure and its stderr, never a rejection (#158)', async () => {
  const ran = await runDetached(node("process.stderr.write('boom'); process.exit(3)"));
  assert.deepEqual([ran.code, ran.failure, ran.stderr, ran.tail], [3, 'exit code 3', 'boom', 'boom']);
});

test('a command that is not there answers not found, never a rejection (#158)', async () => {
  const ran = await runDetached({ command: 'hive-no-such-command-158', args: [], cwd: process.cwd(), env: process.env });
  assert.deepEqual([ran.code, ran.failure], ['ENOENT', 'hive-no-such-command-158 not found']);
});

test('an abort settles at once as stopped, and a signal aborted before the run answers stopped too (#158)', async () => {
  const controller = new AbortController();
  const running = runDetached(node('setInterval(() => {}, 1000)', { signal: controller.signal, timeoutMs: LIMIT_MS }));
  controller.abort();
  const stopped = await running;
  assert.deepEqual([stopped.code, stopped.failure], [RUN_STOPPED, 'cancelled']);
  const before = await runDetached(node("process.stdout.write('ran')", { signal: AbortSignal.abort() }));
  assert.deepEqual([before.code, before.failure, before.stdout.length], [RUN_STOPPED, 'cancelled', 0]);
});

const isGroupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false; // ESRCH: no process of the group is left
  }
};

test('a timeout settles within a second and kills the whole group, a background child included (#158)', async (t) => {
  let printed = '';
  const startedAt = Date.now();
  const ran = await runDetached({ command: posixShell().shell, args: ['-c', 'echo $$; sleep 30 & sleep 30'], cwd: process.cwd(), env: process.env, timeoutMs: 200, onOutput: (text) => { printed += text; } });
  assert.ok(Date.now() - startedAt < SETTLE_MAX_MS, 'settled on the timer, not when the sleeps end');
  assert.deepEqual([ran.code, ran.failure], [RUN_TIMEOUT, 'timed out after 200 ms']);
  // sh's pid is its group's id off win32 (treeSpawnOptions' detached); the group's kill is a POSIX signal
  await t.test('no process of its group is left', { skip: NO_POSIX_SIGNALS }, async () => {
    const pgid = Number.parseInt(printed, 10);
    assert.ok(pgid > 0, 'sh printed its pid');
    for (let tries = 0; tries < GONE_TRIES && isGroupAlive(pgid); tries += 1) await sleep(GONE_MS);
    assert.equal(isGroupAlive(pgid), false);
  });
});
