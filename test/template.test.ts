import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILT_INS, type BuiltIns, deliveredHeader, deliveredName, isVariableName, needsLiquid, NO_BUILT_INS, type ParsedTemplate, parseTemplate, type RenderResult, renderTemplate, type RenderWorkspace, splitHeader, type TemplateError, toolsLine, valueFor, valueSource } from '../src/template.js';
import { PR_TARGETS } from '../src/types.js';

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
  assert.deepEqual(parsed.basedOn, [{ name: 'skills', repo: 'acme/skills', ref: 'v1.0.0', license: 'MIT', url: 'example.com/skills' }], 'one origin parses to a one-entry list (#338)');
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
  const basedOn = 'basedOn must be { name, repo, ref, license, url } or a list of them, each a string';
  assert.deepEqual(headerErrors('name: x', 'basedOn: { name: skills, repo: acme/skills }'), [{ line: 3, message: basedOn }]);
  assert.deepEqual(headerErrors('basedOn: { name: a, repo: b, ref: c, license: d, url: e, extra: f }'), [{ line: 2, message: basedOn }]);
  assert.deepEqual(headerErrors('basedOn: { name: a, repo: b, ref: c, license: d, url: 7 }'), [{ line: 2, message: basedOn }]);
  assert.deepEqual(headerErrors('name: x', 'variables: [a, b]'), [{ line: 3, message: 'variables must be a mapping of declarations' }]);
  assert.deepEqual(
    headerErrors('variables:', '  a: { default: 3 }', '  b: { scope: x }').map((error) => [error.line, error.variable]),
    [[3, 'a'], [4, 'b']],
  );
});

