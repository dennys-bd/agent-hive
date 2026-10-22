import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCollectors } from '../../src/benchmark/collectors.js';
import { REVIEW_SCHEMA, type Work } from '../../src/evaluate-prompt.js';
import type { HeadlessInput, HeadlessResult } from '../../src/headless-run.js';
import { EVALUATE_TIMEOUT_MS } from '../../src/server-evaluate.js';
import type { EvaluateRow } from '../../src/types.js';
import { tempDir } from '../temp-dir.js';

const WORK: Work = { id: 'tok1a', title: 'The tasks of the run', body: 'One\n\nb', base: 'the baseline', stat: ' 1 file changed', patch: '+x' };
const never = new AbortController().signal;

async function plugin(t: Parameters<typeof tempDir>[0]): Promise<string> {
  const dir = await tempDir(t, 'plugin-');
  await mkdir(join(dir, 'agents'));
  await writeFile(join(dir, 'agents', 'code-reviewer.md'), '---\nname: code-reviewer\ndescription: Reviews.\n---\nYou are the reviewer.\n');
  return dir;
}

test("every collector runs at once, read-only in the worktree, with its focus and its specialized agent's body from the pinned plugin; ok without findings, warn with them (#474)", async (t) => {
  const inputs: HeadlessInput[] = [];
  const headless = async (input: HeadlessInput): Promise<HeadlessResult> => {
    inputs.push(input);
    return { answer: input.prompt.startsWith('You are the reviewer.') ? '{"findings":[{"file":"a.ts","line":3,"finding":"no check"}]}' : '{"findings":[]}' };
  };
  const rows: EvaluateRow[] = [{ agent: 'claude', focus: 'security' }, { agent: 'claude', model: 'opus', specializedAgent: 'hive:code-reviewer', focus: 'quality' }];
  assert.deepEqual(await runCollectors(rows, WORK, '/eval/worktree', await plugin(t), { headless, signal: never, log: () => undefined }), [
    { name: 'claude · security', status: 'ok', summary: '0 findings', findings: [] },
    { name: 'hive:code-reviewer · quality', status: 'warn', summary: '1 findings', findings: [{ file: 'a.ts', line: 3, finding: 'no check' }] },
  ]);
  for (const input of inputs) assert.deepEqual([input.cwd, input.readOnlyTools, input.schema, input.timeoutMs, input.mcpConfig], ['/eval/worktree', true, REVIEW_SCHEMA, EVALUATE_TIMEOUT_MS, undefined]);
  assert.equal(inputs[1]?.model, 'opus');
  assert.match(inputs[0]?.prompt ?? '', /Your focus: security/);
});

test('a collector that fails, answers bad JSON or names an agent the plugin lacks is error with the reason; the others go on; the log names only the step (#474)', async (t) => {
  const lines: string[] = [];
  const headless = async (input: HeadlessInput): Promise<HeadlessResult> => {
    if (input.prompt.includes('Your focus: a')) return { failure: 'timed out after 1200000 ms', detail: 'the whole prompt' };
    if (input.prompt.includes('Your focus: b')) return { answer: 'not json' };
    return { answer: '{"findings":[]}' };
  };
  const rows: EvaluateRow[] = [{ agent: 'claude', focus: 'a' }, { agent: 'claude', focus: 'b' }, { agent: 'claude', specializedAgent: 'hive:ghost', focus: 'c' }, { agent: 'claude', focus: 'd' }];
  const results = await runCollectors(rows, WORK, '/w', await plugin(t), { headless, signal: never, log: (line) => lines.push(line) });
  assert.deepEqual(results.map((r) => r.status), ['error', 'error', 'error', 'ok']);
  assert.equal(results[0]?.summary, 'timed out after 1200000 ms');
  assert.equal(results[2]?.summary, "hive:ghost is not an agent of the experiment's plugin");
  assert.deepEqual(lines, ['collector 1: error', 'collector 2: error', 'collector 3: error', 'collector 4: ok']);
});
