import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import type { Flow, SettingsInfo } from '../src/types.js';
import { t } from '../src/ui/i18n.js';
import { draftFrom, emptyStage, toSettingsBody, validateSettings } from '../src/ui/lib/settings-form.js';
import { enteringFlow, enteringStage, scopedFlow, withFlowEdit, withNewFlow, withoutFlow } from '../src/ui/lib/settings-flows.js';
import { withoutStage } from '../src/ui/lib/settings-transitions.js';
import { combConfig } from './fakes.js';

// Two flows, as #564 saves them: the draft's flat lists in flow order, each stage tagged with its flow (#565)
const FLOWS: Flow[] = [
  { name: 'feature', stages: [{ name: 'spec', from: {} }, { name: 'build', from: {} }], transitions: [{ from: 'spec', to: 'build', when: 'done' }, { from: 'build', to: 'end', when: 'done' }] },
  { name: 'bug', stages: [{ name: 'triage', from: {} }], transitions: [{ from: 'triage', to: 'end', when: 'done' }] },
];
const info = (flows: Flow[]): SettingsInfo => ({ configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }], config: parseConfig(combConfig({ flows })) });

test('draftFrom drafts one flow per saved flow and tags each stage with its flow; an empty config gets one main flow (#565)', () => {
  const draft = draftFrom(info(FLOWS));
  assert.deepEqual(draft.flows.map((f) => f.name), ['feature', 'bug']);
  assert.deepEqual(draft.stages.map((s) => [s.name, draft.flows.findIndex((f) => f.id === s.flow)]), [['spec', 0], ['build', 0], ['triage', 1]]);
  assert.deepEqual(draft.transitions.map((d) => draft.stages.find((s) => s.id === d.from)?.flow), [draft.flows[0].id, draft.flows[0].id, draft.flows[1].id]);
  const blank = draftFrom(undefined);
  assert.deepEqual([blank.flows.map((f) => f.name), blank.stages], [['main'], []]);
});

test('scopedFlow is one flow\'s stages and transitions; withFlowEdit replaces only those, keeping the flat lists in flow order (#565)', () => {
  const draft = draftFrom(info(FLOWS));
  const bug = draft.flows[1].id;
  const scope = scopedFlow(draft, bug);
  assert.deepEqual([scope.stages.map((s) => s.name), scope.transitions.length], [['triage'], 1]);
  const next = withFlowEdit(draft, bug, { stages: [...scope.stages, { ...emptyStage(bug), name: 'verify' }], transitions: [] });
  assert.deepEqual(next.stages.map((s) => s.name), ['spec', 'build', 'triage', 'verify']);
  assert.deepEqual(next.transitions, draft.transitions.slice(0, 2), 'feature\'s arrows stay, bug\'s one was removed');
  assert.deepEqual(withFlowEdit(draft, bug, scope), { stages: draft.stages, transitions: draft.transitions }, 'an edit that changes nothing keeps the lists as they were');
});

test('withNewFlow adds a trimmed flow with one empty stage and no transition; withoutFlow drops a flow with its stages and transitions (#565)', () => {
  const draft = draftFrom(info(FLOWS));
  const { id, patch } = withNewFlow(draft, ' hotfix ', 'claude');
  assert.deepEqual(patch.flows.at(-1), { id, name: 'hotfix' });
  assert.deepEqual(patch.stages.filter((s) => s.flow === id).map((s) => s.name), ['']);
  const gone = withoutFlow(draft, draft.flows[1].id);
  assert.deepEqual([gone.flows.map((f) => f.name), gone.stages.map((s) => s.name), gone.transitions.length], [['feature'], ['spec', 'build'], 2]);
});

