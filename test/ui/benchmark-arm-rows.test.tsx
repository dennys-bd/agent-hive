import { beforeEach, expect, test } from 'vitest';
import { armRows, cleanSetup, readStage, resetRow, sameRows, setRow, setStage } from '@/components/benchmark/arms/arm-rows';
import { setLanguage } from '@/i18n';
import { ARMS, ARMS_BASE } from './benchmark-fixtures';

beforeEach(() => setLanguage('pt'));
const rowsOf = (letter: string) => armRows(ARMS.base, ARMS.arms.find((a) => a.letter === letter)?.overrides ?? {});
const rowOf = (letter: string, key: string) => rowsOf(letter).find((r) => r.key === key);
const LETTERS = ['A', 'B', 'C', 'D'];

test('the screen sample counts 4, 0, 1, 1 overrides by stage name, with the cards\' footers (#536)', () => {
  expect(LETTERS.map((l) => rowsOf(l).filter((r) => r.overridden).map((r) => r.key))).toEqual([['stage:Spec', 'stage:Plan', 'stage:Build', 'plugins'], [], ['stage:Build'], ['tasks']]);
  expect(LETTERS.map((l) => sameRows(rowsOf(l)))).toEqual([
    'igual à base: Checks, Avaliação, PR, itens, tarefas, regras, worktree',
    'igual à base: tudo',
    'igual à base: Spec, Plan, Checks, Avaliação, PR, plugins, itens, tarefas, regras, worktree',
    'igual à base: etapas, plugins, itens, regras, worktree',
  ]);
});

test('an overridden stage row reads the arm value and the struck base value (#536)', () => {
  expect(rowOf('C', 'stage:Build')).toMatchObject({ label: 'Build', value: 'codex · gpt-5', was: 'claude · sonnet' });
  expect(rowOf('A', 'stage:Spec')).toMatchObject({ value: '/hive-spec', was: '/hive:new-spec' });
  expect(rowOf('A', 'plugins')).toMatchObject({ value: '+ superpowers, ecc' });
  expect(rowOf('A', 'plugins')).not.toHaveProperty('was');
  expect(rowOf('D', 'tasks')).toMatchObject({ value: '3 tarefas · 0 bloqueios', was: '8 tarefas da base' });
  expect(rowOf('B', 'stage:Avaliação')?.value).toBe('juiz claude · fable · limiar 7');
  expect(rowOf('B', 'rules.deny')).toMatchObject({ label: 'negadas', value: 'gh, push *' });
});

test('one rules list kept is named on its own in the footer; both kept are regras (#536)', () => {
  const rows = armRows(ARMS_BASE, setRow(ARMS_BASE, {}, 'rules.allow', ['Read']));
  expect(sameRows(rows)).toBe('igual à base: etapas, plugins, itens, tarefas, negadas, worktree');
});

test('setStage then resetRow gives {}; a field equal to the base is no override; model null over a base model (#536)', () => {
  const build = readStage(ARMS_BASE, 'Build');
  const set = setStage(ARMS_BASE, {}, { ...build, agent: 'codex' });
  expect(set).toEqual({ stages: { Build: { agent: 'codex' } } });
  expect(setStage(ARMS_BASE, set, { ...build, agent: 'codex', prompt: build.prompt })).toEqual(set);
  expect(resetRow(ARMS_BASE, set, 'stage:Build')).toEqual({});
  const { model: _m, ...noModel } = build;
  expect(setStage(ARMS_BASE, {}, noModel)).toEqual({ stages: { Build: { model: null } } });
  expect(armRows(ARMS_BASE, { stages: { Build: { model: null } } }).find((r) => r.key === 'stage:Build')).toMatchObject({ value: 'claude', was: 'claude · sonnet', overridden: true });
  expect(setRow(ARMS_BASE, {}, 'plugins', [])).toEqual({});
  expect(resetRow(ARMS_BASE, setRow(ARMS_BASE, set, 'plugins', ['/p/x']), 'plugins')).toEqual(set);
});

test('readStage throws on a name the flow lacks (#536)', () => {
  expect(() => readStage(ARMS_BASE, 'Gone')).toThrow();
});

test('cleanSetup drops blank list entries the text fields leave (#462)', () => {
  const tasks = [{ key: 'T1', title: '', body: '', blockedBy: ['', 'T0', ' '] }];
  expect(cleanSetup({ ...ARMS_BASE, plugins: ['/a', ''], rules: { allow: [''], deny: ['gh'] }, tasks })).toEqual({ ...ARMS_BASE, plugins: ['/a'], rules: { allow: [], deny: ['gh'] }, tasks: [{ ...tasks[0], blockedBy: ['T0'] }] });
});
