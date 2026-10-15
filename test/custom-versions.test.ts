import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isName, isVersionName, mainFiles, parseVersionJson, safeFilePath, writeVersionJson } from '../src/custom-versions.js';
import { tempDir } from './temp-dir.js';

test('names follow ^[a-z0-9][a-z0-9-]*$, and no version is called original (#315)', () => {
  for (const ok of ['mine', 'tdd-first', '0x']) assert.ok(isVersionName(ok), ok);
  for (const bad of ['', 'Mine', '-x', 'a/b', '..', 'a b', 'original', 7]) assert.ok(!isVersionName(bad), String(bad));
  assert.ok(isName('original'), 'an item may be called original; only a version may not');
  assert.deepEqual(mainFiles('skill', 'x'), ['SKILL.md', 'SKILL.md.liquid']);
  assert.deepEqual(mainFiles('specialist', 'x'), ['x.md', 'x.md.liquid']);
});

test('safeFilePath answers a relative normalized path and refuses .., a leading /, empty segments and backslashes (#315)', () => {
  for (const ok of ['SKILL.md', 'scripts/run.sh', 'a/b/c.txt']) assert.equal(safeFilePath(ok), ok);
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', './a', 'a//b', 'a/', 'a\\b', 'a\0b', 7]) assert.equal(safeFilePath(bad), undefined, String(bad));
});

test('parseVersionJson answers a valid file and names the version in every refusal (#315)', () => {
  assert.deepEqual(parseVersionJson('{"name":"mine","from":"original","workspaces":["a"],"hiveVersion":"0.1.0"}', 'mine'),
    { name: 'mine', from: 'original', workspaces: ['a'], hiveVersion: '0.1.0' });
  assert.deepEqual(parseVersionJson('{"name":"mine","from":null,"workspaces":[]}', 'mine'), { name: 'mine', from: null, workspaces: [] });
  for (const text of ['{', '[]', '{"name":"mine","from":1,"workspaces":[]}', '{"name":"other","from":null,"workspaces":[]}']) {
    assert.throws(() => parseVersionJson(text, 'mine'), /^Error: version mine: /, text);
  }
});

test('writeVersionJson writes through a temp file and leaves none behind (#315)', async (t) => {
  const dir = await tempDir(t, 'version-json-');
  await writeVersionJson(dir, { name: 'mine', from: null, workspaces: ['a'] });
  assert.deepEqual(await readdir(dir), ['version.json']);
  assert.deepEqual(parseVersionJson(await readFile(join(dir, 'version.json'), 'utf8'), 'mine'), { name: 'mine', from: null, workspaces: ['a'] });
});
