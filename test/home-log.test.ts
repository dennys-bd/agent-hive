import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeLog, maskPaths } from '../src/home-log.js';
import { LOG_FILE } from '../src/log.js';
import { tempDir } from './temp-dir.js';

test('homeLog writes an error to hive.log in the home, opened on first use (#742)', async (t) => {
  const home = await tempDir(t, 'home-log-');
  homeLog(() => home).error('dock icon failed: bad file');
  assert.match(readFileSync(join(home, LOG_FILE), 'utf8'), /ERROR dock icon failed: bad file\n$/);
});

test('homeLog with a home that cannot be resolved never throws (#742)', () => {
  const log = homeLog(() => {
    throw new Error('HIVE_HOME must be absolute');
  });
  assert.doesNotThrow(() => log.error('uso: node dist/src/run.js'));
});

test('homeLog masks absolute paths, home-relative paths and links before they are persisted; a relative one stays (#742)', async (t) => {
  const home = await tempDir(t, 'home-log-');
  homeLog(() => home).error(`settings: ENOENT: no such file, open '${home}/hive.config.json' (see https://github.com/acme/r/pull/9, ~/saved) dist/src/run.js`);
  const text = readFileSync(join(home, LOG_FILE), 'utf8');
  assert.ok(!text.includes(home) && !text.includes('github.com') && !text.includes('~/saved'), text);
  assert.match(text, /ERROR settings: ENOENT: no such file, open '<path>' \(see <url> <path>\) dist\/src\/run\.js\n$/);
});

test('maskPaths masks a path under the home whole, spaces included, so no folder of it is kept (#742)', () => {
  const home = '/Users/someone';
  assert.equal(maskPaths(`open '${home}/Library/Application Support/Hive/f.json' failed`, home), "open '<path>' failed");
  assert.equal(maskPaths(`bounds: ${home}/Library/Application Support/Hive/b.json`, home), 'bounds: <path>');
});
