import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, judgeArgs, parseJudge, resultText, TESTER_MODEL, testerArgs } from '../../scripts/experiment/claude.js';
import { testerPrompt } from '../../scripts/experiment/prompts.js';
import { CRITERIA } from '../../scripts/experiment/types.js';
import { SEED } from './fixtures.js';

const SECRET = 'c'.repeat(64);
const flagOf = (args: string[]) => (name: string): string | undefined => args[args.indexOf(name) + 1];

test('testerArgs runs claude -p with only the Playwright MCP, no shell or file tools, Read, Glob and Grep denied, the secret in no argument (#105)', () => {
  const args = testerArgs(testerPrompt({ url: 'http://127.0.0.1:4321/', handoff: 'h', scenarios: SEED.scenarios, artboards: SEED.artboards }), '/run/tester/mcp.json');
  const flag = flagOf(args);
  assert.equal(args[0], '-p');
  assert.deepEqual([flag('--model'), flag('--output-format'), flag('--mcp-config')], [TESTER_MODEL, 'json', '/run/tester/mcp.json']);
  const allowed = flag('--allowedTools')?.split(' ') ?? [];
  for (const name of ['navigate', 'click', 'type', 'fill_form', 'press_key', 'hover', 'select_option', 'snapshot', 'take_screenshot', 'wait_for', 'navigate_back', 'resize']) assert.ok(allowed.includes(`mcp__playwright__browser_${name}`), name);
  for (const name of ['evaluate', 'run_code_unsafe', 'file_upload', 'cookie_get', 'storage_state', 'localstorage_get', 'network_requests']) assert.ok(!allowed.includes(`mcp__playwright__browser_${name}`), name);
  assert.ok(allowed.every((t) => t.startsWith('mcp__playwright__browser_')), 'no whole-server grant');
  assert.ok(args.includes('--strict-mcp-config'));
  for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep']) assert.ok(flag('--disallowedTools')?.split(' ').includes(tool), tool);
  assert.ok(!args.some((a) => a.includes(SECRET)));
  assert.equal(flag('--setting-sources'), 'project');
});

test('judgeArgs keeps its Read and Glob: only the tester loses them (#105)', () => {
  const denied = flagOf(judgeArgs('prompt', 'claude-fable-5-1'))('--disallowedTools')?.split(' ') ?? [];
  for (const tool of ['Read', 'Glob', 'Grep']) assert.ok(!denied.includes(tool), tool);
  for (const tool of ['Bash', 'Edit', 'Write']) assert.ok(denied.includes(tool), tool);
});

test('judgeArgs runs the judge model with Read scoped to its folder and Glob only and no MCP server (#105)', () => {
  const args = judgeArgs('prompt', 'claude-fable-5-1');
  const flag = flagOf(args);
  assert.deepEqual([args[0], flag('--model'), flag('--allowedTools')], ['-p', 'claude-fable-5-1', 'Read(./**) Glob']);
  assert.ok(args.includes('--strict-mcp-config') && !args.includes('--mcp-config'));
  assert.equal(flag('--setting-sources'), 'project');
});

test('resultText answers the claude -p json result and rejects an error; extractJson finds JSON in prose or a fence (#105)', () => {
  assert.equal(resultText(JSON.stringify({ type: 'result', is_error: false, result: 'done' })), 'done');
  assert.throws(() => resultText(JSON.stringify({ is_error: true, result: 'limit reached' })), /limit reached/);
  assert.deepEqual(extractJson('Here:\n```json\n[{"a": 1}]\n```\nThat is all.', '['), [{ a: 1 }]);
  assert.deepEqual(extractJson('{"x": {"y": 2}}', '{'), { x: { y: 2 } });
  assert.throws(() => extractJson('no json', '{'), /no JSON/);
});

test('parseJudge needs a 1 to 10 score per criterion, and nulls fidelity and behaviour when not booted (#105)', () => {
  const full = Object.fromEntries(CRITERIA.map((c, i) => [c, { score: i + 3, reason: c }]));
  assert.deepEqual(parseJudge(full, 'm', true).scores.code, { score: 5, reason: 'code' });
  const dead = parseJudge(full, 'm', false).scores;
  assert.deepEqual([dead.fidelity.score, dead.behaviour.score, dead.tests.score], [null, null, 7]);
  assert.throws(() => parseJudge({ ...full, tests: { score: 11 } }, 'm', true), /tests/);
  assert.throws(() => parseJudge({ ...full, code: { score: 2.5 } }, 'm', true), /code/);
  assert.throws(() => parseJudge([], 'm', true), /no object/);
});
