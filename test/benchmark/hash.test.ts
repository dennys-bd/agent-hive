import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, FS_READS, seedHash, tasksHash, treeHash } from '../../src/benchmark/hash.js';
import type { BenchSeed } from '../../src/types.js';
import { put } from '../custom-fixture.js';
import { tempDir } from '../temp-dir.js';

const FILES: [string, string][] = [['a.md', 'a'], ['skills/b/SKILL.md', 'b'], ['agents/c.md', 'c']];

test('the same tree written in two orders hashes the same; one changed byte changes it (#459)', async (t) => {
  const [one, two] = await Promise.all([tempDir(t, 'hash-1-'), tempDir(t, 'hash-2-')]);
  await put(one, Object.fromEntries(FILES));
  await put(two, Object.fromEntries([...FILES].reverse()));
  assert.equal(await treeHash({ source: one }), await treeHash({ source: two }));
  await writeFile(join(two, 'a.md'), 'A');
  assert.notEqual(await treeHash({ source: one }), await treeHash({ source: two }));
});

test('treeHash sorts what the reads list, so a listing in another order hashes the same (#459)', async (t) => {
  const dir = await tempDir(t, 'hash-');
  await put(dir, Object.fromEntries(FILES));
  const reversed = { ...FS_READS, list: async (d: string) => [...(await FS_READS.list(d))].reverse() };
  assert.equal(await treeHash({ source: dir, custom: dir }, reversed), await treeHash({ custom: dir, source: dir }));
});

test('canonicalJson sorts keys at every depth; tasksHash follows it (#459)', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: 'x' } }), '{"a":{"c":"x","d":[2,{"x":0,"y":1}]},"b":1}');
  assert.equal(tasksHash([{ key: 'T1', title: 't', body: 'b', blockedBy: [] }]), tasksHash([{ blockedBy: [], body: 'b', title: 't', key: 'T1' }]));
});

test('seedHash covers the seed fields, the repo files and the listed uploads, byte for byte (#459)', async (t) => {
  const dir = await tempDir(t, 'hash-');
  await put(dir, { 'seed/repo/docs/a.md': 'a', 'seed/upload/n.txt': 'n', 'seed/upload/unlisted.txt': 'u' });
  const seed: BenchSeed = { workspace: 'bench', commit: 'c'.repeat(40), reference: ['docs/a.md', 'upload:n.txt'], sample: { command: '', url: '', files: [] }, scenarios: [] };
  const first = await seedHash(seed, dir);
  assert.notEqual(await seedHash({ ...seed, sample: { ...seed.sample, command: 'pnpm dev' } }, dir), first);
  await writeFile(join(dir, 'seed', 'upload', 'unlisted.txt'), 'U');
  assert.equal(await seedHash(seed, dir), first, 'an unlisted upload is not the seed');
  await writeFile(join(dir, 'seed', 'repo', 'docs', 'a.md'), 'A');
  assert.notEqual(await seedHash(seed, dir), first);
});
