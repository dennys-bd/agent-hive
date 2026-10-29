import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offeredAgents } from '../src/ui/lib/agent-settings.js';
import { agentEnabledDraft, agentModelsDraft, agentModelsFrom, agentsProblem } from '../src/ui/lib/settings-agents.js';
import { draftFrom, toSettingsBody } from '../src/ui/lib/settings-form.js';
import { emptyRow, emptyStage } from '../src/ui/lib/settings-stages.js';
import { setLanguage, t } from '../src/ui/i18n.js';

setLanguage('en');
const ON = { claude: true, codex: true };
const draft = (extra = {}) => ({ agentModels: { claude: '', codex: '' }, agentEnabled: ON, stages: [{ ...emptyStage(), prompt: '/x' }], ...extra });

test('the draft holds each agent\'s model as typed and its switch; the payload sends a blank as null, trimmed (#482)', () => {
  assert.deepEqual(agentModelsDraft({ claude: 'opus', codex: null }), { claude: 'opus', codex: '' });
  assert.deepEqual(agentModelsDraft(undefined), { claude: '', codex: '' });
  assert.deepEqual(agentModelsFrom({ claude: ' opus ', codex: '  ' }), { claude: 'opus', codex: null });
  assert.deepEqual(agentEnabledDraft(undefined), ON);
  assert.deepEqual(agentEnabledDraft({ claude: true, codex: false }), { claude: true, codex: false });
  const body = toSettingsBody({ ...draftFrom(undefined), agentModels: { claude: 'opus', codex: '' }, agentEnabled: { claude: true, codex: false } });
  assert.deepEqual([body.agentModels, body.agentEnabled], [{ claude: 'opus', codex: null }, { claude: true, codex: false }]);
});

test('agentsProblem names a bad model and a Claude model on codex in execution, and a stage or an evaluation row of a disabled agent in flow, on that stage (#482)', () => {
  assert.equal(agentsProblem(draft()), undefined);
  assert.deepEqual(agentsProblem(draft({ agentModels: { claude: '-x', codex: '' } })), { section: 'execution', message: t('settings.agents.error.model', { agent: 'claude' }) });
  assert.deepEqual(agentsProblem(draft({ agentModels: { claude: '', codex: 'opus' } })), { section: 'execution', message: t('settings.agents.error.claudeModel', { agent: 'codex', model: 'opus' }) });
  const off = { claude: true, codex: false };
  const codexStage = { ...emptyStage(), prompt: '/x', agent: 'codex' as const };
  assert.deepEqual(agentsProblem(draft({ agentEnabled: off, stages: [draft().stages[0], codexStage] })), { section: 'flow', stage: codexStage.id, message: t('settings.agents.error.stage', { n: 2, agent: 'codex' }) });
  const judged = { ...emptyStage(), action: 'evaluate' as const, judge: emptyRow('codex') };
  assert.equal(agentsProblem(draft({ agentEnabled: off, stages: [judged] }))?.stage, judged.id);
  assert.equal(agentsProblem(draft({ agentEnabled: off, stages: [{ ...emptyStage(), approval: true, agent: 'codex' as const }] })), undefined, 'a gate runs no agent: its leftover agent is not sent');
});

test('offeredAgents drops the agents the config disables and keeps boot\'s availability; no config offers every agent (#482)', () => {
  const found = [{ agent: 'claude' as const, available: true }, { agent: 'codex' as const, available: false }];
  assert.deepEqual(offeredAgents(found, { claude: true, codex: false }), [found[0]]);
  assert.deepEqual(offeredAgents(found, undefined), found);
});
