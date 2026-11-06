import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkHome, checkHomeAcl, refusedPrincipals, type AclLookups } from '../src/home-acl.js';
import { tempDir } from './temp-dir.js';

const ON_WINDOWS = { skip: process.platform !== 'win32' };
const ME = 'S-1-5-21-1-2-3-1001';
const HEAD = `O:${ME}G:S-1-5-21-1-2-3-513D:P`;
const PROFILE = `${HEAD}(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${ME})`;
const INHERITED = `D:AI(A;OICIID;FA;;;S-1-5-18)(A;OICIID;FA;;;S-1-5-32-544)(A;OICIIOID;GA;;;CO)(A;OICIID;FA;;;${ME})`;
const oneLine = (err: unknown): boolean => err instanceof Error && !err.message.includes('\n');

test('the profile default and its inherited form refuse nobody (#628)', () => {
  assert.deepEqual(refusedPrincipals(PROFILE, ME), []);
  assert.deepEqual(refusedPrincipals(INHERITED, ME), []);
});

test('one more allow with read from BU, WD or another account is refused and named once (#628)', () => {
  assert.deepEqual(refusedPrincipals(`${PROFILE}(A;OICI;FR;;;BU)`, ME), ['BU']);
  assert.deepEqual(refusedPrincipals(`${PROFILE}(A;OICI;GR;;;WD)(A;;GR;;;WD)`, ME), ['WD']);
  assert.deepEqual(refusedPrincipals(`${PROFILE}(A;OICI;0x1200a9;;;S-1-5-21-9-9-9-1002)`, ME), ['S-1-5-21-9-9-9-1002']);
});

test('a deny never refuses, and an allow without read bits passes (#628)', () => {
  assert.deepEqual(refusedPrincipals(`${PROFILE}(D;OICI;FA;;;WD)`, ME), []);
  assert.deepEqual(refusedPrincipals(`${PROFILE}(A;;0x100000;;;WD)(A;;0x2;;;BU)`, ME), []);
});

test('a null DACL, conditional and object allows, and generic or bare read-data masks are refused (#628)', () => {
  assert.deepEqual(refusedPrincipals(`O:${ME}D:NO_ACCESS_CONTROL`, ME), ['WD']);
  assert.deepEqual(refusedPrincipals(`${PROFILE}(XA;;FR;;;WD;(@User.x == "S:y"))(A;;GR;;;BU)`, ME), ['WD', 'BU']);
  assert.deepEqual(refusedPrincipals(`${PROFILE}(OA;;0x80000000;;;AU)(A;;0x10000000;;;IU)(A;;0x1;;;NU)(A;OICIIO;FRFX;;;AN)`, ME), ['AU', 'IU', 'NU', 'AN']);
});

test('the SACL after the DACL and an empty DACL refuse nobody (#628)', () => {
  assert.deepEqual(refusedPrincipals(`${PROFILE}S:AI(AU;SA;FA;;;WD)`, ME), []);
  assert.deepEqual(refusedPrincipals(`O:${ME}D:P`, ME), []);
});

test('the fix makes inherited entries explicit, then removes the SIDs, aliases mapped (#628)', () => {
  const home = 'C:\\Users\\me\\.hive';
  assert.throws(() => checkHomeAcl('win32', home, { read: () => ({ sddl: `${PROFILE}(A;OICIID;FR;;;AU)`, userSid: ME }) }),
    (err) => (err as Error).message.includes(`icacls "${home}" /inheritance:d, then icacls "${home}" /remove *S-1-5-11`));
});

test('SDDL with no DACL or a malformed ACE throws (#628)', () => {
  assert.throws(() => refusedPrincipals(`O:${ME}`, ME));
  assert.throws(() => refusedPrincipals('D:(A;OICI;FA)', ME));
});

test('darwin and linux never call the lookups (#628)', () => {
  const untouched: AclLookups = { read: () => assert.fail('the ACL was read') };
  for (const platform of ['darwin', 'linux'] as const) checkHomeAcl(platform, '/home/x', untouched);
});

test('on win32 a reader that throws, or SDDL that does not parse, is one line naming the home (#628)', () => {
  const home = 'C:\\Users\\me\\.hive';
  const named = (err: unknown): boolean => oneLine(err) && (err as Error).message.includes(home);
  assert.throws(() => checkHomeAcl('win32', home, { read: () => { throw new Error('no powershell'); } }), named);
  assert.throws(() => checkHomeAcl('win32', home, { read: () => ({ sddl: 'garbage', userSid: ME }) }), named);
});

test('on win32 a readable home is refused in one line naming the home and the SID (#628)', () => {
  const home = 'C:\\Users\\me\\.hive';
  const sddl = `${PROFILE}(A;OICI;FR;;;S-1-1-0)`;
  assert.throws(() => checkHomeAcl('win32', home, { read: () => ({ sddl, userSid: ME }) }),
    (err) => oneLine(err) && (err as Error).message.includes(home) && (err as Error).message.includes('S-1-1-0'));
  assert.doesNotThrow(() => checkHomeAcl('win32', home, { read: () => ({ sddl: PROFILE, userSid: ME }) }));
});

test('a fresh temp home passes, and one granted to Everyone is refused (#628)', ON_WINDOWS, async (t) => {
  const home = await tempDir(t, 'acl');
  checkHome(home);
  execFileSync('icacls', [home, '/grant', '*S-1-1-0:R']);
  assert.throws(() => checkHome(home), (err) => oneLine(err) && (err as Error).message.includes(home));
});
