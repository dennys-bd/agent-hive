import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnnotations, reviewPrompt } from '../src/reviewer.js';
import type { TemplateVariable } from '../src/template.js';

const NOTE = { line: 2, severity: 'red', title: 'Two branches contradict', body: 'Both branches hold for ts.' } as const;
const answer = (annotations: unknown[]): string => JSON.stringify({ annotations });

test("an answer whose every line is in the text is accepted, each annotation marked as the agent's; an empty list is an answer; a fix is dropped (#328)", () => {
  assert.deepEqual(parseAnnotations(answer([NOTE, { ...NOTE, line: 3, severity: 'yellow' }]), 3), {
    annotations: [{ ...NOTE, source: 'agent' }, { ...NOTE, line: 3, severity: 'yellow', source: 'agent' }],
  });
  assert.deepEqual(parseAnnotations(answer([]), 0), { annotations: [] }, 'nothing wrong, even in an empty file');
  assert.deepEqual(parseAnnotations(answer([{ ...NOTE, fix: 'rewrite it' }]), 3), { annotations: [{ ...NOTE, source: 'agent' }] }, 'fix is #330\'s');
});

test('not JSON, a missing field, a severity outside yellow and red, a line 0 or past the last line refuse the whole answer with a reason (#328)', () => {
  const reason = (raw: unknown): string => {
    const parsed = parseAnnotations(typeof raw === 'string' ? raw : JSON.stringify(raw), 3);
    assert.ok('reason' in parsed, JSON.stringify(raw));
    return parsed.reason;
  };
  assert.match(reason('Sure! {"annotations": []}'), /^not JSON$/);
  assert.match(reason({ notes: [] }), /^not the expected JSON: annotations:/);
  assert.match(reason({ annotations: [{ ...NOTE, title: undefined }] }), /^not the expected JSON: annotations\.0\.title:/);
  assert.match(reason({ annotations: [{ ...NOTE, severity: 'green' }] }), /^not the expected JSON: annotations\.0\.severity:/);
  assert.match(reason({ annotations: [{ ...NOTE, line: 1.5 }] }), /^not the expected JSON: annotations\.0\.line:/);
  assert.equal(reason({ annotations: [NOTE, { ...NOTE, line: 0 }] }), 'line 0 is outside 1..3', 'one bad line refuses the good ones too');
  assert.equal(reason({ annotations: [{ ...NOTE, line: 4 }] }), 'line 4 is outside 1..3');
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
