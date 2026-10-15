import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TemplateError } from '../src/template.js';
import type { ChainSpec, Condition, ConditionTerm } from '../src/template-condition.js';
import {
  addVariable,
  type EditResult,
  insertChain,
  moveBlock,
  removeChain,
  replaceChain,
  setVariableValue,
} from '../src/template-edit.js';

// Text edits of a template (#311): each answers the new text with its parse and map, or an error; never throws.
const DOC = [
  '---', // 1
  'name: x', // 2
  'variables:', // 3
  '  # the test runner', // 4
  '  testCommand: { default: null, workspaces: { hive: pnpm test } }', // 5
  '  delivery: { values: [stacked, single], default: single }', // 6
  '  dryRun: { type: boolean, default: false }', // 7
  '---', // 8
  '# Title', // 9
  '', // 10
  '## First', // 11
  'first text', // 12
  '', // 13
  '## Second', // 14
  '{% if delivery == "stacked" %}', // 15
  'stacked text', // 16
  '{% else %}', // 17
  'other text', // 18
  '{% endif %}', // 19
  '## Third', // 20
  'third text', // 21, no final newline
].join('\n');

const DRY: ChainSpec = { branches: [{ connective: 'and', terms: [{ variable: 'dryRun', op: 'hasValue' }] }], else: true };

function ok(result: EditResult): Extract<EditResult, { ok: true }> {
  if (!result.ok) assert.fail(`refused at line ${result.error.line}: ${result.error.message}`);
  assert.deepEqual([...result.parsed.errors, ...result.map.errors], [], 'an answered text parses and maps clean');
  return result;
}

function refused(result: EditResult): TemplateError {
  if (result.ok) assert.fail('the edit was expected to be refused');
  return result.error;
}

test('insertChain writes empty marker lines before the line, and removeChain gives the input back byte for byte (#311)', () => {
  const inserted = ok(insertChain(DOC, 12, DRY));
  assert.deepEqual(inserted.text.split('\n').slice(10, 15), ['## First', '{% if dryRun %}', '{% else %}', '{% endif %}', 'first text']);
  const [first] = inserted.map.blocks;
  assert.ok(first.kind === 'heading');
  assert.deepEqual(first.children.map((block) => [block.kind, block.line, block.endLine]), [['chain', 12, 14]]);
  assert.equal(ok(removeChain(inserted.text, 12)).text, DOC);

  const appended = ok(insertChain(DOC, 22, DRY));
  assert.ok(appended.text.endsWith('third text\n{% if dryRun %}\n{% else %}\n{% endif %}'), 'no final newline stays none');
  assert.equal(ok(removeChain(appended.text, 22)).text, DOC);

  const crlf = DOC.replace(/\n/g, '\r\n');
  const insertedCrlf = ok(insertChain(crlf, 12, DRY));
  assert.ok(insertedCrlf.text.includes('## First\r\n{% if dryRun %}\r\n{% else %}\r\n{% endif %}\r\nfirst text'));
  assert.equal(ok(removeChain(insertedCrlf.text, 12)).text, crlf);
});

test('removeChain keeps every branch\'s text; edits refuse a bad line, an empty chain and a text whose map has errors (#311)', () => {
  const removed = ok(removeChain(DOC, 15));
  assert.deepEqual(removed.text.split('\n').slice(13), ['## Second', 'stacked text', 'other text', '## Third', 'third text']);
  assert.equal(refused(insertChain(DOC, 3, DRY)).line, 3, 'the header is not the body');
  assert.equal(refused(insertChain(DOC, 23, DRY)).line, 23);
  assert.match(refused(insertChain(DOC, 12, { branches: [], else: false })).message, /at least one condition/);
  assert.deepEqual(refused(removeChain(DOC, 16)), { line: 16, message: 'no chain starts at line 16' });
  assert.deepEqual(refused(removeChain('## A\n{% if dryRun %}\ntext\n', 2)), { line: 2, message: '{% if %} is never closed' });
});

const deliveryIs = (value: string): Condition => ({ connective: 'and', terms: [{ variable: 'delivery', op: 'is', value }] });

