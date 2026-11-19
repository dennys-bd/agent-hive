import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHANGELOG_FILE, type Changelog, noteFor, readChangelog } from '../src/plugin-changelog.js';
import { fakeLog } from './fakes.js';
import { tempDir } from './temp-dir.js';

const LOG: Changelog = {
  '0.1.0': { 'hive:new-spec': { '## Input': 'too old' } },
  '0.2.0': { 'hive:new-spec': { '## Input': 'reads the issue anywhere' } },
  '0.10.0': { 'hive:new-spec': { '## Input': 'newest in range' } },
  '0.11.0': { 'hive:new-spec': { '## Input': 'too new' } },
  '0.9.0': { 'hive:new-spec': { '## Output': 'only output' } },
  next: { 'hive:new-spec': { '## Input': 'not a version' } },
};

test('noteFor answers the newest note in (from, to] by number, not by text; a heading, item or range with none answers undefined (#492)', () => {
  assert.equal(noteFor(LOG, 'hive:new-spec', '## Input', '0.1.0', '0.10.0'), 'newest in range');
  assert.equal(noteFor(LOG, 'hive:new-spec', '## Input', '0.1.0', '0.9.0'), 'reads the issue anywhere');
  assert.equal(noteFor(LOG, 'hive:new-spec', '## Output', '0.1.0', '0.10.0'), 'only output');
  assert.equal(noteFor(LOG, 'hive:new-spec', '## Steps', '0.1.0', '0.11.0'), undefined, 'a heading miss');
  assert.equal(noteFor(LOG, 'hive:new-build', '## Input', '0.1.0', '0.11.0'), undefined, 'an item miss');
  assert.equal(noteFor(LOG, 'hive:new-spec', '## Input', '0.10.0', '0.10.0'), undefined, 'from is excluded');
  assert.equal(noteFor(LOG, 'hive:new-spec', '## Input', 'beta', '0.10.0'), undefined, 'a from that is not x.y.z');
});

test('readChangelog reads the file, answers {} for a missing one silently, and logs once and answers {} for a malformed one (#492)', async (t) => {
  const dir = await tempDir(t, 'changelog-');
  const quiet = fakeLog();
  assert.deepEqual(await readChangelog(dir, quiet.log), {});
  assert.deepEqual(quiet.lines, []);
  await writeFile(join(dir, CHANGELOG_FILE), '# notes\n0.2.0:\n  hive:new-spec:\n    "## Input": accepts the issue number anywhere\n');
  assert.deepEqual(await readChangelog(dir, quiet.log), { '0.2.0': { 'hive:new-spec': { '## Input': 'accepts the issue number anywhere' } } });
  await writeFile(join(dir, CHANGELOG_FILE), '# only a comment\n');
  assert.deepEqual(await readChangelog(dir, quiet.log), {}, 'an empty map');
  for (const bad of ['0.2.0: [not, a, map]\n', '0.2.0:\n  hive:new-spec:\n    "## Input": 3\n', 'a: [\n']) {
    const noisy = fakeLog();
    await writeFile(join(dir, CHANGELOG_FILE), bad);
    assert.deepEqual(await readChangelog(dir, noisy.log), {});
    assert.equal(noisy.lines.length, 1, noisy.lines.join('\n'));
    assert.match(noisy.lines[0] ?? '', /^WARN plugin changelog: .*changelog\.yaml/);
  }
});

test('noteFor never answers an inherited property: a heading or item named like an Object method is a miss (#492)', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(noteFor(LOG, 'hive:new-spec', name, '0.1.0', '0.11.0'), undefined, `heading ${name}`);
    assert.equal(noteFor(LOG, name, '## Input', '0.1.0', '0.11.0'), undefined, `item ${name}`);
  }
});
