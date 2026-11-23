import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnnotations, REVIEW_SCHEMA, REVIEWER_ID, REVIEWER_NAME, reviewPrompt } from '../src/reviewer.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginSource } from '../src/hooks-settings.js';
import { readCatalogue } from '../src/items-catalogue.js';
import { deliveredHeader, parseTemplate, renderTemplate } from '../src/template.js';
import { tempDir } from './temp-dir.js';

import type { TemplateVariable } from '../src/template.js';

const NOTE = { line: 2, severity: 'red', title: 'Two branches contradict', body: 'Both branches hold for ts.' } as const;
const THREE = 'a\nb\nc\n';
const answer = (annotations: unknown[]): string => JSON.stringify({ annotations });

test("an answer whose every line is in the text is accepted, each annotation marked as the agent's advice; an empty list is an answer; a key the schema does not name is dropped (#328, #981)", () => {
  assert.deepEqual(parseAnnotations(answer([NOTE, { ...NOTE, line: 3, severity: 'yellow' }]), THREE), {
    annotations: [{ ...NOTE, source: 'agent', kind: 'advice' }, { ...NOTE, line: 3, severity: 'yellow', source: 'agent', kind: 'advice' }], demoted: [],
  });
  assert.deepEqual(parseAnnotations(answer([]), ''), { annotations: [], demoted: [] }, 'nothing wrong, even in an empty file');
  assert.deepEqual(parseAnnotations(answer([{ ...NOTE, fix: 'rewrite it' }]), THREE), { annotations: [{ ...NOTE, source: 'agent', kind: 'advice' }], demoted: [] });
});

test('not JSON, a missing field, a severity outside yellow and red, a line 0 or past the last line refuse the whole answer with a reason (#328)', () => {
  const reason = (raw: unknown): string => {
    const parsed = parseAnnotations(typeof raw === 'string' ? raw : JSON.stringify(raw), THREE);
    assert.ok('reason' in parsed, JSON.stringify(raw));
    return parsed.reason;
  };
  assert.match(reason('Sure! {"annotations": []}'), /^not JSON$/);
  assert.match(reason({ notes: [] }), /^not the expected JSON: annotations:/);
  assert.match(reason({ annotations: [{ ...NOTE, title: undefined }] }), /^not the expected JSON: annotations\.0\.title:/);
  assert.match(reason({ annotations: [{ ...NOTE, severity: 'green' }] }), /^not the expected JSON: annotations\.0\.severity:/);
  assert.match(reason({ annotations: [{ ...NOTE, line: 1.5 }] }), /^not the expected JSON: annotations\.0\.line:/);
  assert.match(reason({ annotations: [{ ...NOTE, kind: 'rewrite' }] }), /^not the expected JSON: annotations\.0\.kind:/);
  assert.equal(reason({ annotations: [NOTE, { ...NOTE, line: 0 }] }), 'line 0 is outside 1..3', 'one bad line refuses the good ones too');
  assert.equal(reason({ annotations: [{ ...NOTE, line: 4 }] }), 'line 4 is outside 1..3');
});

// Lines: the title 1, the step 2, a stop 3, the same step again 4
const STEP = 'If it looks fine, continue to the PR.';
const TEXT = `# Review\n${STEP}\nStop.\n${STEP}\n`;
const FIX = { ...NOTE, kind: 'fix', span: STEP, replacement: 'If no finding is high or critical, continue to the PR.' } as const;
const adviceOn = (line: number) => ({ ...NOTE, line, source: 'agent', kind: 'advice' });

test('an answer without kind, or an advice, drops any span it carries; a fix whose span starts on its line keeps span and replacement, with an empty replacement, over several lines, and on the later of two identical lines (#981)', () => {
  assert.deepEqual(parseAnnotations(answer([{ ...NOTE, span: STEP, replacement: 'x' }]), TEXT), { annotations: [adviceOn(2)], demoted: [] }, 'the old shape');
  assert.deepEqual(parseAnnotations(answer([{ ...NOTE, kind: 'advice', span: STEP, replacement: 'x' }]), TEXT), { annotations: [adviceOn(2)], demoted: [] });
  for (const fix of [FIX, { ...FIX, replacement: '' }, { ...FIX, span: `${STEP}\nStop.` }, { ...FIX, line: 4 }]) {
    assert.deepEqual(parseAnnotations(answer([fix]), TEXT), { annotations: [{ ...fix, source: 'agent' }], demoted: [] }, JSON.stringify(fix));
  }
});

