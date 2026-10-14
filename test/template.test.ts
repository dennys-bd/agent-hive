import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplate, type TemplateError } from '../src/template.js';

// The Liquid render pipeline (#310): a skill or agent template's header, its variables, the render for one workspace, the .liquid name.
const TEMPLATE = [
  '---',
  'name: new-build',
  'description: Builds a plan.',
  'model: sonnet',
  'tools: Read, Edit',
  'variables:',
  '  testCommand: { default: null, workspaces: { hive: pnpm test } }',
  '  delivery: { values: [stacked, single], default: single, workspaces: { hive-site: stacked } }',
  '  dryRun: { type: boolean, default: false }',
  '  e2eCommand: { required: true, workspaces: { hive: pnpm e2e, hive-site: playwright test } }',
  'basedOn: { name: skills, repo: acme/skills, ref: v1.0.0, license: MIT, url: example.com/skills }',
  '---',
  '# Build for {{ workspace }}',
  '{% if testCommand %}Run {{ testCommand }}.{% else %}No test command.{% endif %}',
  'Delivery: {{ delivery }}. Dry run: {{ dryRun }}. E2E: {{ e2eCommand }}.',
  '',
].join('\n');

/** A template whose header is the given lines, so the first of them is file line 2. */
const headerErrors = (...lines: string[]): TemplateError[] => parseTemplate(['---', ...lines, '---', 'body', ''].join('\n')).errors;

test('a header declaring text, list, boolean and required variables parses with their kinds, defaults and lines (#310)', () => {
  const parsed = parseTemplate(TEMPLATE);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.variables, [
    { name: 'testCommand', kind: 'text', default: null, required: false, workspaces: { hive: 'pnpm test' }, line: 7 },
    { name: 'delivery', kind: 'list', values: ['stacked', 'single'], default: 'single', required: false, workspaces: { 'hive-site': 'stacked' }, line: 8 },
    { name: 'dryRun', kind: 'boolean', default: false, required: false, workspaces: {}, line: 9 },
    { name: 'e2eCommand', kind: 'text', default: null, required: true, workspaces: { hive: 'pnpm e2e', 'hive-site': 'playwright test' }, line: 10 },
  ]);
  assert.deepEqual(parsed.basedOn, { name: 'skills', repo: 'acme/skills', ref: 'v1.0.0', license: 'MIT', url: 'example.com/skills' });
  assert.equal(parsed.header.name, 'new-build');
  assert.equal(parsed.bodyLine, 13);
  assert.ok(parsed.body.startsWith('# Build for {{ workspace }}\n'));

  const plain = parseTemplate('just text\n');
  assert.deepEqual([plain.header, plain.body, plain.bodyLine, plain.variables, plain.errors], [{}, 'just text\n', 1, [], []], 'no fence, no header');
});

test('each malformed declaration answers one error naming the variable, at its line (#310)', () => {
  const malformed: [string, string, RegExp][] = [
    ['delivery', 'delivery: { values: [stacked, single], default: trunk }', /default must be one of stacked, single/],
    ['delivery', 'delivery: { values: [stacked, single], workspaces: { hive: trunk } }', /workspaces\.hive must be one of stacked, single/],
    ['delivery', 'delivery: { values: [] }', /values must be a non-empty list of distinct strings/],
    ['dryRun', 'dryRun: { type: boolean, default: maybe }', /default must be true or false/],
    ['size', 'size: { type: number }', /type may only be boolean/],
    ['flag', 'flag: { type: boolean, values: [a, b] }', /a boolean has no values/],
    ['testCommand', 'testCommand: { default: 3 }', /default must be text/],
    ['testCommand', 'testCommand: { default: x, scope: all }', /unknown key "scope"/],
    ['e2eCommand', 'e2eCommand: { required: true, default: x }', /a required variable has no default/],
    ['workspace', 'workspace: { default: x }', /built in/],
    ['2fast', '2fast: { default: x }', /a letter or _/],
    ['loose', 'loose: x', /a declaration is a mapping/],
  ];
  for (const [name, declaration, problem] of malformed) {
    const errors = headerErrors('name: x', 'variables:', `  ${declaration}`);
    assert.equal(errors.length, 1, declaration);
    assert.equal(errors[0].line, 4, declaration);
    assert.equal(errors[0].variable, name, declaration);
    assert.match(errors[0].message, new RegExp(`variable "${name}"`), declaration);
    assert.match(errors[0].message, problem, declaration);
  }
});

test('a malformed basedOn or variables block answers one error at its line, and every declaration is checked (#310)', () => {
  const basedOn = 'basedOn must be { name, repo, ref, license, url }, each a string';
  assert.deepEqual(headerErrors('name: x', 'basedOn: { name: skills, repo: acme/skills }'), [{ line: 3, message: basedOn }]);
  assert.deepEqual(headerErrors('basedOn: { name: a, repo: b, ref: c, license: d, url: e, extra: f }'), [{ line: 2, message: basedOn }]);
  assert.deepEqual(headerErrors('basedOn: { name: a, repo: b, ref: c, license: d, url: 7 }'), [{ line: 2, message: basedOn }]);
  assert.deepEqual(headerErrors('name: x', 'variables: [a, b]'), [{ line: 3, message: 'variables must be a mapping of declarations' }]);
  assert.deepEqual(
    headerErrors('variables:', '  a: { default: 3 }', '  b: { scope: x }').map((error) => [error.line, error.variable]),
    [[3, 'a'], [4, 'b']],
  );
});

test('a YAML error, or a header that is not a mapping, answers an error at its file line and never throws (#310)', () => {
  assert.deepEqual(headerErrors('name: a', 'name: b').map((error) => error.line), [3], 'a duplicate key is reported at the second key');
  assert.deepEqual(headerErrors('- a list'), [{ line: 2, message: 'the header must be a YAML mapping' }]);
  const broken = parseTemplate(['---', 'name: a', 'name: b', '---', '{{ x }}', ''].join('\n'));
  assert.deepEqual([broken.variables, broken.header], [[], {}], 'nothing is read past a YAML error');
});
