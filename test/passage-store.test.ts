import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPassageStore, passagesDir, protocolRenderer } from '../src/passage-store.js';
import { AFTER_MESSAGE } from '../src/protocol-inserts.js';
import { renderProtocol } from '../src/protocol.js';
import { tempDir } from './temp-dir.js';

const A = '---\nafter: ask\n---\nfirst\n';
const B = '---\nafter: done\n---\nsecond\n';
const C = '---\nafter: why\n---\nthird\n';

test('create, change and remove on a temp home: ids p1, p2, then p3 after p1 is removed while p2 remains; files 0600 in a 0700 folder, no temp file left (#336)', async (t) => {
  const home = await tempDir(t, 'home-');
  const store = createPassageStore(home);
  assert.deepEqual(await store.list(), [], 'no folder yet: none');
  assert.deepEqual(await Promise.all([store.create(A), store.create(B)]), [{ id: 'p1' }, { id: 'p2' }], 'one chain: two creates in flight never share an id');
  assert.equal(await store.remove('p1'), true);
  assert.deepEqual(await store.create(C), { id: 'p3' });
  assert.deepEqual(await store.change('p2', C), { id: 'p2' });
  assert.deepEqual(await store.list(), [{ id: 'p2', text: C }, { id: 'p3', text: C }]);
  const dir = passagesDir(home);
  assert.deepEqual((await readdir(dir)).sort(), ['p2.md.liquid', 'p3.md.liquid']);
  assert.deepEqual([(await stat(dir)).mode & 0o777, (await stat(join(dir, 'p3.md.liquid'))).mode & 0o777], [0o700, 0o600]);
});

test('a text that does not pass is refused with its errors and nothing written; an unknown or malformed id is no passage (#336)', async (t) => {
  const home = await tempDir(t, 'home-');
  const store = createPassageStore(home);
  assert.deepEqual(await store.create('---\nafter: nowhere\n---\nx\n'), { errors: [{ line: 2, message: AFTER_MESSAGE }] });
  assert.deepEqual(await store.list(), []);
  await store.create(A);
  assert.deepEqual(await store.change('p1', 'no header'), { errors: [{ line: 2, message: AFTER_MESSAGE }] });
  assert.equal(await readFile(join(passagesDir(home), 'p1.md.liquid'), 'utf8'), A, 'unchanged');
  for (const id of ['p9', '../p1', 'p01', 'x']) {
    assert.equal(await store.change(id, A), undefined, id);
    assert.equal(await store.remove(id), false, id);
  }
});

test('list reads only the passage files, in id order, and an unknown file or a leftover temp file is ignored (#336)', async (t) => {
  const home = await tempDir(t, 'home-');
  const dir = passagesDir(home);
  await mkdir(dir, { recursive: true });
  for (const [name, text] of [['p10.md.liquid', B], ['p2.md.liquid', A], ['p3.md.liquid.tmp', C], ['notes.md', C]]) await writeFile(join(dir, name), text);
  assert.deepEqual((await createPassageStore(home).list()).map((p) => p.id), ['p2', 'p10']);
  assert.deepEqual(await createPassageStore(home).create(C), { id: 'p11' });
});

test('protocolRenderer renders the passages for the workspace into every kind, leaves out and logs one that fails there, and a folder it cannot read costs the passages only (#336)', async (t) => {
  const home = await tempDir(t, 'home-');
  const store = createPassageStore(home);
  await store.create(A);
  await store.create('---\nafter: done\nvariables:\n  team: { required: true, workspaces: { a: core } }\n---\nAsk {{ team }}.\n');
  const logged: string[] = [];
  const logger = { error: (line: string): void => void logged.push(line) }; // before any assert narrows `logged`
  const protocolFor = protocolRenderer(store, logger);
  const forA = await protocolFor('a', ['hive_remember']);
  const first = { id: 'p1', after: 'ask', orphan: false, text: 'first', errors: [] };
  assert.equal(forA.stage, renderProtocol('stage', ['hive_remember'], [first, { id: 'p2', after: 'done', orphan: false, text: 'Ask core.', errors: [] }]));
  assert.deepEqual(logged, []);
  const forB = await protocolFor('b', []);
  assert.deepEqual(forB, { stage: renderProtocol('stage', [], [first]), session: renderProtocol('session', [], [first]), local: renderProtocol('local', [], [first]) });
  assert.deepEqual(logged, ['protocol b: p2:4 variable "team" is required and has no value for workspace "b"']);
  const broken = protocolRenderer({ list: () => Promise.reject(new Error('EACCES')) }, logger);
  assert.equal((await broken('a', [])).stage, renderProtocol('stage', [], []));
  assert.match(logged.at(-1) ?? '', /^protocol: passages unreadable \(Error\)$/);
});
