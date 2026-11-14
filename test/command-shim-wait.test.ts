import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pty from 'node-pty';
import { commandShimSource, renderCommandShim } from '../src/command-shim.js';
import { ACQUIRE, type Answer, FAKE_EXIT, fakeOut, POSIX, RELEASE, type Rig, runShim, type Seen, SHIM_TIMEOUT_MS, setup, startShim, until } from './command-shim-rig.js';

// #801: a terminal answered wait stays in place, asking again every second, until run <name> is its turn
const NOW = 'now=true';
const INT_EXIT = 130;
const acquires = (seen: readonly Seen[]): Seen[] => seen.filter((s) => s.path === ACQUIRE);
// wait 2, wait 1, then the turn: the line moves before it comes
const moving: Answer = (n) => (n === 1 ? 'wait memory 2' : n === 2 ? 'wait memory 1' : 'run memory');

test('a wait stays in place, shows each place once, and runs the binary on its turn with the shim\'s stdin, then sends one release (#801)', { ...POSIX, timeout: SHIM_TIMEOUT_MS }, async (t) => {
  const { r, seen } = await setup(t, moving);
  const ran = await runShim(r, ['test'], { stdin: 'typed' });
  assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'], 'typed')]);
  assert.equal(ran.stderr, 'hive: pnpm waiting on memory · place 2 · Ctrl-C leaves\nhive: pnpm waiting on memory · place 1 · Ctrl-C leaves\n');
  assert.deepEqual(seen.map((s) => [s.path, s.childDone]), [[ACQUIRE, false], [ACQUIRE, false], [ACQUIRE, false], [RELEASE, true]]);
  assert.ok(ran.ms >= 1_500, 'it asked again about every second, not in a busy loop');
});

test('with stdin not a TTY the key is never offered nor sent: no acquire carries now (#801)', { ...POSIX, timeout: SHIM_TIMEOUT_MS }, async (t) => {
  const { r, seen } = await setup(t, moving);
  const ran = await runShim(r, ['test'], { stdin: 'r' });
  assert.equal(ran.code, FAKE_EXIT);
  assert.doesNotMatch(ran.stderr, / r /);
  assert.ok(acquires(seen).every((s) => !s.body.includes(NOW)));
});

test('in Portuguese the wait\'s line speaks it, with the place as an ordinal (#801)', { ...POSIX, timeout: SHIM_TIMEOUT_MS }, async (t) => {
  const { r } = await setup(t, moving);
  await writeFile(r.shim, renderCommandShim(await readFile(commandShimSource(), 'utf8'), 'pnpm', 'pt'));
  const ran = await runShim(r, ['test']);
  assert.match(ran.stderr, /^hive: pnpm aguardando a vez de memory · 2º · Ctrl-C sai$/m);
});

test('an answer the wait does not know gives the place back and runs the binary as typed (#801)', { ...POSIX, timeout: SHIM_TIMEOUT_MS }, async (t) => {
  const { r, seen } = await setup(t, (n) => (n === 1 ? 'wait memory 1' : 'run'));
  const ran = await runShim(r, ['test'], { stdin: 'typed' });
  assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'], 'typed')]);
  assert.deepEqual(seen.map((s) => [s.path, s.childDone]), [[ACQUIRE, false], [ACQUIRE, false], [RELEASE, false]]);
  assert.deepEqual(JSON.parse(seen[2].body), { semaphore: 'memory' });
});

for (const [signal, code] of [['SIGINT', INT_EXIT], ['SIGTERM', 143]] as const) {
  test(`a ${signal} while waiting leaves the line: one release, exit ${code}, and the binary never runs (#801)`, { ...POSIX, timeout: SHIM_TIMEOUT_MS }, async (t) => {
    const { r, seen } = await setup(t, 'wait memory 1');
    const shim = startShim(r, ['test']);
    await until(() => acquires(seen).length > 1); // past the first answer: the wait's traps are set (before them the pid check frees it, #798)
    shim.kill(signal);
    const ran = await shim.done;
    assert.equal(ran.code, code);
    assert.equal(ran.stdout, '');
    assert.deepEqual(seen.filter((s) => s.path === RELEASE).map((s) => JSON.parse(s.body)), [{ semaphore: 'memory' }]);
  });
}

// A real terminal: the shim under sh in a pty, as a task's terminal runs it
function inTerminal(r: Rig): { term: pty.IPty; output(): string; exited: Promise<number> } {
  const term = pty.spawn('/bin/sh', [r.shim, 'test'], { env: r.env as Record<string, string>, cols: 200, rows: 10 });
  let out = '';
  term.onData((d) => { out += d; });
  const exited = new Promise<number>((resolve) => term.onExit(({ exitCode }) => resolve(exitCode)));
  return { term, output: () => out, exited };
}

test('in a terminal r runs it now: the next acquire carries now, the binary runs and the terminal is back in canonical mode (#801)', { ...POSIX, timeout: SHIM_TIMEOUT_MS }, async (t) => {
  const { r, seen } = await setup(t, (_n, body) => (body.includes(NOW) ? 'run memory' : 'wait memory 3'));
  const shell = inTerminal(r);
  await until(() => shell.output().includes('r runs it now'));
  assert.ok(shell.output().includes('\r\x1b[Khive: pnpm waiting on memory · place 3 · r runs it now · Ctrl-C leaves'), 'rewritten in place');
  shell.term.write('x\r'); // any other key is dropped
  await until(() => acquires(seen).length >= 2);
  assert.ok(!acquires(seen)[1].body.includes(NOW));
  shell.term.write('r');
  await until(() => shell.output().includes('stdin:') || acquires(seen).some((s) => s.body.includes(NOW)));
  shell.term.write('typed\n\x04'); // the binary's cat reads lines again: the tty was restored
  assert.equal(await shell.exited, FAKE_EXIT);
  assert.match(shell.output(), /stdin:typed/);
  assert.ok(acquires(seen).at(-1)?.body.includes(NOW));
  assert.equal(seen.at(-1)?.path, RELEASE);
});

test('in a terminal Ctrl-C while waiting ends the shim and sends the release (#801)', { ...POSIX, timeout: SHIM_TIMEOUT_MS }, async (t) => {
  const { r, seen } = await setup(t, 'wait memory 1');
  const shell = inTerminal(r);
  await until(() => shell.output().includes('Ctrl-C leaves'));
  shell.term.write('\x03');
  assert.equal(await shell.exited, INT_EXIT);
  assert.equal(seen.filter((s) => s.path === RELEASE).length, 1);
  assert.doesNotMatch(shell.output(), /stdin:/);
});
