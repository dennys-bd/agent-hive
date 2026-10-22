import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createFolder, copyFolder, experimentFolder, pinPlugin, SeedFileMissing, syncSeed, writeUpload } from '../../src/benchmark/store.js';
import type { BenchSeed } from '../../src/types.js';
import { put, snapshot } from '../custom-fixture.js';
import { tempDir } from '../temp-dir.js';

const SHA = 'c'.repeat(40);
const b64 = (text: string): string => Buffer.from(text).toString('base64');
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
// git as syncSeed calls it: the commit, the files `files` holds at SHA, and every folder above them as a tree
const fakeGit = (files: Record<string, string>) => async (...args: string[]): Promise<string> => {
  const spec = args.at(-1) ?? '';
  const path = spec.slice(SHA.length + 1);
  const under = (dir: string): string[] => Object.keys(files).filter((f) => f.startsWith(`${dir}/`));
  if (args[0] === 'cat-file' && spec === SHA) return 'commit\n';
  if (args[0] === 'cat-file' && Object.hasOwn(files, path)) return 'blob\n';
  if (args[0] === 'cat-file' && under(path).length > 0) return 'tree\n';
  if (args[0] === 'ls-tree') return under(spec).map((f) => `${f}\0`).join('');
  if (args[0] === 'show' && Object.hasOwn(files, path)) return files[path];
  throw new Error('fatal: not there');
};
const seed = (patch: Partial<BenchSeed> = {}): BenchSeed => ({ workspace: 'bench', commit: SHA, reference: [], sample: { command: '', url: '', files: [] }, scenarios: [], ...patch });

test('experimentFolder refuses a non-id; createFolder makes the folder 0700 (#459)', async (t) => {
  const home = await tempDir(t, 'store-');
  assert.throws(() => experimentFolder(home, '../x'));
  const dir = experimentFolder(home, 'xabc12345');
  await createFolder(dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test('pinPlugin copies the shipped plugin to plugin/source and the custom store to plugin/custom; no store pins an empty custom (#459)', async (t) => {
  const [home, plugin] = await Promise.all([tempDir(t, 'store-home-'), tempDir(t, 'store-plugin-')]);
  await put(plugin, { 'skills/new-build/SKILL.md': 'ship\n' });
  const bare = experimentFolder(home, 'xbare0001');
  await pinPlugin(bare, plugin, home);
  assert.deepEqual(await snapshot(join(bare, 'plugin', 'custom')), {});
  await put(home, { 'custom/hive/new-build/tdd/version.json': '{}' });
  const dir = experimentFolder(home, 'xpin00001');
  await pinPlugin(dir, plugin, home);
  assert.deepEqual(Object.keys(await snapshot(join(dir, 'plugin'))).sort(), ['custom/hive/new-build/tdd/version.json', 'source/skills/new-build/SKILL.md']);
});

test('copyFolder carries plugin/ and seed/ and nothing of the rounds (#459)', async (t) => {
  const home = await tempDir(t, 'store-');
  const from = experimentFolder(home, 'xfrom0001');
  await put(from, { 'plugin/source/a': 'a', 'seed/scenarios.md': '', 'runs/aaaa1/hive.log': 'x', 'repo.git/HEAD': 'x' });
  const to = experimentFolder(home, 'xto000001');
  await copyFolder(from, to);
  assert.deepEqual(Object.keys(await snapshot(to)).sort(), ['plugin/source/a', 'seed/scenarios.md']);
});

test('syncSeed writes seed/repo at the commit and scenarios.md, and prunes the uploads the seed no longer lists (#459)', async (t) => {
  const dir = experimentFolder(await tempDir(t, 'store-'), 'xseed0001');
  await writeUpload(dir, 'keep.txt', Buffer.from('k'));
  await writeUpload(dir, 'drop.txt', Buffer.from('d'));
  const next = seed({ reference: ['docs/hand.md', 'upload:keep.txt'], sample: { command: 'pnpm dev', url: '', files: ['fixtures/s.sql'] }, scenarios: [{ id: 's1', title: 'Opens', text: 'It opens.' }] });
  await syncSeed(dir, next, fakeGit({ 'docs/hand.md': 'hand\n', 'fixtures/s.sql': 'sql\n' }));
  assert.deepEqual(await snapshot(join(dir, 'seed')), {
    'repo/docs/hand.md': b64('hand\n'), 'repo/fixtures/s.sql': b64('sql\n'), 'scenarios.md': b64('## Opens\n\nIt opens.\n'), 'upload/keep.txt': b64('k'),
  });
});

test('a repo path that is a tree at the commit expands to every file under it, each copied under seed/repo (#459)', async (t) => {
  const dir = experimentFolder(await tempDir(t, 'store-'), 'xtree0001');
  await syncSeed(dir, seed({ reference: ['handoff'] }), fakeGit({ 'handoff/a.md': 'a\n', 'handoff/sub/b.md': 'b\n', 'other.md': 'o\n' }));
  assert.deepEqual(await snapshot(join(dir, 'seed', 'repo')), { 'handoff/a.md': b64('a\n'), 'handoff/sub/b.md': b64('b\n') });
});

test('syncSeed throws SeedFileMissing for a path missing at the commit, an unknown commit or an unlisted upload, and leaves seed/ as it was (#459)', async (t) => {
  const dir = experimentFolder(await tempDir(t, 'store-'), 'xseed0002');
  await syncSeed(dir, seed({ reference: ['a.md'] }), fakeGit({ 'a.md': 'a\n' }));
  const before = await snapshot(join(dir, 'seed'));
  for (const bad of [seed({ reference: ['gone.md'] }), seed({ commit: 'd'.repeat(40) }), seed({ reference: ['upload:none.txt'] })]) {
    await assert.rejects(syncSeed(dir, bad, fakeGit({ 'a.md': 'a\n' })), SeedFileMissing);
  }
  assert.deepEqual(await snapshot(join(dir, 'seed')), before);
  assert.equal(await readFile(join(dir, 'seed', 'repo', 'a.md'), 'utf8'), 'a\n');
  assert.equal(await exists(join(dir, 'seed', 'upload', 'none.txt')), false);
});