test('replaceChain rewrites the markers, adds empty branches, and refuses to drop a branch that holds text (#311)', () => {
  const grown = ok(replaceChain(DOC, 15, { branches: [deliveryIs('stacked'), deliveryIs('single')], else: true }));
  assert.deepEqual(grown.text.split('\n').slice(14, 20), [
    '{% if delivery == "stacked" %}',
    'stacked text',
    '{% elsif delivery == "single" %}',
    '{% else %}',
    'other text',
    '{% endif %}',
  ]);
  assert.equal(ok(replaceChain(grown.text, 15, { branches: [deliveryIs('stacked')], else: true })).text, DOC, 'an empty elsif is dropped');

  const dropped = refused(replaceChain(DOC, 15, { branches: [deliveryIs('stacked')], else: false }));
  assert.equal(dropped.line, 17);
  assert.match(dropped.message, /holds text/);

  const unless = ok(replaceChain(DOC, 15, { branches: [{ connective: 'and', terms: [{ variable: 'dryRun', op: 'isNo' }] }], else: true }));
  assert.deepEqual(unless.text.split('\n').slice(14, 19), ['{% unless dryRun %}', 'stacked text', '{% else %}', 'other text', '{% endunless %}']);
});

const titles = (result: Extract<EditResult, { ok: true }>): string[] =>
  result.map.blocks.map((block) => (block.kind === 'heading' ? block.title : block.kind));

test('moveBlock moves a block among its siblings, and down then up gives the input back byte for byte (#311)', () => {
  const down = ok(moveBlock(DOC, 14, 2));
  assert.deepEqual(titles(down), ['First', 'Third', 'Second']);
  assert.ok(down.text.endsWith('third text\n## Second\n{% if delivery == "stacked" %}\nstacked text\n{% else %}\nother text\n{% endif %}'));
  assert.equal(ok(moveBlock(down.text, 16, 1)).text, DOC);

  const lastUp = ok(moveBlock(DOC, 20, 0)); // the block at the end of a text with no final newline
  assert.deepEqual(titles(lastUp), ['Third', 'First', 'Second']);
  assert.ok(lastUp.text.includes('## Third\nthird text\n## First\n'), 'it takes a line ending');
  assert.ok(lastUp.text.endsWith('{% endif %}'), 'the new last block gives its own back');
  assert.equal(ok(moveBlock(lastUp.text, 11, 2)).text, DOC);

  const nested = '## A\n### One\none\n### Two\ntwo\n## B\n';
  assert.equal(ok(moveBlock(nested, 4, 0)).text, '## A\n### Two\ntwo\n### One\none\n## B\n', 'a ### stays under its ##');
  assert.match(refused(moveBlock(nested, 4, 2)).message, /index 2 is not a position among 2 siblings/);
  assert.equal(refused(moveBlock(nested, 3, 0)).message, 'no heading or chain starts at line 3');

  const gapped = '## A\n{% if a %}\nx\n{% endif %}\nbetween\n{% if b %}\ny\n{% endif %}\n';
  const swapped = ok(moveBlock(gapped, 6, 0));
  assert.equal(swapped.text, '## A\n{% if b %}\ny\n{% endif %}\nbetween\n{% if a %}\nx\n{% endif %}\n', 'the parent\'s text keeps its slot');
  assert.equal(ok(moveBlock(swapped.text, 6, 0)).text, gapped);
});

const BODY = DOC.slice(DOC.indexOf('# Title'));

test('addVariable declares a variable in flow style, creating the header when absent; a duplicate or bad name is refused (#311)', () => {
  const created = ok(addVariable('# Plain\n\nbody\n', { name: 'dryRun', type: 'boolean', default: false }));
  assert.ok(created.text.startsWith('---\nvariables:\n'));
  assert.match(created.text, /^ {2}dryRun: \{ type: boolean, default: false \}$/m);
  assert.ok(created.text.endsWith('---\n# Plain\n\nbody\n'));
  assert.deepEqual(created.parsed.variables, [{ name: 'dryRun', kind: 'boolean', default: false, required: false, workspaces: {}, line: 3 }]);

  const added = ok(addVariable(DOC, { name: 'reviewer', values: ['a', 'b'], default: 'a' }));
  assert.deepEqual(added.parsed.variables.map((variable) => variable.name), ['testCommand', 'delivery', 'dryRun', 'reviewer']);
  assert.deepEqual(added.text.split('\n').slice(0, 5), DOC.split('\n').slice(0, 5), 'the comment and an untouched key keep their text');
  assert.ok(added.text.endsWith(BODY));

  assert.deepEqual(refused(addVariable(DOC, { name: 'dryRun', type: 'boolean' })), {
    line: 7,
    variable: 'dryRun',
    message: 'variable "dryRun" is already declared',
  });
  assert.equal(refused(addVariable(DOC, { name: '2fast', default: 'x' })).variable, '2fast');
});

