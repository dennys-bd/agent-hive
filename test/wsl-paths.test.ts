import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MachineError } from '../src/machine.js';
import { toDistroPath, toWindowsPath } from '../src/wsl/wsl-paths.js';

const badPath = (err: unknown): boolean => err instanceof MachineError && err.code === MachineError.BAD_PATH;

test('toWindowsPath answers the distro\'s UNC path, and the root as the share itself (#939)', () => {
  assert.equal(toWindowsPath('Debian', '/home/u/r'), '\\\\wsl.localhost\\Debian\\home\\u\\r');
  assert.equal(toWindowsPath('Debian', '/'), '\\\\wsl.localhost\\Debian\\');
  assert.equal(toWindowsPath('Debian', '/a/../b//c/'), '\\\\wsl.localhost\\Debian\\b\\c');
});

test('toWindowsPath refuses a relative path (#939)', () => {
  assert.throws(() => toWindowsPath('Debian', 'home/u'), badPath);
  assert.throws(() => toWindowsPath('Debian', ''), badPath);
});

test('toDistroPath reads both UNC prefixes, either separator, host and distro in any case (#939)', () => {
  assert.equal(toDistroPath('Debian', '\\\\wsl.localhost\\Debian\\home\\u\\r'), '/home/u/r');
  assert.equal(toDistroPath('Debian', '\\\\wsl$\\Debian\\home\\u'), '/home/u');
  assert.equal(toDistroPath('Debian', '\\\\WSL.LocalHost\\DEBIAN/home/u'), '/home/u');
  assert.equal(toDistroPath('Debian', '\\\\wsl.localhost\\Debian\\'), '/');
  assert.equal(toDistroPath('Debian', '\\\\wsl.localhost\\Debian'), '/');
});

test('toDistroPath refuses another distro, a path that is not a WSL UNC one, and a .. out of the root (#939)', () => {
  assert.throws(() => toDistroPath('Debian', '\\\\wsl.localhost\\Ubuntu\\home'), badPath);
  assert.throws(() => toDistroPath('Debian', '\\\\wsl.localhostile\\Debian\\home'), badPath);
  assert.throws(() => toDistroPath('Debian', 'C:\\Users\\u'), badPath);
  assert.throws(() => toDistroPath('Debian', '/home/u'), badPath);
  assert.throws(() => toDistroPath('Debian', '\\\\server\\share\\x'), badPath);
  assert.throws(() => toDistroPath('Debian', '\\\\wsl.localhost\\Debian\\..\\..\\etc'), badPath);
});

test('toDistroPath keeps a .. that stays inside the root, and the round trip holds (#939)', () => {
  assert.equal(toDistroPath('Debian', '\\\\wsl.localhost\\Debian\\a\\..\\b'), '/b');
  for (const p of ['/', '/home/u/r', '/a b/ç/ü']) assert.equal(toDistroPath('Debian', toWindowsPath('Debian', p)), p);
});

test('toWindowsPath refuses a file name with a backslash, which Windows would read as a separator, and a bad distro (#939)', () => {
  assert.throws(() => toWindowsPath('Debian', '/a\\..\\..\\b'), (err: unknown) => err instanceof MachineError && err.code === MachineError.BAD_PATH);
  assert.throws(() => toWindowsPath('-x', '/a'), (err: unknown) => err instanceof MachineError && err.code === MachineError.BAD_PATH);
});

test('toWindowsPath refuses a name Windows forbids, so a " cannot end explorer.exe\'s quoted /select argument (#932)', () => {
  for (const name of ['a" /root,x "', 'a<b', 'a|b', 'a?b', 'a*b', 'a:b', 'a\u0001b']) {
    assert.throws(() => toWindowsPath('Debian', `/home/u/${name}`), (err: unknown) => err instanceof MachineError && err.code === MachineError.BAD_PATH, name);
  }
  assert.equal(toWindowsPath('Debian', '/home/u/a b.ts'), '\\\\wsl.localhost\\Debian\\home\\u\\a b.ts');
});
