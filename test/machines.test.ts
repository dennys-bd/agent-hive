import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Machine, MachineError, pathsOf } from '../src/machine.js';
import { createMachines, unavailableMachine } from '../src/machines.js';
import type { PtyHandlers } from '../src/types.js';
import { fakeMachine } from './fake-machine.js';

const local = fakeMachine();
const HANDLERS = {} as PtyHandlers; // never called: spawn throws first
const unavailable = (reason: string) => (err: unknown): boolean =>
  err instanceof MachineError && err.code === MachineError.UNAVAILABLE && err.reason === reason;

test('for answers the local machine for an activity with no machine and for local (#931)', () => {
  const machines = createMachines({ local, platform: 'darwin' });
  assert.equal(machines.local, local);
  assert.equal(machines.for({}), local);
  assert.equal(machines.for({ machine: 'local' }), local);
});

test('a wsl: id off win32 is a machine that refuses every call with machine_unavailable and not_windows (#931)', async () => {
  const machine = createMachines({ local, platform: 'darwin' }).for({ machine: 'wsl:X' });
  assert.equal(machine.id, 'wsl:X');
  assert.equal(machine.paths, pathsOf('linux'), 'a distro\'s disk joins with /');
  await assert.rejects(machine.exec('git', ['status']), unavailable('not_windows'));
  await assert.rejects(machine.fs.stat('/home/u/repo'), unavailable('not_windows'));
  await assert.rejects(machine.fs.stat('/home/u/repo'), { message: 'machine wsl:X is unavailable: not_windows' });
  assert.throws(() => machine.info(), unavailable('not_windows'));
});

test('on win32 a wsl: id with no factory is not_supported, and so is any id that is neither local nor wsl: (#931)', async () => {
  await assert.rejects(createMachines({ local, platform: 'win32' }).for({ machine: 'wsl:X' }).fs.stat('/x'), unavailable('not_supported'));
  await assert.rejects(createMachines({ local, platform: 'darwin' }).for({ machine: 'AB:CD' }).exec('git', []), unavailable('not_supported'));
});

test('on win32 with a factory, a wsl: id answers the factory\'s machine, built once for two calls (#931)', () => {
  const built: string[] = [];
  const wsl = (distro: string): Machine => {
    built.push(distro);
    return fakeMachine({ id: `wsl:${distro}` });
  };
  const machines = createMachines({ local, platform: 'win32', wsl });
  const first = machines.for({ machine: 'wsl:Debian-13' });
  assert.equal(first.id, 'wsl:Debian-13');
  assert.equal(machines.for({ machine: 'wsl:Debian-13' }), first);
  assert.deepEqual(built, ['Debian-13']);
});

test('the unavailable machine: run and every fs method reject, readLines on its first next(), the sync members throw, pty answers as for an unknown pty (#931)', async () => {
  const machine = unavailableMachine('wsl:X', 'not_windows');
  const is = unavailable('not_windows');
  await assert.rejects(machine.run({ command: 'git', args: [], cwd: '/', env: {} }), is);
  await assert.rejects(machine.fs.readFile('/a', { maxBytes: 1 }), is);
  await assert.rejects(machine.fs.writeAtomic('/a', ''), is);
  const lines = machine.fs.readLines('/a', { maxBytes: 1 })[Symbol.asyncIterator]();
  await assert.rejects(lines.next(), is);
  assert.throws(() => machine.process('git', [], { cwd: '/', env: {} }), is);
  assert.throws(() => machine.pty.spawn({ ptyId: 'p', slug: 's', cwd: '/' }, HANDLERS), is);
  assert.deepEqual(
    [machine.pty.has('p'), machine.pty.pid('p'), machine.pty.write('p', 'x'), machine.pty.resize('p', 80, 24), machine.pty.kill('p'), machine.pty.subscribe('p', () => {}, () => {})],
    [false, undefined, false, false, false, undefined],
  );
});

test('the unavailable machine\'s watch reports machine_unavailable through onError after it returned, and no event; close() first suppresses it (#935)', async () => {
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const machine = unavailableMachine('wsl:X', 'not_windows');
  const errors: unknown[] = [];
  machine.watch('/home/u/repo', { recursive: true }, () => assert.fail('no event'), (err) => errors.push(err));
  assert.deepEqual(errors, []);
  await settle();
  assert.equal(errors.length, 1);
  assert.ok(unavailable('not_windows')(errors[0]));
  const suppressed: unknown[] = [];
  machine.watch('/home/u/repo', { recursive: true }, () => undefined, (err) => suppressed.push(err)).close();
  await settle();
  assert.deepEqual(suppressed, []);
});
