import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Catalogue, findReferences } from '../src/template-map.js';

// The block map of a template's body (#311): references, heading blocks, conditional chains, start lines and collapse structure.
const CATALOGUE: Catalogue = { skills: ['hive:new-pr', 'tdd-loop'], agents: ['hive:tdd', 'reviewer'] };
const refs = (line: string, catalogue?: Catalogue): [string, string][] =>
  findReferences(line, 7, catalogue).map(({ kind, name }) => [kind, name]);

test('a sigil at the start of a word names a skill (/) or an agent (@); an escaped one names nothing (#311)', () => {
  assert.deepEqual(refs('Run /new-pr, then /hive:new-spec and @tdd or (@hive:code-reviewer).'), [
    ['skill', 'new-pr'],
    ['skill', 'hive:new-spec'],
    ['agent', 'tdd'],
    ['agent', 'hive:code-reviewer'],
  ]);
  assert.deepEqual(refs('Type \\/new-pr or \\@tdd literally.'), []);
  assert.deepEqual(findReferences('`/hive:flow`', 12), [{ kind: 'skill', name: 'hive:flow', line: 12 }]);
});

test('paths, mail addresses and URLs are not references (#311)', () => {
  const lines = ['see src/ui and /Users/a/b', 'write to me@mail.com', 'open https://x', 'go to /usr/bin/x', 'a/b c//d', 'svn:repo//path'];
  for (const line of lines) assert.deepEqual(refs(line), [], line);
});

test('p:x without a sigil takes the catalogue\'s kind, a bare name needs the catalogue, a relative script path is a script (#311)', () => {
  assert.deepEqual(refs('Dispatch hive:tdd then hive:other.'), [['skill-or-agent', 'hive:tdd'], ['skill-or-agent', 'hive:other']]);
  assert.deepEqual(refs('Dispatch hive:tdd then hive:other.', CATALOGUE), [['agent', 'hive:tdd'], ['skill-or-agent', 'hive:other']]);
  assert.deepEqual(refs('Ask reviewer, then tdd-loop; plain words stay prose.', CATALOGUE), [['agent', 'reviewer'], ['skill', 'tdd-loop']]);
  assert.deepEqual(refs('Ask reviewer, then tdd-loop.'), []);
  assert.deepEqual(refs('Run scripts/slice_index.py, then check.sh and /bin/x.sh; data.json is not one.'), [
    ['script', 'scripts/slice_index.py'],
    ['script', 'check.sh'],
  ]);
});
