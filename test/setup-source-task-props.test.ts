import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/ui/i18n.js';
import {
  emptyTaskProps, newTaskRule, propDefault, propMode, sourceTaskPropsProblem, type SourceTaskPropsDraft, taskPropsDraft, taskPropsFrom, type TaskRuleDraft, withoutProp, withProp,
} from '../src/ui/lib/setup-source-task-props.js';
import type { SourceTaskProps } from '../src/types.js';

const SAVED: SourceTaskProps = {
  defaults: { auto: true },
  rules: [{ field: 'labels', op: 'icontains', value: 'core', set: { workspace: 'api' } }, { field: 'labels', op: 'icontains', value: 'manual', set: { auto: false } }],
};
const withoutIds = (draft: SourceTaskPropsDraft) => ({ ...draft, rules: draft.rules.map(({ id: _id, ...rule }) => rule) });

test('task properties round-trip through the draft: no default workspace reads as "", rule ids are React keys only, field and value are sent trimmed (#688)', () => {
  const draft = taskPropsDraft(SAVED);
  assert.deepEqual(withoutIds(draft), { defaults: { workspace: '', auto: true }, rules: SAVED.rules });
  assert.notEqual(draft.rules[0].id, draft.rules[1].id, 'each rule gets its own React key');
  assert.deepEqual(taskPropsFrom(draft), SAVED, 'no id is sent, and no empty workspace key');
  assert.deepEqual(taskPropsFrom({ ...draft, defaults: { workspace: 'api', auto: false } }).defaults, { workspace: 'api', auto: false });
  assert.deepEqual(taskPropsFrom({ ...draft, rules: [{ ...draft.rules[0], field: ' labels ', value: ' core ' }] }).rules, [SAVED.rules[0]]);
  assert.deepEqual(emptyTaskProps('api'), { defaults: { workspace: 'api', auto: true }, rules: [] });
});

test('propMode is derived from the rules; a new rule sets the first property no rule sets, else workspace, at its default; withProp and withoutProp return new sets (#688)', () => {
  const draft = taskPropsDraft(SAVED);
  assert.deepEqual([propMode(draft, 'workspace'), propMode(draft, 'auto')], [1, 1]);
  assert.deepEqual([propMode(emptyTaskProps('api'), 'workspace'), propMode(emptyTaskProps('api'), 'auto')], ['fixed', 'fixed']);
  assert.deepEqual(newTaskRule({ ...draft, rules: [draft.rules[0]] }, ['api', 'web']).set, { auto: true }, 'auto is the first property no rule sets');
  assert.deepEqual(newTaskRule(draft, ['api', 'web']).set, { workspace: 'api' }, 'every property set somewhere: workspace, the first workspace since the default is empty');
  const fresh = newTaskRule(emptyTaskProps('web'), ['api', 'web']);
  assert.deepEqual({ ...fresh, id: '' }, { id: '', field: '', op: 'icontains', value: '', set: { workspace: 'web' } }, 'nothing set: workspace, at its default');
  assert.equal(propDefault(emptyTaskProps(), 'workspace', []), '', 'no workspace anywhere');
  assert.equal(propDefault({ ...draft, defaults: { workspace: '', auto: false } }, 'auto', []), false);
  const set = { workspace: 'api' };
  assert.deepEqual(withProp(set, 'auto', false), { workspace: 'api', auto: false });
  assert.deepEqual(withoutProp({ workspace: 'api', auto: false }, 'workspace'), { auto: false });
  assert.deepEqual(set, { workspace: 'api' }, 'the input is untouched');
});

test('sourceTaskPropsProblem names, in order: a blank rule, a rule that sets nothing, a gone default or rule workspace, then no workspace anywhere (#688)', () => {
  setLanguage('pt');
  const draft = taskPropsDraft(SAVED);
  const problem = (d: SourceTaskPropsDraft) => sourceTaskPropsProblem('main', d, ['api', 'site']);
  assert.equal(problem(draft), undefined, 'no default workspace is fine while a rule sets one');
  assert.equal(problem(emptyTaskProps('api')), undefined, 'zero rules is fine');
  const second = (patch: Partial<TaskRuleDraft>): SourceTaskPropsDraft => ({ ...draft, rules: [draft.rules[0], { ...draft.rules[1], ...patch }] });
  for (const blank of [{ field: '  ' }, { value: '' }]) assert.equal(problem(second(blank)), 'source main: a regra 2 precisa de campo e valor', JSON.stringify(blank));
  assert.equal(problem(second({ set: {} })), 'source main: a regra 2 não define nenhuma propriedade');
  assert.equal(problem({ ...draft, defaults: { workspace: 'gone', auto: true } }), 'source main: escolha um workspace');
  assert.equal(problem(second({ set: { workspace: 'gone' } })), 'source main: a regra 2 aponta para um workspace removido');
  assert.equal(problem({ ...draft, rules: [draft.rules[1]] }), 'source main: escolha o workspace padrão ou crie uma regra que defina workspace');
});
