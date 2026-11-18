import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { covers, trustedFolders, uncoveredFolders } from '../../src/agents/copilot-trust.js';
import { tempDir } from '../temp-dir.js';

const writeConfig = async (home: string, text: string): Promise<string> => {
  const file = join(home, 'config.json');
  await writeFile(file, text);
  return file;
};
// The file as the Hive found it: its bytes and its mtime, the proof that nothing wrote it
const snapshot = async (file: string): Promise<[Buffer, number]> => [await readFile(file), (await stat(file)).mtimeMs];

test('covers: the same folder or an ancestor, with a trailing separator on either side; never a sibling, a child or a prefix-only name (#880, spike §8)', () => {
  const held: [string, string][] = [['/a/repo', '/a/repo'], ['/a', '/a/repo'], ['/a/repo/', '/a/repo'], ['/a/repo', '/a/repo/'], ['/', '/a/repo']];
  for (const [entry, folder] of held) assert.equal(covers(entry, folder, 'darwin'), true, `${entry} covers ${folder}`);
  const failed: [string, string][] = [['/a/other', '/a/repo'], ['/a/repo/sub', '/a/repo'], ['/a/repo', '/a/repo-2'], ['/a/re', '/a/repo']];
  for (const [entry, folder] of failed) assert.equal(covers(entry, folder, 'darwin'), false, `${entry} does not cover ${folder}`);
});

test('covers on win32: the drive letter\'s and the names\' case are ignored, \\ and / alike; another drive or a prefix-only name never covers (#880)', () => {
  const held: [string, string][] = [['c:\\work', 'C:\\Work\\repo'], ['C:/work/', 'C:\\work\\repo'], ['C:\\work\\repo', 'c:/work/repo/']];
  for (const [entry, folder] of held) assert.equal(covers(entry, folder, 'win32'), true, `${entry} covers ${folder}`);
  const failed: [string, string][] = [['C:\\work\\repo', 'C:\\work\\repo-2'], ['D:\\work', 'C:\\work\\repo'], ['C:\\work\\repo\\sub', 'C:\\work\\repo']];
  for (const [entry, folder] of failed) assert.equal(covers(entry, folder, 'win32'), false, `${entry} does not cover ${folder}`);
});

test('trustedFolders: a missing file, non-JSON, no trustedFolders and a non-array are unknown; a mixed array keeps its strings; the file is never written (#880)', async (t) => {
  const home = await tempDir(t, 'copilot-trust-');
  assert.equal(await trustedFolders(home), undefined, 'no config.json');
  for (const text of ['{ not json', 'null', '{"model":"auto"}', '{"trustedFolders":"/a"}']) {
    const file = await writeConfig(home, text);
    const before = await snapshot(file);
    assert.equal(await trustedFolders(home), undefined, text);
    assert.deepEqual(await snapshot(file), before, `${text}: read only`);
  }
  const file = await writeConfig(home, JSON.stringify({ trustedFolders: ['/a', 1, null, '/b', { path: '/c' }] }));
  const before = await snapshot(file);
  assert.deepEqual(await trustedFolders(home), ['/a', '/b']);
  assert.deepEqual(await snapshot(file), before, 'read only');
});

test('uncoveredFolders: both sides through realpath, so a link and its target cover alike; the rest come back as passed, in order; unknown entries are undefined (#880)', async (t) => {
  const root = await tempDir(t, 'copilot-trust-root-');
  const home = await tempDir(t, 'copilot-trust-home-');
  const [real, other, link] = [join(root, 'real'), join(root, 'other'), join(root, 'link')];
  await mkdir(join(real, 'repo'), { recursive: true });
  await mkdir(other);
  await symlink(real, link, 'junction'); // a directory link Windows makes without privilege; POSIX ignores the type
  const [linked, gone] = [join(link, 'repo'), join(root, 'gone')];
  assert.equal(await uncoveredFolders(home, [other], process.platform), undefined, 'no config.json: unknown');
  const file = await writeConfig(home, JSON.stringify({ trustedFolders: [real] }));
  const before = await snapshot(file);
  // a folder gone from disk is compared as written, and nothing covers it
  assert.deepEqual(await uncoveredFolders(home, [other, linked, gone], process.platform), [other, gone]);
  assert.deepEqual(await snapshot(file), before, 'read only');
  await writeConfig(home, JSON.stringify({ trustedFolders: [link] }));
  assert.deepEqual(await uncoveredFolders(home, [join(real, 'repo'), other], process.platform), [other], 'an entry through a link covers its target');
});
