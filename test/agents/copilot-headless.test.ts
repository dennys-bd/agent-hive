import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { headless, headlessAnswer, headlessEnv, headlessPrompt } from '../../src/agents/copilot-headless.js';
import type { HeadlessRun } from '../../src/agents/runner.js';

const HEADLESS: HeadlessRun = { dir: '/t', schema: '{"type":"object"}', schemaPath: '/t/schema.json', answerPath: '/t/answer.txt' };

test('the prompt asks for one JSON object under the schema and ends with the schema: Copilot has no schema flag (#877, spike §4)', () => {
  assert.equal(headlessPrompt('Review the template.', HEADLESS.schema),
    'Review the template.\n\nAnswer with one JSON object that matches this JSON Schema, and nothing else: no prose, no code fence.\n\n{"type":"object"}');
});

test('every run gets a Copilot home of its own in the run\'s folder, no update check, COPILOT_ALLOW_ALL off whatever was inherited (#877)', () => {
  assert.deepEqual(headlessEnv(HEADLESS), { COPILOT_HOME: join('/t', 'copilot-home'), COPILOT_AUTO_UPDATE: 'false', COPILOT_ALLOW_ALL: '' });
});

const BASE = ['-s', '--no-custom-instructions', '--disable-builtin-mcps', '--no-ask-user'];

test('a plain run: no instructions, no built-in MCP server, no question, one read tool; --model last when given; outsideRepo changes nothing (#877)', () => {
  assert.deepEqual(headless(HEADLESS), [...BASE, '--available-tools', 'view']);
  assert.deepEqual(headless({ ...HEADLESS, model: 'claude-sonnet-4.5' }), [...BASE, '--available-tools', 'view', '--model', 'claude-sonnet-4.5']);
  assert.deepEqual(headless({ ...HEADLESS, cwd: '/bundle', outsideRepo: true }), headless(HEADLESS));
});

test('a read-only run in a worktree reads with view, rg and glob; no argv word names the worktree, which is the process cwd (#877, probe F)', () => {
  assert.deepEqual(headless({ ...HEADLESS, cwd: '/w', readOnlyTools: true }), [...BASE, '--available-tools', 'view', 'rg', 'glob']);
});

test('a tester run offers only its MCP tools as <server>-<tool>, loads its file, allows each as <server>(<tool>); a name not mcp__<server>__<tool> is dropped (#877, spike §1)', () => {
  const run: HeadlessRun = { ...HEADLESS, cwd: '/r', mcpConfig: '/r/mcp.json', allowedTools: ['mcp__playwright__browser_click', 'Read', 'mcp__playwright__browser_navigate'], model: 'auto' };
  assert.deepEqual(headless(run), [
    ...BASE, '--available-tools', 'playwright-browser_click', 'playwright-browser_navigate',
    '--additional-mcp-config', '@/r/mcp.json', '--allow-tool=playwright(browser_click)', '--allow-tool=playwright(browser_navigate)', '--model', 'auto',
  ]);
  // never a bare --available-tools, which offers every tool (probe F): with no MCP tool left, the run's built-in read tool
  assert.deepEqual(headless({ ...HEADLESS, mcpConfig: '/r/mcp.json', allowedTools: ['Read'] }), [...BASE, '--available-tools', 'view', '--additional-mcp-config', '@/r/mcp.json']);
  assert.deepEqual(headless({ ...HEADLESS, allowedTools: ['mcp__playwright__browser_click'] }), headless(HEADLESS), 'no MCP file, no MCP tool');
});

test('headlessAnswer: stdout trimmed; one surrounding fence, ``` or ```json, stripped; a refused run\'s empty stdout and blank output are no answer (#877, probe E)', () => {
  const json = '{"annotations":[{"from":1,"to":2,"text":"x"}]}';
  assert.equal(headlessAnswer(`${json}\n`), json);
  assert.equal(headlessAnswer(`\`\`\`json\n${json}\n\`\`\`\n`), json);
  assert.equal(headlessAnswer(`\`\`\`\n${json}\n\`\`\``), json);
  assert.equal(headlessAnswer(''), undefined); // probe E: exit 1 and an empty stdout (runCapped fails the run on the exit first)
  assert.equal(headlessAnswer(' \n\n'), undefined);
  assert.equal(headlessAnswer('```json\n\n```'), undefined);
});