test('setVariableValue writes a workspace\'s value and removes it with undefined, keeping the comment; an invalid value is refused at the variable\'s line (#311)', () => {
  const set = ok(setVariableValue(DOC, 'testCommand', 'hive-site', 'vitest'));
  assert.deepEqual(set.parsed.variables[0].workspaces, { hive: 'pnpm test', 'hive-site': 'vitest' });
  assert.ok(set.text.includes('\n  # the test runner\n'));
  assert.ok(set.text.endsWith(BODY));

  const removed = ok(setVariableValue(set.text, 'testCommand', 'hive', undefined));
  assert.deepEqual(removed.parsed.variables[0].workspaces, { 'hive-site': 'vitest' });
  assert.ok(removed.text.includes('\n  # the test runner\n'));

  assert.deepEqual(ok(setVariableValue(DOC, 'delivery', 'hive', 'stacked')).parsed.variables[1].workspaces, { hive: 'stacked' });
  const invalid = refused(setVariableValue(DOC, 'delivery', 'hive', 'trunk'));
  assert.equal(invalid.line, 6);
  assert.match(invalid.message, /workspaces\.hive must be one of stacked, single/);
  assert.match(refused(setVariableValue(DOC, 'dryRun', 'hive', 'yes')).message, /must be true or false/);
  assert.deepEqual(refused(setVariableValue(DOC, 'missing', 'hive', 'x')), {
    line: 1,
    variable: 'missing',
    message: 'variable "missing" is not declared',
  });
});

test('the three modules import nothing from node, so the editor can bundle them as they are (#311)', () => {
  const imports = (file: string): string[] => {
    // Runs from dist/test: the TypeScript source is read as text.
    const source = readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\bprocess\.|\brequire\(|import\(/, file);
    return [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort();
  };
  assert.deepEqual(imports('template-condition.ts'), []);
  assert.deepEqual(imports('template-map.ts'), ['./template-condition.js', './template.js']);
  assert.deepEqual(imports('template-edit.ts'), ['./template-condition.js', './template-map.js', './template.js', 'yaml']);
});

test('removing a workspace value that is not there is a no-op success (#311)', () => {
  const text = '---\nvariables:\n  v: { type: boolean }\n---\nbody\n';
  const done = setVariableValue(text, 'v', 'ws', undefined);
  assert.ok(done.ok);
  assert.equal(done.text, text);
});

test('a chain whose variable or value could not be written back as one marker is refused, naming the input (#311)', () => {
  const chainOf = (term: ConditionTerm): ChainSpec => ({ branches: [{ connective: 'and', terms: [term] }], else: false });
  const bad: [ConditionTerm, string][] = [
    [{ variable: 'v', op: 'is', value: 'a"b\'c' }, 'a"b\'c'],
    [{ variable: 'v', op: 'is', value: 'a\nb' }, 'a\nb'],
    [{ variable: 'v', op: 'is', value: 'x" %}{% comment %}' }, 'x" %}{% comment %}'],
    [{ variable: 'v', op: 'is', value: 'a {{ b' }, 'a {{ b'],
    [{ variable: 'v %}{% raw', op: 'hasValue' }, 'v %}{% raw'],
    [{ variable: 'and', op: 'hasValue' }, 'and'],
    [{ variable: 'v', op: 'is', value: false }, 'false'],
    [{ variable: 'v', op: 'contains', value: true }, 'true'],
  ];
  for (const [term, named] of bad) {
    const error = refused(insertChain(DOC, 12, chainOf(term)));
    assert.ok(error.message.includes(named), `${JSON.stringify(term)} names its input: ${error.message}`);
    refused(replaceChain(DOC, 15, chainOf(term)));
  }
});
