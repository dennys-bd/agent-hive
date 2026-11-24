import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Machine, MachineError, pathsOf } from '../src/machine.js';
import { createMachines, machineRefusal, NOT_SUPPORTED, unavailableMachine, unavailableRefusal, whenAvailable } from '../src/machines.js';
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
  assert.throws(() => machine.pty.spawn({ ptyId: 'p', slug: 's', workspace: 'w', cwd: '/' }, HANDLERS), is);
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

test('close() closes every machine the registry made that holds something, and leaves local alone (#945)', () => {
  let localCloses = 0;
  const closed: string[] = [];
  const local2 = { ...fakeMachine(), close: () => { localCloses += 1; } };
  const wsl = (distro: string) => ({ ...fakeMachine({ id: `wsl:${distro}` }), close: () => { closed.push(distro); } });
  const machines = createMachines({ local: local2, platform: 'win32', wsl });
  machines.for({ machine: 'wsl:A' });
  machines.for({ machine: 'wsl:B' });
  machines.for({ machine: 'wsl:A' });
  machines.for({ machine: 'AB:CD' }); // an unavailable machine has nothing to close
  machines.close();
  assert.deepEqual([closed, localCloses], [['A', 'B'], 0]);
});

test('machineRefusal answers the 409 of an unavailable machine with its id and reason, and nothing for a folder that is only missing (#931, #932)', async () => {
  assert.deepEqual(await machineRefusal(unavailableMachine('wsl:X', 'not_windows'), '/home/u/repo'), {
    status: 409, message: 'machine wsl:X is unavailable: not_windows', code: 'machine_unavailable', machine: 'wsl:X', reason: 'not_windows',
  });
  assert.equal(await machineRefusal(local, '/nowhere/at/all'), undefined, 'ENOENT is the caller\'s to meet');
  assert.equal(unavailableRefusal(new Error('boom'), 'wsl:X'), undefined);
});

test('whenAvailable answers `none` for a machine that is unavailable, sync throws included, and lets any other failure through (#932)', async () => {
  const down = unavailableMachine('wsl:Y', NOT_SUPPORTED);
  assert.deepEqual(await whenAvailable(() => down.fs.readdir('/x'), []), []);
  assert.equal(await whenAvailable(async () => down.info().path, 'none'), 'none');
  await assert.rejects(whenAvailable(() => Promise.reject(new Error('git broke')), []), { message: 'git broke' });
});
