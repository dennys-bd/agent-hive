import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { headlessEnv, headlessPrompt } from '../../src/agents/copilot-headless.js';
import type { HeadlessRun } from '../../src/agents/runner.js';

const HEADLESS: HeadlessRun = { dir: '/t', schema: '{"type":"object"}', schemaPath: '/t/schema.json', answerPath: '/t/answer.txt' };

test('the prompt asks for one JSON object under the schema and ends with the schema: Copilot has no schema flag (#877, spike §4)', () => {
  assert.equal(headlessPrompt('Review the template.', HEADLESS.schema),
    'Review the template.\n\nAnswer with one JSON object that matches this JSON Schema, and nothing else: no prose, no code fence.\n\n{"type":"object"}');
});

test('every run gets a Copilot home of its own in the run\'s folder, no update check, COPILOT_ALLOW_ALL off whatever was inherited (#877)', () => {
  assert.deepEqual(headlessEnv(HEADLESS), { COPILOT_HOME: join('/t', 'copilot-home'), COPILOT_AUTO_UPDATE: 'false', COPILOT_ALLOW_ALL: '' });
});