test('a fix with no span, no replacement, a replacement equal to its span, or a span that does not start on its line reads as advice and is listed in demoted (#981)', () => {
  const cases: [{ line: number; [key: string]: unknown }, string][] = [
    [{ ...FIX, span: null }, 'line 2: no span'],
    [{ ...FIX, span: '' }, 'line 2: no span'],
    [{ ...FIX, span: undefined }, 'line 2: no span'],
    [{ ...FIX, replacement: null }, 'line 2: no replacement'],
    [{ ...FIX, replacement: STEP }, 'line 2: the replacement is the span'],
    [{ ...FIX, span: 'Never stop.' }, 'line 2: the span is not on its line'],
    [{ ...FIX, span: '# Review' }, 'line 2: the span is not on its line'], // found only before its line
    [{ ...FIX, line: 3 }, 'line 3: the span is not on its line'], // the next occurrence starts on line 4
  ];
  for (const [fix, why] of cases) {
    assert.deepEqual(parseAnnotations(answer([fix]), TEXT), { annotations: [adviceOn(fix.line)], demoted: [why] }, why);
  }
});

test("a line outside the text still refuses the whole answer, fixes included; the schema's item requires every one of its fields (#981)", () => {
  assert.deepEqual(parseAnnotations(answer([FIX, { ...FIX, line: 5 }]), TEXT), { reason: 'line 5 is outside 1..4' });
  assert.deepEqual(REVIEW_SCHEMA.properties.annotations.items.required, ['line', 'severity', 'title', 'body', 'kind', 'span', 'replacement']);
});

test("the prompt is the agent's instructions first, then the open file numbered, the item's other files by path, the variables and the catalogue (#328)", () => {
  const lang: TemplateVariable = { name: 'lang', kind: 'list', values: ['ts', 'py'], default: 'ts', required: true, workspaces: { 'hive-site': 'py' }, line: 3 };
  const prompt = reviewPrompt({
    instructions: 'You review templates.', path: 'SKILL.md', kind: 'skill', text: '# x\nRun it.\n',
    others: [{ path: 'scripts/run.sh', text: 'echo hi\n' }], variables: [lang],
    catalogue: [{ id: 'hive:architect', kind: 'specialist', name: 'architect', description: 'Designs' }],
  });
  assert.ok(prompt.startsWith('You review templates.\n\n'), prompt);
  for (const part of ['SKILL.md, a skill', '1| # x', '2| Run it.', '### scripts/run.sh\necho hi', '"name": "lang"', '"hive-site": "py"', 'hive:architect (subagent architect): Designs']) {
    assert.ok(prompt.includes(part), part);
  }
  assert.ok(prompt.indexOf('2| Run it.') < prompt.indexOf('### scripts/run.sh'), 'the open file comes before the context');
  const alone = reviewPrompt({ instructions: 'i', path: 'tdd.md', kind: 'specialist', text: '', others: [], variables: [], catalogue: [] });
  for (const part of ['tdd.md, a subagent', '(empty file)', '## Other files of the item (context only)\n(none)']) assert.ok(alone.includes(part), part);
});

test('the catalogue lists hive:template-reviewer as a specialist of the plugin, and its text renders with the defaults to instructions that ask for the JSON (#328)', async (t) => {
  const catalogue = await readCatalogue({ home: await tempDir(t, 'reviewer-home-'), pluginSource: pluginSource(), workspaces: [] });
  const item = catalogue.find((i) => i.id === REVIEWER_ID);
  assert.deepEqual([item?.origin, item?.kind, item?.name], ['hive', 'specialist', REVIEWER_NAME]);
  const parsed = parseTemplate(await readFile(join(pluginSource(), 'agents', `${REVIEWER_NAME}.md`), 'utf8'));
  const rendered = renderTemplate(parsed, '');
  assert.ok(rendered.ok, JSON.stringify(parsed.errors));
  const body = rendered.text.slice(deliveredHeader(parsed).length);
  for (const part of ['"annotations"', '`red`', '`yellow`', 'only the JSON']) assert.ok(body.includes(part), part);
});