test('basedOn is one origin or a non-empty list of them, read in header order; an empty list, a bad entry or a scalar is the one error at the key (#338)', () => {
  const origin = (name: string): string => `{ name: ${name}, repo: acme/${name}, ref: v1, license: MIT, url: example.com/${name} }`;
  const entry = (name: string) => ({ name, repo: `acme/${name}`, ref: 'v1', license: 'MIT', url: `example.com/${name}` });
  const parse = (...lines: string[]) => parseTemplate(['---', ...lines, '---', 'body', ''].join('\n'));
  const message = 'basedOn must be { name, repo, ref, license, url } or a list of them, each a string';
  assert.deepEqual(parse(`basedOn: ${origin('a')}`).basedOn, [entry('a')]);
  const listed = parse('name: x', 'basedOn:', `  - ${origin('a')}`, `  - ${origin('b')}`);
  assert.deepEqual([listed.basedOn, listed.errors], [[entry('a'), entry('b')], []]);
  assert.deepEqual(headerErrors('name: x', 'basedOn: []'), [{ line: 3, message }]);
  assert.deepEqual(headerErrors('basedOn:', `  - ${origin('a')}`, '  - { name: b }'), [{ line: 2, message }]);
  assert.deepEqual(headerErrors('basedOn: acme'), [{ line: 2, message }]);
  assert.equal(parse('basedOn: []').basedOn, undefined, 'a malformed basedOn answers no origin');
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

const at = (name: string, variables: RenderWorkspace['variables'] = {}): RenderWorkspace => ({ name, variables, builtIns: NO_BUILT_INS });

test('rendering takes the workspace\'s value, else the default; a null default takes the else; workspace is built in (#310)', () => {
  const parsed = parseTemplate(TEMPLATE);
  assert.deepEqual(renderTemplate(parsed, at('hive')), {
    ok: true,
    text: `${DELIVERED_HEADER}# Build for hive\nRun pnpm test.\nDelivery: single. Dry run: false. E2E: pnpm e2e.\n`,
  });
  assert.deepEqual(renderTemplate(parsed, at('hive-site')), {
    ok: true,
    text: `${DELIVERED_HEADER}# Build for hive-site\nNo test command.\nDelivery: stacked. Dry run: false. E2E: playwright test.\n`,
  });
});

test('a required variable with no value, an undeclared variable, a bad tag and a partial each answer an error at the file line (#310)', () => {
  assert.deepEqual(failure(renderTemplate(parseTemplate(TEMPLATE), at('other'))), [
    { line: 10, variable: 'e2eCommand', message: 'variable "e2eCommand" is required and has no value for workspace "other"' },
  ]);
  const undeclared = failure(renderTemplate(parseTemplate(`${TEMPLATE}Then {{ reviewer }}.\n`), at('hive')));
  assert.deepEqual(undeclared.map((error) => error.line), [16]);
  assert.match(undeclared[0].message, /reviewer/);
  assert.doesNotMatch(undeclared[0].message, /line:\d/, 'the body-relative position is not repeated');
  const unclosed = failure(renderTemplate(parseTemplate(`${TEMPLATE}{% if dryRun %}open\n`), at('hive')));
  assert.deepEqual(unclosed.map((error) => error.line), [16]);
  const partial = failure(renderTemplate(parseTemplate(`${TEMPLATE}{% include 'secrets' %}\n`), at('hive')));
  assert.deepEqual(partial.map((error) => error.line), [16], 'include has nothing to read: no file system');
  const malformed = parseTemplate(['---', 'variables:', '  a: { scope: x }', '---', '{{ a }}', ''].join('\n'));
  assert.deepEqual(renderTemplate(malformed, at('hive')), { ok: false, errors: malformed.errors });
});

test('the delivered header drops variables and basedOn; a plain file renders to itself byte for byte (#310)', () => {
  const plain = '---\nname: plain\ndescription:   odd   spacing   # a comment\n---\n# Plain\n\nNo variables, no blocks.\n';
  assert.deepEqual(renderTemplate(parseTemplate(plain), at('hive')), { ok: true, text: plain });
  assert.deepEqual(renderTemplate(parseTemplate('no header at all\n'), at('hive')), { ok: true, text: 'no header at all\n' });
  const kept = '---\nname: x  # kept\n---\nfor {{ workspace }}\n';
  assert.deepEqual(renderTemplate(parseTemplate(kept), at('hive')), { ok: true, text: '---\nname: x  # kept\n---\nfor hive\n' }, 'nothing removed: the header bytes stay');
  const onlyVariables = '---\nvariables:\n  a: { default: x }\n---\n{{ a }}\n';
  assert.deepEqual(renderTemplate(parseTemplate(onlyVariables), at('hive')), { ok: true, text: 'x\n' }, 'nothing left: no --- block');
  const delivered = renderTemplate(parseTemplate(TEMPLATE), at('hive'));
  assert.ok(delivered.ok);
  const header = parseTemplate(delivered.text).header;
  assert.deepEqual(Object.keys(header), ['name', 'description', 'model', 'tools']);
});

test('the delivered header drops a basedOn list too, and keeps every other key in order (#338)', () => {
  const listed = [
    '---', 'name: planner', 'basedOn:', '  - { name: a, repo: b, ref: c, license: d, url: e }', '  - { name: f, repo: g, ref: h, license: i, url: j }', 'model: opus', '---', 'Plan.', '',
  ].join('\n');
  assert.deepEqual(renderTemplate(parseTemplate(listed), at('hive')), { ok: true, text: '---\nname: planner\nmodel: opus\n---\nPlan.\n' });
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

test('src/template.ts imports nothing from node, so the UI can bundle it as is (#310); types.ts only type-only (#621), and repo-host.ts, Node-free itself (#1044)', () => {
  // Runs from dist/test: the TypeScript source is read as text.
  const imports = (file: string): string[] => [...readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
  const source = readFileSync(fileURLToPath(new URL('../../src/template.ts', import.meta.url)), 'utf8');
  assert.deepEqual(imports('template.ts'), ['liquidjs', 'yaml', './types.js', './repo-host.js']);
  assert.deepEqual(imports('repo-host.ts'), ['./trusted-hosts.js']);
  assert.deepEqual(imports('trusted-hosts.ts'), []);
  assert.match(source, /^import type \{[^}]*\} from '\.\/types\.js';$/m, 'erased: the bundle gets no types.ts');
  assert.doesNotMatch(source, /\bprocess\.|\brequire\(|import\(/);
});

test('a CRLF header reads its last value without \\r and the delivered header keeps CRLF (#310)', () => {
  const crlf = '---\r\nname: x\r\nvariables:\r\n  v: { default: a }\r\n  flag: { type: boolean, default: false }\r\n---\r\n{{ v }}\r\n';
  const parsed = parseTemplate(crlf);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.variables.map((variable) => variable.default), ['a', false]);
  assert.deepEqual(renderTemplate(parsed, at('hive')), { ok: true, text: '---\r\nname: x\r\n---\r\na\r\n' });
});

test('the delivered header keeps a long value on one line (#310)', () => {
  const long = 'word '.repeat(40).trim();
  const result = renderTemplate(parseTemplate(`---\ndescription: ${long}\nvariables:\n  a: { default: x }\n---\n{{ a }}\n`), at('hive'));
  assert.deepEqual(result, { ok: true, text: `---\ndescription: ${long}\n---\nx\n` });
});

test('a runaway loop fails as a render error instead of blocking (#310)', () => {
  const started = Date.now();
  const loop = '{% for i in (1..3000) %}{% for j in (1..3000) %}x{% endfor %}{% endfor %}';
  const errors = failure(renderTemplate(parseTemplate(`---\nname: x\n---\n${loop}\n`), at('hive')));
  assert.deepEqual(errors.map((error) => error.line), [4]);
  assert.ok(Date.now() - started < 5000, 'the render limit stops it');
});

test('splitHeader answers the header text, the body as a suffix of the text and the body\'s first line (#311)', () => {
  assert.deepEqual(splitHeader('---\nname: x\n---\n# Body\n'), { header: 'name: x\n', body: '# Body\n', bodyLine: 4 });
  assert.deepEqual(splitHeader('# No header\n'), { header: '', body: '# No header\n', bodyLine: 1 });
});

test('a declaration with from: is refused like any unknown key: the task origin is gone (#621)', () => {
  const text = ['---', 'name: x', 'variables:', '  planPath: { from: task }', '---', 'Read {{ planPath }}.', ''].join('\n');
  const [error] = parseTemplate(text).errors;
  assert.deepEqual([error?.line, error?.message], [4, 'variable "planPath": unknown key "from" (known: type, values, default, required, workspaces)']);
});

test('a workspace value renders where the template has no entry of its own; the entry overrides it, the default stands last, and an explicit null counts at each step (#621, decision 3)', () => {
  const header = (declaration: string): ParsedTemplate => parseTemplate(`---\nvariables:\n  dir: ${declaration}\n---\n[{{ dir }}]\n`);
  const body = (declaration: string, workspace: RenderWorkspace): string => {
    const result = renderTemplate(header(declaration), workspace);
    return result.ok ? result.text : assert.fail(result.errors[0]?.message);
  };
  assert.equal(body('{ default: d }', at('a', { dir: 'w' })), '[w]\n', 'the workspace value over the default');
  assert.equal(body('{ default: d, workspaces: { a: o } }', at('a', { dir: 'w' })), '[o]\n', 'the override over the workspace value');
  assert.equal(body('{ default: d, workspaces: { b: o } }', at('a', { dir: 'w' })), '[w]\n', 'another workspace\'s override is not this one\'s');
  assert.equal(body('{ default: d }', at('a')), '[d]\n', 'no value anywhere: the default');
  assert.equal(body('{ default: d, workspaces: { a: null } }', at('a', { dir: 'w' })), '[]\n', 'a null override');
  assert.equal(body('{ default: d }', at('a', { dir: null })), '[]\n', 'a null workspace value');
  const required = parseTemplate('---\nvariables:\n  team: { required: true }\n---\n{{ team }}\n');
  assert.deepEqual(renderTemplate(required, at('a', { team: 'core' })), { ok: true, text: 'core\n' }, 'a workspace value satisfies required');
});

test('valueSource names where the value comes from: the override, the workspace value, the default (#621)', () => {
  const [dir] = parseTemplate('---\nvariables:\n  dir: { default: d, workspaces: { a: o } }\n---\n{{ dir }}\n').variables;
  assert.deepEqual([valueSource(dir, at('a', { dir: 'w' })), valueSource(dir, at('b', { dir: 'w' })), valueSource(dir, at('b'))], ['override', 'workspace', 'default']);
  assert.deepEqual([valueFor(dir, at('a', { dir: 'w' })), valueFor(dir, at('b', { dir: 'w' })), valueFor(dir, at('b'))], ['o', 'w', 'd']);
});

test('a workspace value a declaration cannot take fails that workspace\'s render at the declaration\'s line, and no other workspace\'s (#621, decision 6)', () => {
  const parsed = parseTemplate('---\nvariables:\n  flags: { values: [none, always], default: none }\n  quick: { type: boolean, default: false }\n  dir: { default: d }\n---\n{{ flags }} {{ quick }} {{ dir }}\n');
  assert.deepEqual(failure(renderTemplate(parsed, at('a', { flags: 'sometimes' }))), [{ line: 3, variable: 'flags', message: 'variable "flags": the value of workspace "a" must be one of none, always' }]);
  assert.deepEqual(failure(renderTemplate(parsed, at('a', { quick: 'yes' }))), [{ line: 4, variable: 'quick', message: 'variable "quick": the value of workspace "a" must be true or false' }]);
  assert.deepEqual(failure(renderTemplate(parsed, at('a', { dir: true }))), [{ line: 5, variable: 'dir', message: 'variable "dir": the value of workspace "a" must be text' }]);
  assert.deepEqual(renderTemplate(parsed, at('b', { flags: 'always', quick: true })), { ok: true, text: 'always true d\n' });
  const overridden = parseTemplate('---\nvariables:\n  flags: { values: [none, always], default: none, workspaces: { a: always } }\n---\n{{ flags }}\n');
  assert.deepEqual(renderTemplate(overridden, at('a', { flags: 'sometimes' })), { ok: true, text: 'always\n' }, 'the override renders: the workspace value is not read');
});

// #742: the Hive's own values from the workspace's Settings, beside workspace
const BUILT = (builtIns: Partial<BuiltIns>): RenderWorkspace => ({ name: 'app', variables: {}, builtIns: { ...NO_BUILT_INS, ...builtIns } });
const BUILT_IN_BODY = [
  '---', 'name: x', '---',
  '{% if fork %}fork {{ fork.remote }} pr {{ fork.pr }} base remote {{ fork.baseRemote }}{% else %}no fork{% endif %}',
  '{% if baseBranch %}base {{ baseBranch }}{% else %}no base{% endif %}',
  '{% if nestedRepos.size > 0 %}nested {{ nestedRepos | join: ", " }}{% else %}no nested{% endif %}',
  '',
].join('\n');

test('the built-ins render from the workspace: a fork with each pr, no fork, a base set and not, nested repos and none (#742, decision 2)', () => {
  const parsed = parseTemplate(BUILT_IN_BODY);
  const body = (workspace: RenderWorkspace): string => {
    const result = renderTemplate(parsed, workspace);
    return result.ok ? result.text.replace('---\nname: x\n---\n', '') : assert.fail(result.errors[0]?.message);
  };
  assert.equal(body(BUILT({})), 'no fork\nno base\nno nested\n', 'decision 7: no workspace\'s Settings');
  for (const pr of PR_TARGETS) {
    const baseRemote = pr === 'fork' ? 'origin' : 'upstream';
    assert.equal(body(BUILT({ fork: { remote: 'upstream', pr, baseRemote } })).split('\n')[0], `fork upstream pr ${pr} base remote ${baseRemote}`, pr);
  }
  assert.equal(body(BUILT({ baseBranch: 'devtest', nestedRepos: ['docs', 'ee'] })), 'no fork\nbase devtest\nnested docs, ee\n');
});

test("gitlabHosts renders gitlab.com first, then the config's hosts; a render for no workspace has gitlab.com alone (#1044, decision 11)", () => {
  const parsed = parseTemplate('---\nname: x\n---\n{{ gitlabHosts | join: "," }} {% if gitlabHosts contains "git.example.com" %}listed{% else %}unlisted{% endif %}\n');
  const body = (workspace: RenderWorkspace): string => {
    const result = renderTemplate(parsed, workspace);
    return result.ok ? result.text.replace('---\nname: x\n---\n', '') : assert.fail(result.errors[0]?.message);
  };
  assert.equal(body(BUILT({})), 'gitlab.com unlisted\n');
  assert.equal(body(BUILT({ gitlabHosts: ['gitlab.com', 'git.example.com'] })), 'gitlab.com,git.example.com listed\n');
});

test('declaring a built-in is refused at its line, and no workspace value takes its name (#742, decision 6)', () => {
  for (const name of BUILT_INS) {
    const errors = headerErrors('variables:', `  ${name}: { default: x }`);
    assert.deepEqual(errors.map((error) => [error.line, error.variable, error.message]), [[3, name, `variable "${name}": ${name} is built in and cannot be declared`]], name);
    assert.equal(isVariableName(name), false, name);
  }
  assert.equal(isVariableName('forked'), true, 'only the names themselves');
});

// #665: an agent's neutral can: and the tools line the delivery writes from it for Claude Code. Its can: is file line 4.
const agentHeader = (...lines: string[]): string => ['---', 'name: reviewer', 'description: Reviews.', ...lines, '---', 'Body.', ''].join('\n');
const KNOWN_CAPABILITIES = 'read, write, shell, dispatch';

test('toolsLine gives each capability its Claude tools, in read, write, shell, dispatch order whatever the list\'s (#665)', () => {
  assert.equal(toolsLine(['read']), 'Read, Grep, Glob');
  assert.equal(toolsLine(['shell', 'read']), 'Read, Grep, Glob, Bash');
  assert.equal(toolsLine(['read', 'write']), 'Read, Grep, Glob, Write, Edit');
  assert.equal(toolsLine(['dispatch', 'shell', 'write', 'read']), 'Read, Grep, Glob, Write, Edit, Bash, Agent');
});

test('the delivered header gains tools: from can: and keeps can:; a written tools: stays untouched; a header with neither is delivered as written (#665)', () => {
  assert.equal(
    deliveredHeader(parseTemplate(agentHeader('can: [read, shell]'))),
    '---\nname: reviewer\ndescription: Reviews.\ncan: [read, shell]\ntools: Read, Grep, Glob, Bash\n---\n',
  );
  const both = agentHeader('can: [read]', 'tools: Read, mcp__graphify');
  assert.equal(deliveredHeader(parseTemplate(both)), both.slice(0, both.indexOf('Body.')), 'a written tools: wins, byte for byte');
  const neither = agentHeader('tools: Read');
  assert.equal(deliveredHeader(parseTemplate(neither)), neither.slice(0, neither.indexOf('Body.')), 'no can:, no declaration: as today');
  const credited = agentHeader('can: [read, write]', 'basedOn: { name: a, repo: b, ref: c, license: d, url: e }');
  assert.equal(
    deliveredHeader(parseTemplate(credited)),
    '---\nname: reviewer\ndescription: Reviews.\ncan: [read, write]\ntools: Read, Grep, Glob, Write, Edit\n---\n',
    'basedOn goes and the tools line comes last',
  );
});

test('a block list or a commented can: is delivered as a one-line flow list, the only form Codex\'s role reader parses (#665)', () => {
  const expected = '---\nname: reviewer\ndescription: Reviews.\ncan: [read, write]\ntools: Read, Grep, Glob, Write, Edit\n---\n';
  assert.equal(deliveredHeader(parseTemplate(agentHeader('can:\n  - read\n  - write'))), expected);
  assert.equal(deliveredHeader(parseTemplate(agentHeader('can: [read, write] # x'))), expected);
});

test('a blank tools: next to can: is no written line: the render writes it from can: (#665)', () => {
  assert.equal(
    deliveredHeader(parseTemplate(agentHeader('can: [read]', 'tools:'))),
    '---\nname: reviewer\ndescription: Reviews.\ncan: [read]\ntools: Read, Grep, Glob\n---\n',
  );
});

test('renderTemplate delivers a plain agent with can: through its header, not byte for byte (#665)', () => {
  assert.deepEqual(renderTemplate(parseTemplate(agentHeader('can: [read]')), at('hive')), {
    ok: true,
    text: '---\nname: reviewer\ndescription: Reviews.\ncan: [read]\ntools: Read, Grep, Glob\n---\nBody.\n',
  });
});

test('a can: that is not a non-empty list of known capabilities is one error at its line, naming the four (#665)', () => {
  assert.deepEqual(headerErrors('name: x', 'can: [read, fly]'), [{ line: 3, message: `unknown capability "fly" in can (known: ${KNOWN_CAPABILITIES})` }]);
  assert.deepEqual(headerErrors('name: x', 'can: read'), [{ line: 3, message: `can must be a non-empty list out of ${KNOWN_CAPABILITIES}` }]);
  assert.deepEqual(headerErrors('can: []'), [{ line: 2, message: `can must be a non-empty list out of ${KNOWN_CAPABILITIES}` }]);
  assert.deepEqual(headerErrors('can: [read, write, shell, dispatch]'), []);
  assert.deepEqual(failure(renderTemplate(parseTemplate(agentHeader('can: [fly]')), at('hive'))).map((error) => error.line), [4], 'a typo never silently drops a tool');
});
