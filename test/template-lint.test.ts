import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type ParsedTemplate, parseTemplate } from '../src/template.js';
import { type LintAnnotation, type LintInput, type LintItem, lintTemplate } from '../src/template-lint.js';

// The structural lint (#312): each check alone, the grouping of workspaces, the render's dedup, the shipped plugin linting clean.
// Escaped, so the linter does not read a plain string's ${...} as a template mistake.
const PLUGIN_ROOT = `\${CLAUDE_PLUGIN_ROOT}`;

const STACKED: LintItem = {
  origin: 'hive',
  kind: 'skill',
  name: 'stacked-branch',
  variables: parseTemplate('---\nvariables:\n  baseBranch: { required: true, workspaces: { hive: main } }\n---\n{{ baseBranch }}\n').variables,
};
const INPUT: LintInput = {
  self: { origin: 'hive', kind: 'skill', name: 'x' },
  catalogue: [
    STACKED,
    { origin: 'hive', kind: 'specialist', name: 'architect', variables: [] },
    { origin: 'hive-site', kind: 'skill', name: 'deploy', variables: [] },
  ],
  workspaces: ['hive', 'hive-site'],
  scripts: ['scripts/check-hv.mjs'],
};

/** A template named x: line 1 is the fence, line 2 its name, the given header lines from line 3, then the fence and the body. */
const template = (header: string[], body: string[]): ParsedTemplate =>
  parseTemplate(['---', 'name: x', ...header, '---', ...body, ''].join('\n'));
/** Each annotation as `<line> <severity> <check> <title>`, in the lint's order. */
const brief = (annotations: LintAnnotation[]): string[] =>
  annotations.map(({ line, severity, check, title }) => `${line} ${severity} ${check} ${title}`);
const lint = (header: string[], body: string[]): string[] => brief(lintTemplate(template(header, body), INPUT));

test('a header error is answered alone: nothing else is checked (#312)', () => {
  assert.deepEqual(lint(['variables:', '  a: { default: 3 }'], ['{{ b }}', '# A', '### C']), [
    '4 red parse variable "a": default must be text',
  ]);
});

test('a Liquid parse error in the body is red at its file line and stops the variable checks (#312)', () => {
  const annotations = lint([], ['ok', '{% if workspace %}open {{ nobody }}']);
  assert.equal(annotations.length, 1, annotations.join('\n'));
  assert.match(annotations[0], /^5 red parse .*not closed/);
  assert.doesNotMatch(annotations[0], /line:\d/, 'the body-relative position is not repeated');
});

test('an undeclared variable is red once per line it is used on; workspace is built in (#312)', () => {
  assert.deepEqual(lint([], ['# T', 'Ask {{ reviewer }} and {{ reviewer | upcase }}.', 'For {{ workspace }}, {{ reviewer }}.']), [
    '5 red undeclared undeclared variable reviewer',
    '6 red undeclared undeclared variable reviewer',
  ]);
});

test('a variable used only in an else is not unused; an undeclared one there is reported; an unused one is yellow (#312)', () => {
  assert.deepEqual(
    lint(
      ['variables:', '  a: { default: x }', '  b: { default: y }', '  d: { default: z }'],
      ['{% if b %}yes{% else %}{{ a }} {{ c }}{% endif %}'],
    ),
    ['6 yellow unused unused variable d', '8 red undeclared undeclared variable c'],
  );
});

test('a required variable missing in two workspaces is one annotation on its declaration naming both (#312)', () => {
  assert.deepEqual(lintTemplate(template(['variables:', '  e2eCommand: { required: true, workspaces: { hive: null } }'], ['{{ e2eCommand }}']), INPUT), [
    {
      line: 4,
      severity: 'red',
      check: 'required',
      title: 'missing e2eCommand · hive, hive-site',
      body: '"e2eCommand" is required and has no value for hive, hive-site.',
      workspaces: ['hive', 'hive-site'],
    },
  ]);
  assert.deepEqual(lint(['variables:', '  e2eCommand: { required: true, workspaces: { hive: pnpm e2e } }'], ['{{ e2eCommand }}']), [
    '4 red required missing e2eCommand · hive-site',
  ]);
});

test('neither template-refs.ts nor template-lint.ts imports from node, so the UI can bundle them as is (#312)', () => {
  // Runs from dist/test: the TypeScript sources are read as text.
  const imports = (file: string): string[] => {
    const source = readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\bprocess\.|\brequire\(|import\(/, file);
    return [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  };
  assert.deepEqual(imports('template-refs.ts'), ['./template.js']);
  assert.deepEqual(imports('template-lint.ts'), ['liquidjs', './template.js', './template-refs.js', './types.js']);
});

test('a reference to nothing is yellow; a Hive item, a workspace skill, a script and the template itself resolve (#312)', () => {
  assert.deepEqual(lint([], ['Run `/nowhere`.', 'Ask hive:ghost.', 'Then scripts/missing.mjs.', 'Not hive:deploy either.']), [
    '4 yellow reference unknown skill, agent or script /nowhere',
    '5 yellow reference unknown skill, agent or script hive:ghost',
    '6 yellow reference unknown skill, agent or script scripts/missing.mjs',
    '7 yellow reference unknown skill, agent or script hive:deploy',
  ]);
  assert.deepEqual(lint([], [`Run \`/deploy\`, hive:architect, \`/hive:x\` and \`node "${PLUGIN_ROOT}/scripts/check-hv.mjs"\`.`]), []);
});

test('calling a Hive skill whose required variable has no value in a workspace is red on the calling line (#312)', () => {
  assert.deepEqual(lintTemplate(template([], ['Then run `/stacked-branch`.', 'And /hive:stacked-branch twice: /hive:stacked-branch.']), INPUT), [
    {
      line: 4,
      severity: 'red',
      check: 'callRequired',
      title: 'missing baseBranch · /stacked-branch · hive-site',
      body: '/stacked-branch requires "baseBranch", which has no value for hive-site.',
      workspaces: ['hive-site'],
    },
    {
      line: 5,
      severity: 'red',
      check: 'callRequired',
      title: 'missing baseBranch · /hive:stacked-branch · hive-site',
      body: '/hive:stacked-branch requires "baseBranch", which has no value for hive-site.',
      workspaces: ['hive-site'],
    },
  ]);
});

test('a render error is one annotation naming its workspaces; a workspace missing a required variable is not rendered (#312)', () => {
  const both = lintTemplate(template([], ["{% include 'secrets' %}"]), INPUT);
  assert.deepEqual(both.map(({ line, severity, check, workspaces }) => [line, severity, check, workspaces]), [[4, 'red', 'render', ['hive', 'hive-site']]]);
  assert.match(both[0].title, /secrets/);
  assert.equal(both[0].body, 'The render for hive, hive-site fails here.');

  const partial = lintTemplate(template(['variables:', '  a: { required: true, workspaces: { hive: x } }'], ['{{ a }}', "{% include 'secrets' %}"]), INPUT);
  assert.deepEqual(partial.map(({ line, check, workspaces }) => [line, check, workspaces]), [
    [4, 'required', ['hive-site']],
    [7, 'render', ['hive']],
  ]);

  assert.deepEqual(lint([], ['{{ reviewer }}']), ['4 red undeclared undeclared variable reviewer'], 'no render error repeats a static one');
});