test('validateSettings refuses a blank or duplicate flow name, a flow with no stage and a stage name another flow holds, before the stages (#565)', () => {
  const draft = draftFrom(info(FLOWS));
  const [feature, bug] = draft.flows;
  assert.equal(validateSettings(draft), undefined);
  assert.deepEqual(validateSettings({ ...draft, flows: [feature, { ...bug, name: ' ' }] }), { section: 'flow', message: t('settings.flows.error.name') });
  assert.deepEqual(validateSettings({ ...draft, flows: [feature, { ...bug, name: 'feature ' }] }), { section: 'flow', message: t('settings.flows.error.duplicate', { name: 'feature' }) });
  const emptied = { ...draft, stages: draft.stages.filter((s) => s.flow !== bug.id), transitions: draft.transitions.slice(0, 2) };
  assert.deepEqual(validateSettings(emptied), { section: 'flow', message: t('settings.flows.error.empty', { flow: 'bug' }) });
  const clash = draft.stages.map((s) => (s.name === 'triage' ? { ...s, name: ' spec' } : s));
  assert.deepEqual(validateSettings({ ...draft, stages: clash }), { section: 'flow', message: t('settings.stages.error.otherFlow', { flow: 'feature' }), stage: draft.stages[2].id });
});

test('an untouched form sends every flow back as saved, each transition under its from stage\'s flow, and no flat pair (#565)', () => {
  const body = toSettingsBody(draftFrom(info(FLOWS)));
  assert.deepEqual(body.flows, FLOWS);
  assert.equal('stages' in body || 'transitions' in body, false);
});

// #691: feature's build leaves for bug's fix
const CROSSED: Flow[] = [
  { name: 'feature', stages: FLOWS[0].stages, transitions: [FLOWS[0].transitions[0], { from: 'build', to: 'fix', when: 'done' }] },
  { name: 'bug', stages: [{ name: 'triage', from: {} }, { name: 'fix', from: {} }], transitions: [{ from: 'triage', to: 'fix', when: 'done' }, { from: 'fix', to: 'end', when: 'done' }] },
];

test('a transition into another flow round-trips the form; an edit of its own flow keeps it, and a rename of its target is followed (#691)', () => {
  const draft = draftFrom(info(CROSSED));
  const [feature, bug] = draft.flows;
  assert.deepEqual(toSettingsBody(draft).flows, CROSSED);
  assert.deepEqual(toSettingsBody({ ...draft, ...withFlowEdit(draft, feature.id, scopedFlow(draft, feature.id)) }).flows, CROSSED, 'feature\'s edit keeps its arrow into bug');
  const scope = scopedFlow(draft, bug.id);
  const renamed = withFlowEdit(draft, bug.id, { ...scope, stages: scope.stages.map((s) => (s.name === 'fix' ? { ...s, name: 'repair' } : s)) });
  assert.deepEqual(toSettingsBody({ ...draft, ...renamed }).flows?.[0]?.transitions[1], { from: 'build', to: 'repair', when: 'done' });
});

test('a stage removed from one flow turns another flow\'s continueOf of it back into the destination\'s session (#691)', () => {
  const resumed: Flow[] = [{ ...CROSSED[0], transitions: [CROSSED[0].transitions[0], { from: 'build', to: 'fix', when: 'done', session: { continueOf: 'triage' } }] }, CROSSED[1]];
  const draft = draftFrom(info(resumed));
  const bug = draft.flows[1].id;
  const triage = draft.stages.find((s) => s.name === 'triage')?.id ?? '';
  const scope = scopedFlow(draft, bug);
  const next = withFlowEdit(draft, bug, { stages: scope.stages.filter((s) => s.id !== triage), transitions: withoutStage(scope.transitions, triage) });
  assert.deepEqual(toSettingsBody({ ...draft, ...next }).flows?.[0]?.transitions[1], { from: 'build', to: 'fix', when: 'done' });
});

test('enteringStage and enteringFlow are the other flows\' transitions into a stage or a flow; a flow\'s own arrows and its exits to end are not (#691)', () => {
  const draft = draftFrom(info(CROSSED));
  const [feature, bug] = draft.flows;
  const fix = draft.stages.find((s) => s.name === 'fix')?.id ?? '';
  const cross = draft.transitions[1];
  assert.deepEqual([enteringStage(draft, fix), enteringFlow(draft, bug.id), enteringFlow(draft, feature.id)], [[cross], [cross], []]);
});
