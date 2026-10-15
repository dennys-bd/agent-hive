import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplate } from '../src/template.js';
import { buildMap, type Catalogue, findReferences } from '../src/template-map.js';

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

const HEADINGS = [
  '---', // 1
  'name: x', // 2
  '---', // 3
  '# Title /hive:title', // 4
  '', // 5
  'Intro calls /hive:flow.', // 6
  '', // 7
  '## First', // 8
  'Dispatch @hive:tdd, then @hive:tdd again.', // 9
  '#### Deep is text @hive:deep', // 10
  '```md', // 11
  '## Not a heading /hive:fenced', // 12
  '```', // 13
  '### Sub', // 14
  'Then @hive:tdd and @hive:code-reviewer.', // 15
  '', // 16
  '## Last', // 17
  'end', // 18
  '',
].join('\n');

test('## is a block and ### a sub-block with count; the title, #### and a fenced heading are text (#311)', () => {
  assert.deepEqual(buildMap(parseTemplate(HEADINGS)), {
    errors: [],
    blocks: [
      { kind: 'introduction', line: 6, endLine: 7, references: [{ kind: 'skill', name: 'hive:flow', line: 6 }] },
      {
        kind: 'heading',
        level: 2,
        title: 'First',
        line: 8,
        endLine: 16,
        references: [
          { kind: 'agent', name: 'hive:tdd', line: 9 },
          { kind: 'agent', name: 'hive:deep', line: 10 },
        ],
        children: [
          {
            kind: 'heading',
            level: 3,
            title: 'Sub',
            line: 14,
            endLine: 16,
            references: [
              { kind: 'agent', name: 'hive:tdd', line: 15 },
              { kind: 'agent', name: 'hive:code-reviewer', line: 15 },
            ],
            children: [],
            count: 0,
          },
        ],
        count: 1,
      },
      { kind: 'heading', level: 2, title: 'Last', line: 17, endLine: 18, references: [], children: [], count: 0 },
    ],
  });
});

test('a title alone makes no block, and a text with no ## is all introduction, its fence holding no reference (#311)', () => {
  assert.deepEqual(buildMap(parseTemplate('# Only a title\n\n')), { blocks: [], errors: [] });
  assert.deepEqual(buildMap(parseTemplate('# T\nSee /hive:x.\n```\n/hive:fenced\n```\n')).blocks, [
    { kind: 'introduction', line: 2, endLine: 5, references: [{ kind: 'skill', name: 'hive:x', line: 2 }] },
  ]);
});
