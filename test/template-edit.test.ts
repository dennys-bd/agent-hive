import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TemplateError } from '../src/template.js';
import type { ChainSpec } from '../src/template-condition.js';
import { type EditResult, insertChain, removeChain } from '../src/template-edit.js';

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
