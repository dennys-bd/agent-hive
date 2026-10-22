import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeDraft, DRAFT, resultIssues, zodIssues } from '../../src/benchmark/draft-schema.js';
import { arm, experiment, ISOLATION } from './fixtures.js';

const START = experiment(); // arms a1 (A) and a2 (B)
const issues = (input: unknown): string[] => {
  const parsed = DRAFT.safeParse(input);
  return parsed.success ? [] : zodIssues(parsed.error);
};

test('DRAFT answers every issue as path: message, one per issue (#478)', () => {
  const lines = issues({ workspace: 'bench', pace: { ...START.pace, pairs: 0 }, blindness: { on: 'yes', forbiddenWords: [] }, extra: 1 });
  assert.equal(lines.length, 3);
  assert.ok(lines.some((line) => line.startsWith('pace.pairs: ')));
  assert.ok(lines.some((line) => line.startsWith('blindness.on: ')));
  assert.ok(lines.some((line) => /^input: .*extra/.test(line)));
});

test('DRAFT refuses an id with from or workspace, a new draft with neither, and an arm id given twice (#478)', () => {
  assert.deepEqual(issues({ id: 'exp-1', from: 'exp-2' }), ['id: a replace takes neither from nor workspace']);
  assert.deepEqual(issues({ name: 'x' }), ['workspace: a new draft needs from or workspace']);
  assert.deepEqual(issues({ workspace: 'bench', arms: [{ id: 'a1', name: 'A', overrides: {} }, { id: 'a1', name: 'B', overrides: {} }] }), ['arms: an arm id appears twice']);
  assert.deepEqual(issues({ workspace: 'bench', name: 'Fine' }), []);
});

test('composeDraft replaces the arm list in order: a known id keeps its arm id, none draws one, letters again from A (#478)', () => {
  const made = composeDraft(START, { arms: [{ id: 'a2', name: 'Kept', overrides: { plugins: ['p'] } }, { name: 'New', overrides: {} }] }, () => 'xnew00001');
  assert.ok(!Array.isArray(made));
  assert.deepEqual(made.arms, [{ id: 'a2', letter: 'A', name: 'Kept', overrides: { plugins: ['p'] } }, { id: 'xnew00001', letter: 'B', name: 'New', overrides: {} }]);
});

test("composeDraft refuses an arm id the start lacks; the given sections replace the start's and the rest stays (#478)", () => {
  assert.deepEqual(composeDraft(START, { arms: [{ id: 'zz', name: 'A', overrides: {} }] }, () => 'x'), ['arms.0.id: no arm zz in the experiment']);
  const made = composeDraft(START, { name: 'Renamed', pace: { ...START.pace, pairs: 5 } }, () => 'x');
  assert.ok(!Array.isArray(made));
  assert.deepEqual([made.name, made.pace.pairs, made.arms, made.seed, made.createdBy, made.id], ['Renamed', 5, START.arms, START.seed, START.createdBy, START.id]);
});

test('resultIssues names a perArm key that names no arm and a seed of another workspace; a valid experiment has none (#478)', () => {
  const bad = { ...START, arms: [arm('a1', 'A')], isolation: { ...ISOLATION, network: { all: [], perArm: { a2: ['x.test'] } } }, seed: { ...START.seed, workspace: 'other' } };
  assert.deepEqual(resultIssues(bad), ['isolation.network.perArm: a2 is no arm of the draft', 'seed.workspace: an experiment keeps the workspace it was created in']);
  assert.deepEqual(resultIssues(START), []);
});
