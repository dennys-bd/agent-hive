import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_AGENTS } from '../src/agents.js';
import { offeredAgents } from '../src/ui/lib/agent-settings.js';
import { agentEnabledDraft, agentModelsDraft, agentModelsFrom, agentsProblem, trustHintFolders } from '../src/ui/lib/settings-agents.js';
import { draftFrom, toSettingsBody } from '../src/ui/lib/settings-form.js';
import { emptyRow, emptyStage } from '../src/ui/lib/settings-stages.js';
import { setLanguage, t } from '../src/ui/i18n.js';
const FLOW = 'f';

setLanguage('en');
const ON = { claude: true, codex: true, copilot: true };
const draft = (extra = {}) => ({ agentModels: { claude: '', codex: '', copilot: '' }, agentEnabled: ON, stages: [{ ...emptyStage(FLOW), prompt: '/x' }], ...extra });

test('the draft holds each agent\'s model as typed and its switch; the payload sends a blank as null, trimmed (#482)', () => {
  assert.deepEqual(agentModelsDraft({ claude: 'opus', codex: null }), { claude: 'opus', codex: '', copilot: '' });
  assert.deepEqual(agentModelsDraft(undefined), { claude: '', codex: '', copilot: '' });
  assert.deepEqual(agentModelsFrom({ claude: ' opus ', codex: '  ', copilot: '' }), { claude: 'opus', codex: null, copilot: null });
  assert.deepEqual(agentEnabledDraft(undefined), { ...ON, copilot: false });
  assert.deepEqual(agentEnabledDraft({ claude: true, codex: false }), { claude: true, codex: false, copilot: false });
  const body = toSettingsBody({ ...draftFrom(undefined), agentModels: { claude: 'opus', codex: '', copilot: '' }, agentEnabled: { claude: true, codex: false, copilot: false } });
  assert.deepEqual([body.agentModels, body.agentEnabled], [{ claude: 'opus', codex: null, copilot: null }, { claude: true, codex: false, copilot: false }]);
});

test('agentsProblem names a bad model and a Claude model on codex in execution, and a stage or an evaluation row of a disabled agent in flow, on that stage (#482)', () => {
  assert.equal(agentsProblem(draft()), undefined);
  assert.deepEqual(agentsProblem(draft({ agentModels: { claude: '-x', codex: '', copilot: '' } })), { section: 'execution', message: t('settings.agents.error.model', { agent: 'claude' }) });
  assert.deepEqual(agentsProblem(draft({ agentModels: { claude: '', codex: 'opus', copilot: '' } })), { section: 'execution', message: t('settings.agents.error.claudeModel', { agent: 'codex', model: 'opus' }) });
  const off = { claude: true, codex: false, copilot: true };
  const codexStage = { ...emptyStage(FLOW), prompt: '/x', agent: 'codex' as const };
  assert.deepEqual(agentsProblem(draft({ agentEnabled: off, stages: [draft().stages[0], codexStage] })), { section: 'flow', stage: codexStage.id, message: t('settings.agents.error.stage', { n: 2, agent: 'codex' }) });
  const judged = { ...emptyStage(FLOW), action: 'evaluate' as const, judge: emptyRow('codex') };
  assert.equal(agentsProblem(draft({ agentEnabled: off, stages: [judged] }))?.stage, judged.id);
  assert.equal(agentsProblem(draft({ agentEnabled: off, stages: [{ ...emptyStage(FLOW), approval: true, agent: 'codex' as const }] })), undefined, 'a gate runs no agent: its leftover agent is not sent');
});

test('offeredAgents drops the agents the config disables and keeps boot\'s availability; no config offers every agent (#482)', () => {
  const found = [{ agent: 'claude' as const, available: true }, { agent: 'codex' as const, available: false }];
  assert.deepEqual(offeredAgents(found, { claude: true, codex: false }), [found[0]]);
  assert.deepEqual(offeredAgents(found, undefined), found);
});

test('agentsProblem flags a bare Claude alias on copilot, and takes a claude- id (#873)', () => {
  setLanguage('en');
  assert.deepEqual(agentsProblem(draft({ agentModels: { claude: '', codex: '', copilot: 'opus' } })), { section: 'execution', message: t('settings.agents.error.claudeModel', { agent: 'copilot', model: 'opus' }) });
  assert.equal(agentsProblem(draft({ agentModels: { claude: '', codex: '', copilot: 'claude-sonnet-5.5' } })), undefined);
});

test('a first setup drafts every agent on but copilot; a saved value wins (#873)', () => {
  assert.deepEqual(agentEnabledDraft(), { claude: true, codex: true, copilot: false });
  assert.deepEqual(agentEnabledDraft({ copilot: true }), { claude: true, codex: true, copilot: true });
});

test('the Copilot trust hint names the uncovered folders only while Copilot is installed and enabled in the draft (#880)', () => {
  const uncovered = ['/a/repo', '/a/other'];
  assert.deepEqual(trustHintFolders({ agentEnabled: ON }, ALL_AGENTS, uncovered), uncovered);
  assert.deepEqual(trustHintFolders({ agentEnabled: { ...ON, copilot: false } }, ALL_AGENTS, uncovered), [], 'a disabled Copilot runs no worker');
  assert.deepEqual(trustHintFolders({ agentEnabled: ON }, [{ agent: 'claude', available: true }, { agent: 'copilot', available: false }], uncovered), [], 'not installed');
  assert.deepEqual(trustHintFolders({ agentEnabled: ON }, ALL_AGENTS, []), []);
});
