import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplate } from '../src/template.js';
import type { Condition } from '../src/template-condition.js';
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

const CHAINS = [
  '---', // 1
  'name: x', // 2
  '---', // 3
  'Intro.', // 4
  '## First', // 5
  '{% if delivery == "stacked" %}', // 6
  'Stacked.', // 7
  '{%- elsif delivery == "single" -%}', // 8
  'Single, call @hive:code-reviewer.', // 9
  '{% else %}', // 10
  'Other.', // 11
  '{% endif %}', // 12
  'Inline {% if dryRun %}dry{% endif %} stays text.', // 13
  '### Sub', // 14
  '{% unless dryRun %}', // 15
  '## Inside a branch', // 16
  'Real run.', // 17
  '{% endunless %}', // 18
  '## Last', // 19
].join('\n');

const deliveryIs = (value: string): Condition => ({ connective: 'and', terms: [{ variable: 'delivery', op: 'is', value }] });

test('a line-level chain is a block whose branches carry their condition; chains nest in headings and headings in branches (#311)', () => {
  const insideBranch = { kind: 'heading', level: 2, title: 'Inside a branch', line: 16, endLine: 17, references: [], children: [], count: 0 };
  const unless = {
    kind: 'chain',
    tag: 'unless',
    line: 15,
    endLine: 18,
    branches: [
      {
        marker: 'unless',
        conditionText: 'dryRun',
        condition: { connective: 'and', terms: [{ variable: 'dryRun', op: 'isNo' }] },
        line: 15,
        references: [],
        children: [insideBranch],
      },
    ],
  };
  const ifChain = {
    kind: 'chain',
    tag: 'if',
    line: 6,
    endLine: 12,
    branches: [
      { marker: 'if', conditionText: 'delivery == "stacked"', condition: deliveryIs('stacked'), line: 6, references: [], children: [] },
      {
        marker: 'elsif',
        conditionText: 'delivery == "single"',
        condition: deliveryIs('single'),
        line: 8,
        references: [{ kind: 'agent', name: 'hive:code-reviewer', line: 9 }],
        children: [],
      },
      { marker: 'else', conditionText: '', condition: null, line: 10, references: [], children: [] },
    ],
  };
  assert.deepEqual(buildMap(parseTemplate(CHAINS)), {
    errors: [],
    blocks: [
      { kind: 'introduction', line: 4, endLine: 4, references: [] },
      {
        kind: 'heading',
        level: 2,
        title: 'First',
        line: 5,
        endLine: 18,
        references: [],
        count: 2,
        children: [ifChain, { kind: 'heading', level: 3, title: 'Sub', line: 14, endLine: 18, references: [], count: 1, children: [unless] }],
      },
      { kind: 'heading', level: 2, title: 'Last', line: 19, endLine: 19, references: [], children: [], count: 0 },
    ],
  });
});

test('unbalanced markers answer the blocks built plus an error at the marker\'s line; raw and comment hide markers (#311)', () => {
  const unclosed = buildMap(parseTemplate('## A\n{% if dryRun %}\ntext\n'));
  assert.deepEqual(unclosed.errors, [{ line: 2, message: '{% if %} is never closed' }]);
  const [a] = unclosed.blocks;
  assert.ok(a.kind === 'heading');
  assert.deepEqual(a.children.map((block) => [block.kind, block.line, block.endLine]), [['chain', 2, 3]]);

  const stray = buildMap(parseTemplate('## A\n{% else %}\n{% endif %}\n'));
  assert.deepEqual(stray.errors, [
    { line: 2, message: '{% else %} with no open {% if %} or {% unless %}' },
    { line: 3, message: '{% endif %} with no open {% if %} or {% unless %}' },
  ]);
  assert.deepEqual(buildMap(parseTemplate('{% if a %}\n{% endunless %}\n')).errors, [{ line: 2, message: '{% endunless %} closes an {% if %}' }]);

  const literal = buildMap(parseTemplate('## A\n{% raw %}\n{% if a %}\n{% endraw %}\n{% comment %}\n{% endif %}\n{% endcomment %}\n'));
  assert.deepEqual(literal.errors, []);
  const [hidden] = literal.blocks;
  assert.ok(hidden.kind === 'heading');
  assert.deepEqual(hidden.children, []);
});
