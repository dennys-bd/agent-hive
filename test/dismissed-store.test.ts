import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ORIGINAL_KEY, readDismissed, writeDismissed } from '../src/dismissed-store.js';
import { fakeLog } from './fakes.js';
import { tempDir } from './temp-dir.js';

// The editor's dismissed annotations (#327): one file per item, the keys per version
const BUILD = { origin: 'hive', name: 'new-build' };

test('the dismissed keys round-trip per version, the original under its own key (#327)', async (t) => {
  const home = await tempDir(t, 'dismissed-');
  const { log } = fakeLog();
  assert.deepEqual(await writeDismissed(home, BUILD, null, ['a'], log), ['a']);
  assert.deepEqual(await writeDismissed(home, BUILD, 'mine', ['b', 'c'], log), ['b', 'c']);
  assert.deepEqual(
    [await readDismissed(home, BUILD, null, log), await readDismissed(home, BUILD, 'mine', log), await readDismissed(home, BUILD, 'tdd', log)],
    [['a'], ['b', 'c'], []],
  );
  const file = JSON.parse(await readFile(join(home, 'custom/hive/new-build/dismissed.json'), 'utf8'));
  assert.deepEqual(file, { [ORIGINAL_KEY]: ['a'], mine: ['b', 'c'] });
});

test('a missing file reads as empty; one that does not parse reads as empty and is logged (#327)', async (t) => {
  const home = await tempDir(t, 'dismissed-');
  const { log, lines } = fakeLog();
  assert.deepEqual(await readDismissed(home, BUILD, null, log), []);
  assert.equal(lines.length, 0); // deepEqual would narrow lines to never[]
  await mkdir(join(home, 'custom/hive/new-build'), { recursive: true });
  await writeFile(join(home, 'custom/hive/new-build/dismissed.json'), '{ not json');
  assert.deepEqual(await readDismissed(home, BUILD, 'mine', log), []);
  assert.ok(lines.some((line) => line.startsWith('ERROR dismissed: ')), lines.join('\n'));
});

test('nothing is written outside <home>/custom/ (#327)', async (t) => {
  const home = await tempDir(t, 'dismissed-');
  await assert.rejects(writeDismissed(home, { origin: '..', name: 'escape' }, null, ['a'], fakeLog().log), /outside the custom store/);
  await assert.rejects(stat(join(home, 'escape')));
});
