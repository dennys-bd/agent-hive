import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProposal, type AssistInput, assistPrompt, parseProposal, proposalHunk, targetOf } from '../src/assist.js';
import type { TemplateVariable } from '../src/template.js';

const ABCD = 'a\nb\nc\nd\n';

test('the target is the selection, or the whole file without one; a selection outside the text has none (#330)', () => {
  assert.deepEqual(targetOf(ABCD), { start: 1, end: 4 });
  assert.deepEqual(targetOf(ABCD, { startLine: 2, endLine: 3 }), { start: 2, end: 3 });
  assert.deepEqual(targetOf('a\nb'), { start: 1, end: 2 }, 'no final newline: the last line still counts once');
  assert.deepEqual(targetOf(''), { start: 1, end: 0 });
  for (const selection of [{ startLine: 0, endLine: 1 }, { startLine: 3, endLine: 2 }, { startLine: 4, endLine: 5 }]) {
    assert.equal(targetOf(ABCD, selection), undefined, JSON.stringify(selection));
  }
});

test('an answer inside the target is accepted; outside it, past to + 1, not JSON or the wrong shape, it is refused with a reason (#330)', () => {
  const target = { start: 2, end: 3 };
  const parse = (answer: unknown): ReturnType<typeof parseProposal> => parseProposal(typeof answer === 'string' ? answer : JSON.stringify(answer), target);
  assert.deepEqual(parse({ from: 2, to: 3, text: 'x' }), { proposal: { from: 2, to: 3, text: 'x' } });
  assert.deepEqual(parse({ from: 3, to: 2, text: 'x' }), { proposal: { from: 3, to: 2, text: 'x' } }, 'to = from - 1 inserts before from');
  assert.deepEqual(parse({ from: 4, to: 3, text: 'x' }), { proposal: { from: 4, to: 3, text: 'x' } }, 'right after the selection is still inside it');
  const reason = (answer: unknown): string => {
    const parsed = parse(answer);
    assert.ok('reason' in parsed, JSON.stringify(answer));
    return parsed.reason;
  };
  assert.match(reason({ from: 1, to: 3, text: 'x' }), /outside 2\.\.3/);
  assert.match(reason({ from: 2, to: 4, text: 'x' }), /outside 2\.\.3/);
  assert.match(reason({ from: 3, to: 1, text: 'x' }), /past/);
  assert.match(reason('Sure! {"from":2,"to":3,"text":"x"}'), /not JSON/);
  assert.match(reason({ from: '2', to: 3, text: 'x' }), /expected JSON: from/);
  assert.match(reason({ from: 2, to: 3 }), /expected JSON: text/);
});

test('a proposal replaces its range only; the hunk marks the replaced lines del, the new ones add, the shared edge lines context (#330)', () => {
  const proposal = { from: 1, to: 4, text: 'a\nB\nd' };
  assert.equal(applyProposal(ABCD, proposal), 'a\nB\nd\n');
  assert.deepEqual(proposalHunk(ABCD, proposal), {
    header: '@@ -1,4 +1,3 @@',
    lines: [
      { kind: 'context', text: 'a', old: 1, new: 1 },
      { kind: 'del', text: 'b', old: 2 },
      { kind: 'del', text: 'c', old: 3 },
      { kind: 'add', text: 'B', new: 2 },
      { kind: 'context', text: 'd', old: 4, new: 3 },
    ],
  });
  assert.equal(applyProposal(ABCD, { from: 2, to: 2, text: 'X' }), 'a\nX\nc\nd\n', 'the lines around the range are untouched');
});

test('an insertion, a deletion and an unchanged answer; the prompt carries the request, the numbered text, the range, the variables and the catalogue (#330)', () => {
  assert.equal(applyProposal('a\nb\n', { from: 2, to: 1, text: 'x' }), 'a\nx\nb\n');
  assert.deepEqual(proposalHunk('a\nb\n', { from: 2, to: 1, text: 'x' }), { header: '@@ -1,0 +2,1 @@', lines: [{ kind: 'add', text: 'x', new: 2 }] });
  assert.equal(applyProposal('a\nb\nc\n', { from: 2, to: 2, text: '' }), 'a\nc\n', 'an empty text deletes the range');
  assert.deepEqual(proposalHunk('a\nb\nc\n', { from: 2, to: 2, text: '' }), { header: '@@ -2,1 +1,0 @@', lines: [{ kind: 'del', text: 'b', old: 2 }] });
  const same = { from: 1, to: 2, text: 'a\nb' };
  assert.equal(applyProposal('a\nb\n', same), 'a\nb\n', 'unchanged: the route answers changed: false');
  assert.deepEqual(proposalHunk('a\nb\n', same).lines.map((l) => l.kind), ['context', 'context']);

  const lang: TemplateVariable = { name: 'lang', kind: 'list', values: ['ts', 'py'], default: 'ts', required: true, workspaces: { 'hive-site': 'py' }, line: 3 };
  const input: AssistInput = {
    request: 'make the title friendlier', path: 'SKILL.md', kind: 'skill', text: '---\nname: x\n---\n# x\n', target: { start: 4, end: 4 },
    variables: [lang], catalogue: [{ id: 'hive:architect', kind: 'specialist', name: 'architect', description: 'Designs' }],
  };
  const prompt = assistPrompt(input);
  for (const part of ['make the title friendlier', 'SKILL.md', '4| # x', 'lines 4..4', '"name": "lang"', '"hive-site": "py"', 'hive:architect', 'Designs', '"from"']) {
    assert.ok(prompt.includes(part), part);
  }
});
