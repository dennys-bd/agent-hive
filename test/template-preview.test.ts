import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTemplate, renderTemplate } from '../src/template.js';
import { buildMap } from '../src/template-map.js';
import { type Preview, previewTemplate } from '../src/template-preview.js';

// The "view as" preview (#319): every body line for one workspace, its markers and the branches that do not hold flagged.
const REPO = new URL('../../', import.meta.url); // runs from dist/test
const NEW_BUILD = readFileSync(fileURLToPath(new URL('assets/plugin/skills/new-build/SKILL.md', REPO)), 'utf8');
const CHAINS = [
  '---',
  'name: chains',
  'variables:',
  '  delivery: { values: [stacked, single], default: single, workspaces: { hive-site: stacked } }',
  '  quick: { type: boolean, workspaces: { agent-hive: true } }',
  '  testCommand: { default: null, workspaces: { hive-site: pnpm test } }',
  '---',
  '# chains', // 8
  '',
  'Run {{ testCommand }} in {{ workspace }}.', // 10
  '',
  '## Delivery', // 12
  '{% if delivery == "stacked" %}', // 13
  'One PR per slice.', // 14
  '{% elsif delivery == "single" %}', // 15
  'One PR.', // 16
  '{% else %}', // 17
  'No PR.', // 18
  '{% endif %}', // 19
  '{% unless quick %}', // 20
  'Review it.', // 21
  '{% endunless %}', // 22
  '',
  '## Done', // 24
  '{% if testCommand %}', // 25
  'Run `{{ testCommand }}`.', // 26
  '{% else %}', // 27
  'Run the project tests.', // 28
  '{% endif %}', // 29
  '',
].join('\n');
const parsed = parseTemplate(CHAINS);
const map = buildMap(parsed);

function kept(preview: Preview): string {
  assert.ok(preview.ok);
  return preview.header + preview.lines.filter((l) => l.holds).map((l) => l.text).join('\n');
}
function holding(preview: Preview, lines: number[]): boolean[] {
  assert.ok(preview.ok);
  return lines.map((n) => preview.lines.find((l) => l.line === n)?.holds ?? false);
}

test('for each workspace the lines that hold join to its render, and the branch Liquid takes is the one that holds, nested in a ## or not (#319)', () => {
  for (const workspace of ['agent-hive', 'hive-site']) {
    const preview = previewTemplate(parsed, map, workspace);
    const render = renderTemplate(parsed, workspace);
    assert.ok(preview.ok && render.ok, workspace);
    assert.equal(preview.isExact, true, workspace);
    assert.equal(kept(preview), render.text, workspace);
  }
  // if / elsif / else on a list, unless on a boolean, if on a text with default null
  assert.deepEqual(holding(previewTemplate(parsed, map, 'hive-site'), [14, 16, 18, 21, 26, 28]), [true, false, false, true, true, false]);
  assert.deepEqual(holding(previewTemplate(parsed, map, 'agent-hive'), [14, 16, 18, 21, 26, 28]), [false, true, false, false, false, true]);
});

test("each marker is flagged as the empty line Liquid leaves; the header is the delivered one; a line's variables resolve (#319)", () => {
  const preview = previewTemplate(parsed, map, 'hive-site');
  assert.ok(preview.ok);
  assert.deepEqual(preview.lines.filter((l) => l.isMarker).map((l) => [l.line, l.text]), [[13, ''], [15, ''], [17, ''], [19, ''], [20, ''], [22, ''], [25, ''], [27, ''], [29, '']]);
  assert.equal(preview.header, '---\nname: chains\n---\n');
  assert.equal(preview.lines.find((l) => l.line === 10)?.text, 'Run pnpm test in hive-site.');
  const other = previewTemplate(parsed, map, 'agent-hive');
  assert.ok(other.ok);
  assert.equal(other.lines.find((l) => l.line === 10)?.text, 'Run  in agent-hive.');
});

test('new-build, with no Liquid, previews as itself: every line holds and none is a marker (#319)', () => {
  const shipped = parseTemplate(NEW_BUILD);
  const preview = previewTemplate(shipped, buildMap(shipped), 'agent-hive');
  assert.ok(preview.ok);
  assert.deepEqual([preview.isExact, preview.lines.every((l) => l.holds && !l.isMarker)], [true, true]);
  assert.equal(kept(preview), NEW_BUILD);
});

test('a required variable with no value for the workspace answers the render error at its line (#319)', () => {
  const p = parseTemplate('---\nvariables:\n  e2eCommand: { required: true, workspaces: { hive-site: pnpm e2e } }\n---\nRun {{ e2eCommand }}.\n');
  assert.deepEqual(previewTemplate(p, buildMap(p), 'agent-hive'), {
    ok: false,
    errors: [{ line: 3, variable: 'e2eCommand', message: 'variable "e2eCommand" is required and has no value for workspace "agent-hive"' }],
  });
  assert.equal(previewTemplate(p, buildMap(p), 'hive-site').ok, true);
});

test("a construct a line-by-line render cannot follow (a loop) answers isExact false with the render's text, nothing dimmed (#319)", () => {
  const p = parseTemplate('{% for i in (1..2) %}\nA{{ i }}\n{% endfor %}\n');
  const preview = previewTemplate(p, buildMap(p), 'agent-hive');
  const render = renderTemplate(p, 'agent-hive');
  assert.ok(preview.ok && render.ok);
  assert.equal(preview.isExact, false);
  assert.equal(kept(preview), render.text);
  assert.ok(preview.lines.every((l) => l.holds && !l.isMarker));
});

test('src/template-preview.ts imports nothing from node, so the editor can bundle it as is (#319)', () => {
  const source = readFileSync(fileURLToPath(new URL('src/template-preview.ts', REPO)), 'utf8');
  assert.deepEqual([...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['./template-map.js', './template.js']);
  assert.doesNotMatch(source, /\bprocess\.|\brequire\(|import\(/);
});
