import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deliveredName, needsLiquid, parseTemplate, type RenderResult, renderTemplate, type TemplateError } from '../src/template.js';

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

const DELIVERED_HEADER = '---\nname: new-build\ndescription: Builds a plan.\nmodel: sonnet\ntools: Read, Edit\n---\n';

/** A render that must fail: its errors, and never a text. */
function failure(result: RenderResult): TemplateError[] {
  assert.equal(result.ok, false, 'an error never answers a text');
  return result.ok ? [] : result.errors;
}

test('rendering takes the workspace\'s value, else the default; a null default takes the else; workspace is built in (#310)', () => {
  const parsed = parseTemplate(TEMPLATE);
  assert.deepEqual(renderTemplate(parsed, 'hive'), {
    ok: true,
    text: `${DELIVERED_HEADER}# Build for hive\nRun pnpm test.\nDelivery: single. Dry run: false. E2E: pnpm e2e.\n`,
  });
  assert.deepEqual(renderTemplate(parsed, 'hive-site'), {
    ok: true,
    text: `${DELIVERED_HEADER}# Build for hive-site\nNo test command.\nDelivery: stacked. Dry run: false. E2E: playwright test.\n`,
  });
});

test('a required variable with no value, an undeclared variable, a bad tag and a partial each answer an error at the file line (#310)', () => {
  assert.deepEqual(failure(renderTemplate(parseTemplate(TEMPLATE), 'other')), [
    { line: 10, variable: 'e2eCommand', message: 'variable "e2eCommand" is required and has no value for workspace "other"' },
  ]);
  const undeclared = failure(renderTemplate(parseTemplate(`${TEMPLATE}Then {{ reviewer }}.\n`), 'hive'));
  assert.deepEqual(undeclared.map((error) => error.line), [16]);
  assert.match(undeclared[0].message, /reviewer/);
  assert.doesNotMatch(undeclared[0].message, /line:\d/, 'the body-relative position is not repeated');
  const unclosed = failure(renderTemplate(parseTemplate(`${TEMPLATE}{% if dryRun %}open\n`), 'hive'));
  assert.deepEqual(unclosed.map((error) => error.line), [16]);
  const partial = failure(renderTemplate(parseTemplate(`${TEMPLATE}{% include 'secrets' %}\n`), 'hive'));
  assert.deepEqual(partial.map((error) => error.line), [16], 'include has nothing to read: no file system');
  const malformed = parseTemplate(['---', 'variables:', '  a: { scope: x }', '---', '{{ a }}', ''].join('\n'));
  assert.deepEqual(renderTemplate(malformed, 'hive'), { ok: false, errors: malformed.errors });
});

test('the delivered header drops variables and basedOn; a plain file renders to itself byte for byte (#310)', () => {
  const plain = '---\nname: plain\ndescription:   odd   spacing   # a comment\n---\n# Plain\n\nNo variables, no blocks.\n';
  assert.deepEqual(renderTemplate(parseTemplate(plain), 'hive'), { ok: true, text: plain });
  assert.deepEqual(renderTemplate(parseTemplate('no header at all\n'), 'hive'), { ok: true, text: 'no header at all\n' });
  const kept = '---\nname: x  # kept\n---\nfor {{ workspace }}\n';
  assert.deepEqual(renderTemplate(parseTemplate(kept), 'hive'), { ok: true, text: '---\nname: x  # kept\n---\nfor hive\n' }, 'nothing removed: the header bytes stay');
  const onlyVariables = '---\nvariables:\n  a: { default: x }\n---\n{{ a }}\n';
  assert.deepEqual(renderTemplate(parseTemplate(onlyVariables), 'hive'), { ok: true, text: 'x\n' }, 'nothing left: no --- block');
  const delivered = renderTemplate(parseTemplate(TEMPLATE), 'hive');
  assert.ok(delivered.ok);
  const header = parseTemplate(delivered.text).header;
  assert.deepEqual(Object.keys(header), ['name', 'description', 'model', 'tools']);
});

test('needsLiquid looks at the body only; deliveredName strips one .liquid (#310)', () => {
  assert.equal(needsLiquid('---\nname: x\n---\nplain\n'), false);
  assert.equal(needsLiquid('---\nvariables:\n  a: { default: x }\n---\nplain\n'), false, 'a declared, unused variable needs no render');
  assert.equal(needsLiquid('---\ndescription: "{{ not the body }}"\n---\nplain\n'), false);
  assert.equal(needsLiquid('a {{ b }}'), true);
  assert.equal(needsLiquid('---\nname: x\n---\n{% if a %}x{% endif %}\n'), true);
  assert.equal(needsLiquid(TEMPLATE), true);
  assert.equal(deliveredName('skills/new-build/SKILL.md.liquid'), 'skills/new-build/SKILL.md');
  assert.equal(deliveredName('agents/planner.md.liquid'), 'agents/planner.md');
  assert.equal(deliveredName('skills/new-build/SKILL.md'), 'skills/new-build/SKILL.md');
  assert.equal(deliveredName('x.liquid.liquid'), 'x.liquid');
});

test('src/template.ts imports nothing from node, so the UI can bundle it as is (#310)', () => {
  // Runs from dist/test: the TypeScript source is read as text.
  const source = readFileSync(fileURLToPath(new URL('../../src/template.ts', import.meta.url)), 'utf8');
  assert.deepEqual([...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]), ['liquidjs', 'yaml']);
  assert.doesNotMatch(source, /\bprocess\.|\brequire\(|import\(/);
});

test('a CRLF header reads its last value without \\r and the delivered header keeps CRLF (#310)', () => {
  const crlf = '---\r\nname: x\r\nvariables:\r\n  v: { default: a }\r\n  flag: { type: boolean, default: false }\r\n---\r\n{{ v }}\r\n';
  const parsed = parseTemplate(crlf);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.variables.map((variable) => variable.default), ['a', false]);
  assert.deepEqual(renderTemplate(parsed, 'hive'), { ok: true, text: '---\r\nname: x\r\n---\r\na\r\n' });
});

test('the delivered header keeps a long value on one line (#310)', () => {
  const long = 'word '.repeat(40).trim();
  const result = renderTemplate(parseTemplate(`---\ndescription: ${long}\nvariables:\n  a: { default: x }\n---\n{{ a }}\n`), 'hive');
  assert.deepEqual(result, { ok: true, text: `---\ndescription: ${long}\n---\nx\n` });
});

test('a runaway loop fails as a render error instead of blocking (#310)', () => {
  const started = Date.now();
  const loop = '{% for i in (1..3000) %}{% for j in (1..3000) %}x{% endfor %}{% endfor %}';
  const errors = failure(renderTemplate(parseTemplate(`---\nname: x\n---\n${loop}\n`), 'hive'));
  assert.deepEqual(errors.map((error) => error.line), [4]);
  assert.ok(Date.now() - started < 5000, 'the render limit stops it');
});
