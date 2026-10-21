import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutPatch, JUDGE_SCHEMA, judgePrompt, PATCH_MAX, parseFindings, parseScores, REVIEW_SCHEMA, reviewerPrompt, type Work } from '../src/evaluate-prompt.js';

const WORK: Work = { id: 'HIVE-1', title: 'Add login', body: 'The body', base: 'abc1234 (origin/main)', stat: ' a.ts | 2 +-', patch: 'diff --git a/a.ts b/a.ts' };

test('the patch is cut at 60 000 characters with a line saying so (#877)', () => {
  assert.equal(cutPatch('x'.repeat(10)), 'x'.repeat(10));
  const cut = cutPatch('x'.repeat(PATCH_MAX + 5));
  assert.ok(cut.startsWith('x'.repeat(PATCH_MAX)));
  assert.match(cut, /\n\[patch cut at 60000 characters: read the files for the rest\]$/);
});

test('a reviewer is told its focus, the task, the stat and the patch, then its specialized agent\'s instructions first; the judge reads the numbered dimensions and every finding (#877)', () => {
  const reviewer = reviewerPrompt(WORK, 'security and data', 'You are the security reviewer.');
  assert.ok(reviewer.startsWith('You are the security reviewer.'));
  for (const part of ['security and data', 'HIVE-1: Add login', 'The body', 'abc1234 (origin/main)', ' a.ts | 2 +-', 'diff --git a/a.ts b/a.ts']) assert.ok(reviewer.includes(part), part);
  const judge = judgePrompt(WORK, ['Meets the spec?', 'Tests cover it?'], [{ who: 'reviewer 1 (claude) · security', findings: [{ file: 'a.ts', line: 3, finding: 'no check' }] }]);
  assert.match(judge, /1\. Meets the spec\?\n2\. Tests cover it\?/);
  assert.match(judge, /reviewer 1 \(claude\) · security\n- a\.ts:3 no check/);
  assert.match(judgePrompt(WORK, ['a'], []), /No reviewer ran/);
});

test('the schemas list every property as required with no extra one, as strict structured output needs; a finding\'s line may be null (#877)', () => {
  const item = (schema: object, key: string) => ((schema as { properties: Record<string, { items: { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> } }> }).properties[key]?.items);
  assert.deepEqual(item(REVIEW_SCHEMA, 'findings')?.required, ['file', 'line', 'finding']);
  assert.deepEqual(item(REVIEW_SCHEMA, 'findings')?.properties.line, { type: ['integer', 'null'] });
  assert.deepEqual(item(JUDGE_SCHEMA, 'scores')?.required, ['dimension', 'score', 'evidence']);
  assert.equal(JSON.stringify(JUDGE_SCHEMA).includes('minimum'), false);
});

test('parseFindings reads null as no line and refuses what the schema would; parseScores needs one 0..10 integer per dimension and names them from the rubric (#877)', () => {
  assert.deepEqual(parseFindings('{"findings":[{"file":"a.ts","line":null,"finding":"x"},{"file":"b.ts","line":4,"finding":"y"}]}'), { findings: [{ file: 'a.ts', finding: 'x' }, { file: 'b.ts', line: 4, finding: 'y' }] });
  assert.ok('reason' in parseFindings('{"findings":[{"file":"","line":null,"finding":"x"}]}'));
  assert.ok('reason' in parseFindings('not json'));
  const dims = ['Meets the spec?', 'Tests cover it?'];
  assert.deepEqual(parseScores('{"scores":[{"dimension":"spec","score":8,"evidence":"e1"},{"dimension":"tests","score":0,"evidence":"e2"}]}', dims),
    { scores: [{ dimension: 'Meets the spec?', score: 8, evidence: 'e1' }, { dimension: 'Tests cover it?', score: 0, evidence: 'e2' }] });
  assert.deepEqual(parseScores('{"scores":[{"dimension":"a","score":8,"evidence":"e"}]}', dims), { reason: '1 scores for 2 dimensions' });
  assert.ok('reason' in parseScores('{"scores":[{"dimension":"a","score":11,"evidence":"e"},{"dimension":"b","score":1,"evidence":"e"}]}', dims));
  assert.ok('reason' in parseScores('{"scores":[{"dimension":"a","score":7.5,"evidence":"e"},{"dimension":"b","score":1,"evidence":"e"}]}', dims));
});
