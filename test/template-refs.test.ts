import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplate } from '../src/template.js';
import { type TemplateRef, templateRefs } from '../src/template-refs.js';

// The references of a template (#312): what the lint checks and the map's chips (1.2) show.
// Escaped, so the linter does not read a plain string's ${...} as a template mistake.
const PLUGIN_ROOT = `\${CLAUDE_PLUGIN_ROOT}`;

/** The references of a template named x whose body is the given lines; the body starts at file line 4. */
const refsOf = (...body: string[]): TemplateRef[] => templateRefs(parseTemplate(['---', 'name: x', '---', ...body, ''].join('\n')));

test('the Hive, bare and script forms are found with their file lines, in column order (#312)', () => {
  assert.deepEqual(
    refsOf(
      'Run /hive:new-pr, then dispatch hive:architect.',
      'Call `/stacked-branch` first.',
      `Run \`node "${PLUGIN_ROOT}/scripts/check-hv.mjs" "<folder>"\` and scripts/import-dc.mjs.`,
    ),
    [
      { line: 4, kind: 'hive', name: 'new-pr', text: '/hive:new-pr' },
      { line: 4, kind: 'hive', name: 'architect', text: 'hive:architect' },
      { line: 5, kind: 'bare', name: 'stacked-branch', text: '/stacked-branch' },
      { line: 6, kind: 'script', name: 'scripts/check-hv.mjs', text: `${PLUGIN_ROOT}/scripts/check-hv.mjs` },
      { line: 6, kind: 'script', name: 'scripts/import-dc.mjs', text: 'scripts/import-dc.mjs' },
    ],
  );
});

test('prose paths, other namespaces, Claude Code commands and paths in inline code are not references (#312)', () => {
  assert.deepEqual(
    refsOf(
      'Write to /tmp first; superpowers:brainstorming and ecc:plan are not ours.',
      'Neither is `/superpowers:brainstorming`, `/clear`, `/tmp/x`, `<specsDir>/<file>`, `try/catch` or `dist/scripts/x.mjs`.',
      'Nor agent-hive:x.',
    ),
    [],
  );
});

test('a reference inside a fenced block counts; the bare form only inside inline code (#312)', () => {
  assert.deepEqual(refsOf('```sh', 'claude /hive:new-spec', 'run /stacked-branch', '```'), [
    { line: 5, kind: 'hive', name: 'new-spec', text: '/hive:new-spec' },
  ]);
});

test('hive:<name> inside a URL or a path is not a reference (#312)', () => {
  assert.deepEqual(refsOf('See https://h/hive:y and a/hive:z.'), []);
});

test('a line of thousands of unclosed backticks is scanned in linear time (#312)', () => {
  const started = Date.now();
  assert.deepEqual(refsOf(`${'`'.repeat(100_000)}a`), []);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});
