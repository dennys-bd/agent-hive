import { beforeEach, expect, test } from 'vitest';
import { armRows, cleanSetup, resetRow, sameRows, setRow } from '@/components/benchmark/arms/arm-rows';
import { setLanguage } from '@/i18n';
import { ARMS, ARMS_BASE } from './benchmark-fixtures';

beforeEach(() => setLanguage('pt'));
const rowsOf = (letter: string) => armRows(ARMS.base, ARMS.arms.find((a) => a.letter === letter)?.overrides ?? {});
const rowOf = (letter: string, key: string) => rowsOf(letter).find((r) => r.key === key);
const LETTERS = ['A', 'B', 'C', 'D'];

test('the screen sample counts 2, 0, 1, 1 overrides, each a row, with its footer (#462)', () => {
  expect(LETTERS.map((l) => rowsOf(l).filter((r) => r.overridden).map((r) => r.key))).toEqual([['skills', 'plugins'], [], ['build'], ['tasks']]);
  expect(LETTERS.map((l) => sameRows(rowsOf(l)))).toEqual([
    'igual à base: agentes, prompts, itens, tarefas, regras, worktree',
    'igual à base: tudo',
    'igual à base: spec, plan, pr, skills, prompts, plugins, itens, tarefas, regras, worktree',
    'igual à base: agentes, skills, prompts, plugins, itens, regras, worktree',
  ]);
});

test('an overridden row reads the arm value and the struck base value; skills and plugins draw none, plugins as + added (#462)', () => {
  expect(rowOf('C', 'build')).toMatchObject({ value: 'codex · gpt-5', was: 'claude · sonnet' });
  expect(rowOf('A', 'skills')).toMatchObject({ value: '/hive-spec /hive-plan /hive-build /hive:new-pr' });
  expect(rowOf('A', 'skills')).not.toHaveProperty('was');
  expect(rowOf('A', 'plugins')).toMatchObject({ value: '+ superpowers, ecc' });
  expect(rowOf('A', 'plugins')).not.toHaveProperty('was');
  expect(rowOf('D', 'tasks')).toMatchObject({ value: '3 tarefas · 0 bloqueios', was: '8 tarefas da base' });
  expect(rowOf('B', 'rules')?.value).toBe('14 permitidas · gh, push * negadas');
});

test('setRow keeps only what differs from the base, per stage field; resetRow and a value equal to the base give {} (#462)', () => {
  const set = setRow(ARMS_BASE, {}, 'build', { agent: 'codex', model: 'sonnet' });
  expect(set).toEqual({ stages: { build: { agent: 'codex' } } });
  const both = setRow(ARMS_BASE, set, 'plugins', ['/p/x']);
  expect(both).toEqual({ stages: { build: { agent: 'codex' } }, plugins: ['/p/x'] });
  expect(resetRow(ARMS_BASE, resetRow(ARMS_BASE, both, 'build'), 'plugins')).toEqual({});
  expect(setRow(ARMS_BASE, {}, 'plugins', [])).toEqual({});
});

test("the agent's default over a base model is stored as model null and resetRow drops it; over a base with no model it is no override (#462)", () => {
  const agentDefault = setRow(ARMS_BASE, {}, 'build', { agent: 'claude' });
  expect(agentDefault).toEqual({ stages: { build: { model: null } } });
  expect(armRows(ARMS_BASE, agentDefault).find((r) => r.key === 'build')).toMatchObject({ value: 'claude', was: 'claude · sonnet', overridden: true });
  expect(resetRow(ARMS_BASE, agentDefault, 'build')).toEqual({});
  const { model: _model, ...specWithoutModel } = ARMS_BASE.stages.spec;
  const noModelBase = { ...ARMS_BASE, stages: { ...ARMS_BASE.stages, spec: specWithoutModel } };
  expect(setRow(noModelBase, {}, 'spec', { agent: 'claude' })).toEqual({});
});

test('cleanSetup drops blank list entries the text fields leave (#462)', () => {
  const tasks = [{ key: 'T1', title: '', body: '', blockedBy: ['', 'T0', ' '] }];
  expect(cleanSetup({ ...ARMS_BASE, plugins: ['/a', ''], rules: { allow: [''], deny: ['gh'] }, tasks })).toEqual({ ...ARMS_BASE, plugins: ['/a'], rules: { allow: [], deny: ['gh'] }, tasks: [{ ...tasks[0], blockedBy: ['T0'] }] });
});
