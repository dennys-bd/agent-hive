import { expect, test } from 'vitest';
import { baseName } from '../../src/base-name';

test('baseName answers the last segment of a Windows, a POSIX and a relative path (#641)', () => {
  for (const path of ['C:\\repo\\src\\a.ts', '/repo/src/a.ts', 'src/a.ts', 'a.ts']) expect(baseName(path), path).toBe('a.ts');
});

test('baseName: a trailing separator still names the folder; with nothing left it answers the input (#641)', () => {
  expect(baseName('C:\\repo\\')).toBe('repo');
  expect(baseName('/repo/')).toBe('repo');
  expect([baseName(''), baseName('/')]).toEqual(['', '/']);
});
