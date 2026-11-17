import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_ALIAS, checkStageModels, foreignModel, parseAgentModels } from '../src/config-agent-args.js';
import { AGENT_IDS, type Stage } from '../src/types.js';

const stage = (extra: Partial<Stage>): Stage => ({ name: 'dev', from: {}, prompt: 'p', ...extra });
const noModels = () => Object.fromEntries(AGENT_IDS.map((id) => [id, null]));

test('foreignModel: codex refuses every Claude model, claude none; CLAUDE_ALIAS is the bare alias, with or without [1m] (#927, #873)', () => {
  assert.deepEqual(['opus', 'sonnet[1m]', 'claude-sonnet-5.5'].map((m) => foreignModel('codex', m)), [true, true, true]);
  assert.deepEqual(['gpt-5.6-terra', 'auto'].map((m) => foreignModel('codex', m)), [false, false]);
  assert.equal(foreignModel('claude', 'opus'), false);
  assert.deepEqual(['fable', 'opus', 'sonnet', 'haiku', 'opus[1m]'].map((m) => CLAUDE_ALIAS.test(m)), [true, true, true, true, true]);
  assert.deepEqual(['claude-sonnet-5.5', 'auto', 'opus-x'].map((m) => CLAUDE_ALIAS.test(m)), [false, false, false]);
});

test('the parser keeps codex\'s messages word for word through foreignModel (#927)', () => {
  assert.throws(() => parseAgentModels({ ...noModels(), codex: 'opus' }), { message: 'hive.config.json: "agentModels.codex" "opus" is a Claude model; codex needs a Codex model name' });
  assert.throws(() => checkStageModels([stage({ agent: 'codex', model: 'claude-sonnet-4' })], 'claude', 'comb'),
    { message: 'hive.config.json: "comb.stages[0].model" "claude-sonnet-4" is a Claude model; a codex stage needs a Codex model name' });
  checkStageModels([stage({ model: 'opus' })], 'claude', 'comb');
});

test('copilot refuses a bare Claude alias by field, as its default model and on its stage, its own or the default; a claude- id and auto pass (#873)', () => {
  for (const model of ['opus', 'sonnet', 'opus[1m]']) {
    assert.throws(() => parseAgentModels({ ...noModels(), copilot: model }), { message: `hive.config.json: "agentModels.copilot" "${model}" is another agent's model alias; copilot needs a Copilot model id` }, model);
    assert.throws(() => checkStageModels([stage({ agent: 'copilot', model })], 'claude', 'comb'),
      { message: `hive.config.json: "comb.stages[0].model" "${model}" is another agent's model alias; a copilot stage needs a Copilot model id` }, model);
  }
  assert.throws(() => checkStageModels([stage({ model: 'sonnet' })], 'copilot', 'comb'), /"comb\.stages\[0\]\.model" "sonnet" is another agent's model alias/, 'the default agent counts');
  for (const model of ['claude-sonnet-5.5', 'auto']) {
    assert.equal(parseAgentModels({ ...noModels(), copilot: model }).copilot, model);
    checkStageModels([stage({ agent: 'copilot', model })], 'claude', 'comb');
    assert.equal(foreignModel('copilot', model), false);
  }
  assert.equal(foreignModel('codex', 'claude-sonnet-5.5'), true, 'codex\'s rule unchanged');
});
