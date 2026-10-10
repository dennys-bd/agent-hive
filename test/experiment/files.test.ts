import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pngsIn, readJson, serialStore, writeJson } from '../../scripts/experiment/files.js';
import { tempDir } from '../temp-dir.js';

test('writeJson writes through a temp file and readJson reads it back, through a parser, undefined when missing (#105)', async (t) => {
  const dir = await tempDir(t, 'files-');
  const path = join(dir, 'x.json');
  assert.equal(await readJson(path), undefined);
  await writeJson(path, { a: 1 });
  assert.deepEqual(await readJson(path), { a: 1 });
  assert.equal(await readJson(path, (raw) => (raw as { a: number }).a + 1), 2);
  assert.deepEqual(await readdir(dir), ['x.json']);
  await writeFile(path, '{oops');
  await assert.rejects(readJson(path), SyntaxError);
});

test('pngsIn lists the PNGs of a folder, sorted and filtered, none for a missing folder (#105)', async (t) => {
  const dir = await tempDir(t, 'files-');
  for (const name of ['b.png', 'a.png', 'notes.txt', 'dashboard.png']) await writeFile(join(dir, name), '');
  assert.deepEqual(await pngsIn(dir, (n) => n !== 'dashboard.png'), [join(dir, 'a.png'), join(dir, 'b.png')]);
  assert.deepEqual(await pngsIn(join(dir, 'missing')), []);
});

test('serialStore applies concurrent updates in turn, loses none, and writes each one (#105)', async (t) => {
  const path = join(await tempDir(t, 'files-'), 'm.json');
  const store = serialStore(path, { n: [] as number[] });
  await Promise.all([1, 2, 3].map((k) => store.update((v) => ({ n: [...v.n, k] }))));
  assert.deepEqual(store.get(), { n: [1, 2, 3] });
  assert.deepEqual(await readJson(path), { n: [1, 2, 3] });
});
