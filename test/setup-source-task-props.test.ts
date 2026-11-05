import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/ui/i18n.js';
import { emptyStage, type FlowDraft } from '../src/ui/lib/settings-form.js';
import type { StageDraft } from '../src/ui/lib/settings-stages.js';
import {
  emptyTaskProps, entryDraft, entryFrom, entryGone, entryLabel, newTaskRule, propDefault, propMode, sourceTaskPropsProblem, type SourceTaskPropsDraft, taskPropsDraft, taskPropsFrom, type TaskRuleDraft, withoutProp, withProp,
} from '../src/ui/lib/setup-source-task-props.js';
import type { SourceTaskProps } from '../src/types.js';

const stage = (id: string, name: string, flow: string): StageDraft => ({ ...emptyStage(flow, 'claude'), id, name });
const SCOPE = { flows: [{ id: 'd', name: 'delivery' }, { id: 'x', name: 'discovery' }] as FlowDraft[], stages: [stage('s1', 'Spec', 'd'), stage('s2', 'Build', 'd'), stage('s3', 'Research', 'x')] };

const SAVED: SourceTaskProps = {
  defaults: { auto: true, entry: { flow: 'delivery' } },
  rules: [{ field: 'labels', op: 'icontains', value: 'core', set: { workspace: 'api' } }, { field: 'labels', op: 'icontains', value: 'manual', set: { auto: false } }, { field: 'labels', op: 'icontains', value: 'idea', set: { entry: null } }],
};
const withoutIds = (draft: SourceTaskPropsDraft) => ({ ...draft, rules: draft.rules.map(({ id: _id, ...rule }) => rule) });

test('task properties round-trip through the draft: no default workspace reads as "", rule ids are React keys only, field and value are sent trimmed (#688)', () => {
  const draft = taskPropsDraft(SAVED, SCOPE);
  assert.deepEqual(withoutIds(draft), { defaults: { workspace: '', auto: true, entry: { flowId: 'd' } }, rules: SAVED.rules });
  assert.notEqual(draft.rules[0].id, draft.rules[1].id, 'each rule gets its own React key');
  assert.deepEqual(taskPropsFrom(draft, SCOPE), SAVED, 'no id is sent, and no empty workspace key');
  assert.deepEqual(taskPropsFrom({ ...draft, defaults: { workspace: 'api', auto: false, entry: null } }, SCOPE).defaults, { workspace: 'api', auto: false, entry: null });
  assert.deepEqual(taskPropsFrom({ ...draft, rules: [{ ...draft.rules[0], field: ' labels ', value: ' core ' }] }, SCOPE).rules, [SAVED.rules[0]]);
  assert.deepEqual(emptyTaskProps('api', 'd'), { defaults: { workspace: 'api', auto: true, entry: { flowId: 'd' } }, rules: [] });
});

test('propMode is derived from the rules; a new rule sets the first property no rule sets, else workspace, at its default; withProp and withoutProp return new sets (#688)', () => {
  const draft = taskPropsDraft(SAVED, SCOPE);
  assert.deepEqual([propMode(draft, 'workspace'), propMode(draft, 'auto'), propMode(draft, 'entry')], [1, 1, 1]);
  assert.deepEqual([propMode(emptyTaskProps('api'), 'workspace'), propMode(emptyTaskProps('api'), 'auto')], ['fixed', 'fixed']);
  assert.deepEqual(newTaskRule({ ...draft, rules: [draft.rules[0]] }, ['api', 'web']).set, { auto: true }, 'auto is the first property no rule sets');
  assert.deepEqual(newTaskRule(draft, ['api', 'web']).set, { workspace: 'api' }, 'every property set somewhere: workspace, the first workspace since the default is empty');
  const fresh = newTaskRule(emptyTaskProps('web'), ['api', 'web']);
  assert.deepEqual({ ...fresh, id: '' }, { id: '', field: '', op: 'icontains', value: '', set: { workspace: 'web' } }, 'nothing set: workspace, at its default');
  assert.equal(propDefault(emptyTaskProps(), 'workspace', []), '', 'no workspace anywhere');
  assert.equal(propDefault({ ...draft, defaults: { workspace: '', auto: false, entry: null } }, 'auto', []), false);
  const set = { workspace: 'api' };
  assert.deepEqual(withProp(set, 'auto', false), { workspace: 'api', auto: false });
  assert.deepEqual(withoutProp({ workspace: 'api', auto: false }, 'workspace'), { auto: false });
  assert.deepEqual(set, { workspace: 'api' }, 'the input is untouched');
});

