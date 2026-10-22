import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { judgeBundle, rubricHash } from '../../src/benchmark/judge.js';
import { JUDGE_SCHEMA, type Work } from '../../src/evaluate-prompt.js';
import type { HeadlessInput, HeadlessResult } from '../../src/headless-run.js';
import { tempDir } from '../temp-dir.js';

const WORK: Work = { id: 'run', title: 'The tasks of the run', body: 'One', base: 'the baseline', stat: ' 1 file changed', patch: '+x' };
const FILES = [{ name: 'diff.patch', text: '+x\n' }, { name: 'metrics.json', text: 'null\n' }];
const scores = (...values: number[]): HeadlessResult => ({ answer: JSON.stringify({ scores: values.map((score, i) => ({ dimension: `d${i}`, score, evidence: `e${i}` })) }) });

async function setup(t: Parameters<typeof tempDir>[0]) {
  const dir = await tempDir(t, 'judge-');
  const tmpRoot = join(dir, 'tmp');
  await mkdir(tmpRoot);
  return { dir, tmpRoot, keepAt: join(dir, 'eval', 'bundle') };
}

test('the judge reads only the bundle in a temp folder, read-only, against the rubric 1..5; the bundle is kept and the temp folder removed (#474)', async (t) => {
  const { tmpRoot, keepAt, dir } = await setup(t);
  let seen: HeadlessInput | undefined;
  let listed: string[] = [];
  const headless = async (input: HeadlessInput): Promise<HeadlessResult> => { seen = input; listed = (await readdir(input.cwd ?? '')).sort(); return scores(4, 2); };
  const result = await judgeBundle({ row: { agent: 'claude', model: 'opus' }, pluginDir: join(dir, 'plugin'), rubric: 'Correct?\n\n  Tested?  \n', files: FILES, work: WORK, findings: [] }, keepAt, { headless, signal: new AbortController().signal, tmpRoot });
  assert.deepEqual(result, { scores: [{ dimension: 'Correct?', score: 4, evidence: 'e0' }, { dimension: 'Tested?', score: 2, evidence: 'e1' }] });
  assert.deepEqual(listed, ['diff.patch', 'metrics.json']);
  assert.deepEqual([seen?.readOnlyTools, seen?.schema, seen?.model, seen?.mcpConfig], [true, JUDGE_SCHEMA, 'opus', undefined]);
  assert.ok(seen?.cwd?.startsWith(tmpRoot));
  assert.match(seen?.prompt ?? '', /1\. Correct\?\n2\. Tested\?/);
  assert.match(seen?.prompt ?? '', /an integer from 1 to 5/);
  assert.match(seen?.prompt ?? '', /blind bundle, not a repository/);
  assert.deepEqual((await readdir(keepAt)).sort(), ['diff.patch', 'metrics.json']);
  assert.deepEqual(await readdir(tmpRoot), []);
});

test('a score outside 1..5, a wrong count or a failed run answers the reason; an empty rubric runs no judge (#474)', async (t) => {
  const { tmpRoot, keepAt, dir } = await setup(t);
  const input = { row: { agent: 'claude' as const }, pluginDir: join(dir, 'plugin'), rubric: 'A\nB', files: FILES, work: WORK, findings: [] };
  const deps = (result: HeadlessResult) => ({ headless: async () => result, signal: new AbortController().signal, tmpRoot });
  assert.ok('reason' in await judgeBundle(input, keepAt, deps(scores(0, 3))));
  assert.ok('reason' in await judgeBundle(input, keepAt, deps(scores(3, 6))));
  assert.deepEqual(await judgeBundle(input, keepAt, deps(scores(3))), { reason: '1 scores for 2 dimensions' });
  assert.deepEqual(await judgeBundle(input, keepAt, deps({ failure: 'timed out after 1200000 ms', detail: '' })), { reason: 'timed out after 1200000 ms' });
  let ran = false;
  assert.deepEqual(await judgeBundle({ ...input, rubric: ' \n' }, keepAt, { headless: async () => { ran = true; return scores(); }, signal: new AbortController().signal, tmpRoot }), { scores: [] });
  assert.equal(ran, false);
  assert.deepEqual(await readdir(tmpRoot), []);
});

test("rubricHash is the first 12 hex characters of the rubric's sha256 (#474)", () => {
  assert.equal(rubricHash('Correct?'), createHash('sha256').update('Correct?').digest('hex').slice(0, 12));
  assert.match(rubricHash(''), /^[0-9a-f]{12}$/);
});
