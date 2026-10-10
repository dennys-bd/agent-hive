import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localeEnv, readSystemLang, type SystemReads } from '../src/locale-env.js';

test('a Finder launch on macOS gets LANG from the system and stays UTF-8', () => {
  assert.deepEqual(localeEnv({}, 'darwin', 'pt_BR.UTF-8'), { LANG: 'pt_BR.UTF-8' });
});

test('without a system locale, macOS gets LC_CTYPE UTF-8 and no LANG', () => {
  assert.deepEqual(localeEnv({}, 'darwin', undefined), { LC_CTYPE: 'UTF-8' });
});

test('Linux falls back to C.UTF-8', () => {
  assert.deepEqual(localeEnv({ LANG: '' }, 'linux', undefined), { LC_CTYPE: 'C.UTF-8' });
});

test('a UTF-8 LANG already set is left as it is', () => {
  assert.deepEqual(localeEnv({ LANG: 'en_US.UTF-8' }, 'darwin', 'pt_BR.UTF-8'), {});
});

test('LANG=C keeps its LANG and gets a UTF-8 LC_CTYPE', () => {
  assert.deepEqual(localeEnv({ LANG: 'C' }, 'darwin', 'pt_BR.UTF-8'), { LC_CTYPE: 'UTF-8' });
});

test('a system locale that is not UTF-8 still gets LC_CTYPE', () => {
  assert.deepEqual(localeEnv({}, 'linux', 'pt_BR'), { LANG: 'pt_BR', LC_CTYPE: 'C.UTF-8' });
});

test('a UTF-8 LC_CTYPE needs nothing more than LANG', () => {
  assert.deepEqual(localeEnv({ LC_CTYPE: 'UTF-8' }, 'darwin', 'pt_BR.UTF-8'), { LANG: 'pt_BR.UTF-8' });
});

test('an LC_CTYPE already set is kept, even one that is not UTF-8', () => {
  assert.deepEqual(localeEnv({ LC_CTYPE: 'en_US.ISO8859-1' }, 'darwin', 'pt_BR.UTF-8'), { LANG: 'pt_BR.UTF-8' });
  assert.deepEqual(localeEnv({ LANG: 'C', LC_CTYPE: 'C' }, 'linux', undefined), {});
});

test('an explicit LC_ALL is the user\'s choice, UTF-8 or not', () => {
  assert.deepEqual(localeEnv({ LC_ALL: 'C' }, 'darwin', undefined), {});
  assert.deepEqual(localeEnv({ LC_ALL: 'en_US.utf8' }, 'linux', undefined), {});
});

const reads = (over: Partial<SystemReads>): SystemReads => ({
  appleLocale: () => undefined,
  readFile: () => undefined,
  exists: () => true,
  ...over,
});

test('macOS reads AppleLocale without its @ suffix', () => {
  assert.equal(readSystemLang('darwin', reads({ appleLocale: () => 'en_BR@rg=brzzzz\n' })), 'en_BR.UTF-8');
});

test('macOS drops a locale with no directory in /usr/share/locale', () => {
  const seen: string[] = [];
  const exists = (path: string): boolean => {
    seen.push(path);
    return false;
  };
  assert.equal(readSystemLang('darwin', reads({ appleLocale: () => 'xx_YY', exists })), undefined);
  assert.deepEqual(seen, ['/usr/share/locale/xx_YY.UTF-8']);
});

test('macOS without AppleLocale has no system locale', () => {
  assert.equal(readSystemLang('darwin', reads({})), undefined);
});

test('Linux reads LANG from /etc/locale.conf, quotes and all', () => {
  const files: Record<string, string> = { '/etc/locale.conf': '# comment\nLC_TIME=C\nLANG="pt_BR.UTF-8"\n' };
  assert.equal(readSystemLang('linux', reads({ readFile: (path) => files[path] })), 'pt_BR.UTF-8');
});

test('a value that is not a locale name is not taken as LANG', () => {
  assert.equal(readSystemLang('darwin', reads({ appleLocale: () => '../../tmp/x' })), undefined);
  assert.equal(readSystemLang('linux', reads({ readFile: () => 'LANG=x;rm$(id)\n' })), undefined);
});

test('Linux falls back to /etc/default/locale', () => {
  const files: Record<string, string> = { '/etc/default/locale': 'LANG=en_US.UTF-8\n' };
  assert.equal(readSystemLang('linux', reads({ readFile: (path) => files[path] })), 'en_US.UTF-8');
});

test('Linux with neither file has no system locale', () => {
  assert.equal(readSystemLang('linux', reads({})), undefined);
});