test('sourceTaskPropsProblem names, in order: a blank rule, a rule that sets nothing, a gone default or rule workspace, then no workspace anywhere (#688)', () => {
  setLanguage('pt');
  const draft = taskPropsDraft(SAVED, SCOPE);
  const problem = (d: SourceTaskPropsDraft) => sourceTaskPropsProblem('main', d, ['api', 'site'], SCOPE);
  assert.equal(problem(draft), undefined, 'no default workspace is fine while a rule sets one');
  assert.equal(problem(emptyTaskProps('api', 'd')), undefined, 'zero rules is fine');
  const second = (patch: Partial<TaskRuleDraft>): SourceTaskPropsDraft => ({ ...draft, rules: [draft.rules[0], { ...draft.rules[1], ...patch }] });
  for (const blank of [{ field: '  ' }, { value: '' }]) assert.equal(problem(second(blank)), 'source main: a regra 2 precisa de campo e valor', JSON.stringify(blank));
  assert.equal(problem(second({ set: {} })), 'source main: a regra 2 não define nenhuma propriedade');
  assert.equal(problem({ ...draft, defaults: { workspace: 'gone', auto: true, entry: null } }), 'source main: escolha um workspace');
  assert.equal(problem(second({ set: { workspace: 'gone' } })), 'source main: a regra 2 aponta para um workspace removido');
  assert.equal(problem({ ...draft, rules: [draft.rules[1]] }), 'source main: escolha o workspace padrão ou crie uma regra que defina workspace');
});


test('entryDraft and entryFrom map flow and stage names to their draft ids and back; a rename travels with the id (#670)', () => {
  for (const entry of [null, { flow: 'delivery' }, { flow: 'delivery', stage: 'Build' }] as const) assert.deepEqual(entryFrom(entryDraft(entry, SCOPE), SCOPE), entry);
  assert.deepEqual(entryDraft({ flow: 'delivery', stage: 'Build' }, SCOPE), { flowId: 'd', stageId: 's2' });
  const renamed = { flows: [{ id: 'd', name: 'shipping' }, SCOPE.flows[1]], stages: SCOPE.stages.map((s) => (s.id === 's2' ? { ...s, name: 'Make' } : s)) };
  assert.deepEqual(entryFrom({ flowId: 'd', stageId: 's2' }, renamed), { flow: 'shipping', stage: 'Make' });
});

test('entryGone flags a removed flow, a removed stage and a stage of another flow; a name with no draft is gone too (#670)', () => {
  assert.deepEqual([null, { flowId: 'd' }, { flowId: 'd', stageId: 's2' }].map((e) => entryGone(e, SCOPE)), [false, false, false]);
  assert.deepEqual([{ flowId: 'gone' }, { flowId: 'd', stageId: 'gone' }, { flowId: 'd', stageId: 's3' }].map((e) => entryGone(e, SCOPE)), [true, true, true]);
  assert.equal(entryGone(entryDraft({ flow: 'nope' }, SCOPE), SCOPE), true);
});

test('entryLabel reads outside the flow, the flow, or flow · stage (#670)', () => {
  setLanguage('en');
  assert.deepEqual([entryLabel(null, SCOPE), entryLabel({ flowId: 'd' }, SCOPE), entryLabel({ flowId: 'd', stageId: 's2' }, SCOPE)], ['outside the flow', 'delivery', 'delivery · Build']);
});
