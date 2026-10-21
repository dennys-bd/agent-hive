import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deliveredName, type ParsedTemplate, parseTemplate } from '../src/template.js';
import { type LintAnnotation, type LintInput, type LintItem, lintTemplate, variableUses } from '../src/template-lint.js';

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
      variable: 'e2eCommand',
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
      variable: 'baseBranch',
      ref: '/stacked-branch',
    },
    {
      line: 5,
      severity: 'red',
      check: 'callRequired',
      title: 'missing baseBranch · /hive:stacked-branch · hive-site',
      body: '/hive:stacked-branch requires "baseBranch", which has no value for hive-site.',
      workspaces: ['hive-site'],
      variable: 'baseBranch',
      ref: '/hive:stacked-branch',
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

test('a heading deeper than the previous by more than one level is yellow; fences and the first heading are not checked (#312)', () => {
  assert.deepEqual(
    lint([], [
      '### first',
      '# A',
      '### skipped',
      '## B',
      '#### skipped again',
      '```md',
      '# quoted',
      '#### quoted',
      '```',
      '````markdown',
      '```mermaid',
      '```',
      '###### inside the outer fence',
      '````',
      '## C',
      '####### not a heading',
      '#no space',
    ]),
    ['6 yellow heading skipped level: h1 to h3', '8 yellow heading skipped level: h2 to h4'],
  );
});

test('annotations sort by line, then red before yellow, then title (#312)', () => {
  assert.deepEqual(lint([], ['Run scripts/missing.mjs, hive:ghost and `/nowhere`, then /hive:stacked-branch.']), [
    '4 red callRequired missing baseBranch · /hive:stacked-branch · hive-site',
    '4 yellow reference unknown skill, agent or script /nowhere',
    '4 yellow reference unknown skill, agent or script hive:ghost',
    '4 yellow reference unknown skill, agent or script scripts/missing.mjs',
  ]);
});

const PLUGIN = new URL('../../assets/plugin/', import.meta.url); // this file runs from dist/test/
test('every shipped skill and agent lints clean against a catalogue of the plugin and its scripts (#312)', () => {
  const read = (path: string): ParsedTemplate => parseTemplate(readFileSync(new URL(path, PLUGIN), 'utf8'));
  const skills = readdirSync(new URL('skills/', PLUGIN), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ kind: 'skill' as const, name: entry.name, path: `skills/${entry.name}/SKILL.md.liquid` }));
  const agents = readdirSync(new URL('agents/', PLUGIN))
    .filter((file) => deliveredName(file).endsWith('.md'))
    .map((file) => ({ kind: 'specialist' as const, name: deliveredName(file).slice(0, -'.md'.length), path: `agents/${file}` }));
  const shipped = [...skills, ...agents].map((item) => ({ ...item, parsed: read(item.path) }));
  const catalogue: LintItem[] = shipped.map(({ kind, name, parsed }) => ({ origin: 'hive', kind, name, variables: parsed.variables }));
  const scripts = readdirSync(new URL('scripts/', PLUGIN)).map((file) => `scripts/${file}`);
  assert.ok(skills.length > 0 && agents.length > 0 && scripts.length > 0, 'the plugin was read');
  for (const { kind, name, path, parsed } of shipped) {
    const input: LintInput = { self: { origin: 'hive', kind, name }, catalogue, workspaces: ['hive', 'hive-site'], scripts };
    assert.deepEqual(lintTemplate(parsed, input), [], path);
  }
});

test('two Hive skills called on one line that miss the same variable name each get their annotation (#312)', () => {
  const required = parseTemplate('---\nvariables:\n  v: { required: true }\n---\n{{ v }}\n').variables;
  const catalogue: LintItem[] = ['a', 'b'].map((name) => ({ origin: 'hive', kind: 'skill', name, variables: required }));
  assert.deepEqual(brief(lintTemplate(template([], ['Run `/a` and `/b`.']), { ...INPUT, catalogue })), [
    '4 red callRequired missing v · /a · hive, hive-site',
    '4 red callRequired missing v · /b · hive, hive-site',
  ]);
});

test('a runaway render stops the other workspaces once the budget is spent, so one lint costs about one render limit (#312)', () => {
  const workspaces = ['a', 'b', 'c', 'd'];
  const started = Date.now();
  const annotations = lintTemplate(template([], ['{% for i in (1..99999999) %}{{ i }}{% endfor %}']), { ...INPUT, workspaces });
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].check, 'render');
});

test('variableUses answers the file lines that use a variable, a condition in an else branch included, and [] for an unused one (#321)', () => {
  // lines: 3 variables:, 4 x, 5 y, 6 z, 7 the fence, 8 # T, 9 Run, 10 if y, 11 yes, 12 else, 13 the nested condition on x, 14 endif, 15 two uses
  const parsed = template(
    ['variables:', '  x: { default: a }', '  y: { default: b }', '  z: { default: c }'],
    ['# T', 'Run {{ x }}.', '{% if y %}', 'yes', '{% else %}', '{% if x == "a" %}a{% endif %}', '{% endif %}', '{{ x }} and {{ x | upcase }}'],
  );
  assert.deepEqual(variableUses(parsed, 'x'), [9, 13, 15]);
  assert.deepEqual(variableUses(parsed, 'y'), [10]);
  assert.deepEqual(variableUses(parsed, 'z'), []);
  assert.deepEqual(variableUses(template([], ['{% if x %}']), 'x'), [], 'a body Liquid cannot parse has no uses to name');
});

test('each finding names what a fix or a card needs: the variable, the reference as written, the level the map nests a heading as (#327)', () => {
  // lines: 3 variables:, 4 a, 5 the fence, 6 {{ b }}, 7 the reference, 8 ## A, 9 #### B
  const annotations = lintTemplate(template(['variables:', '  a: { default: x }'], ['{{ b }}', 'Run `/nowhere`.', '## A', '#### B']), INPUT);
  assert.deepEqual(annotations.map(({ line, check, variable, ref, level }) => [line, check, variable, ref, level]), [
    [4, 'unused', 'a', undefined, undefined],
    [6, 'undeclared', 'b', undefined, undefined],
    [7, 'reference', undefined, '/nowhere', undefined],
    [9, 'heading', undefined, undefined, 3],
  ]);
});
