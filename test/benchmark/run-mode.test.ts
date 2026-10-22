import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MARKER_FILE } from '../../src/benchmark/run-home.js';
import { readMarker, writeMarker } from '../../src/benchmark/run-mode.js';
import { tempDir } from '../temp-dir.js';
import { runMarker } from './fixtures.js';

test('readMarker reads no marker as none, reads back what writeMarker wrote (0600), and throws naming the file on a malformed one (#475)', async (t) => {
  const home = await tempDir(t, 'run-home-');
  assert.equal(await readMarker(home), undefined, 'no benchmark.json: a normal Hive');
  const marker = runMarker({ frozen: true });
  await writeMarker(home, marker);
  assert.deepEqual(await readMarker(home), marker);
  assert.equal((await stat(join(home, MARKER_FILE))).mode & 0o777, 0o600);
  const bad = ['{', '[]', JSON.stringify({ ...marker, frozen: 'yes' }), JSON.stringify({ ...marker, token: '../x' }), JSON.stringify({ ...marker, experiment: { id: 'exp-1' } }), JSON.stringify({ ...marker, round: -1 })];
  for (const text of bad) {
    await writeFile(join(home, MARKER_FILE), text);
    await assert.rejects(readMarker(home), /^Error: benchmark\.json: /, text);
  }
  await writeFile(join(home, MARKER_FILE), JSON.stringify({ ...marker, extra: 'dropped' }));
  assert.deepEqual(await readMarker(home), marker, 'a field the type does not know never reaches the daemon');
});
