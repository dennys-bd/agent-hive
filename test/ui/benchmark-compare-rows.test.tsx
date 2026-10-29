import { beforeEach, expect, test } from 'vitest';
import { compareRows, copiedOverrides, hiddenCount, holdsSame, isSetupRowId } from '@/components/benchmark/compare/rows';
import { setLanguage } from '@/i18n';
import type { Arm, Experiment } from '../../src/types';
import { ISOLATION } from '../benchmark/fixtures';
import { COMPARE } from './benchmark-fixtures';

beforeEach(() => setLanguage('pt'));
// Each row as the table draws it: label, base, then every arm's value or ·
const grid = (e: Experiment): string[][] => compareRows(e).map((row) => [row.label, row.base, ...row.cells.map((cell) => (cell.isSame ? '·' : cell.value))]);
const differing = (e: Experiment): string[][] => grid(e).filter((row) => row.slice(2).some((value) => value !== '·'));

test("the screen's sample: fifteen setup rows, two per agent stage by name, then the rest; the six that differ carry the screen's values and dots; the other nine are equal (#464)", () => {
  expect(compareRows(COMPARE).map((row) => row.id)).toEqual([
    'stage:Spec:prompt', 'stage:Spec:agent', 'stage:Plan:prompt', 'stage:Plan:agent', 'stage:Build:prompt', 'stage:Build:agent', 'stage:PR:prompt', 'stage:PR:agent',
    'plugins', 'rules.allow', 'rules.deny', 'items', 'worktree.setup', 'worktree.teardown', 'tasks',
  ]);
  expect(differing(COMPARE)).toEqual([
    ['Spec · prompt', '/hive:new-spec', '/hive-spec', '·', '·', '·'],
    ['Plan · prompt', '/hive:new-plan', '/hive-plan', '·', '·', '·'],
    ['Build · prompt', '/hive:new-build', '/hive-build', '·', '·', '·'],
    ['Build · agente', 'claude · sonnet', '·', '·', 'codex · gpt-5', '·'],
    ['plugins extras', '—', 'superpowers, ecc', '·', '·', '·'],
    ['tarefas', '8 · 3 bloqueios · t·91d4', '·', '·', '·', '3 · 0 bloqueios'],
  ]);
  expect(hiddenCount(compareRows(COMPARE))).toBe(9);
  expect(grid(COMPARE).find(([label]) => label === 'worktree · teardown')).toEqual(['worktree · teardown', '—', '·', '·', '·', '·']);
  expect(grid(COMPARE).find(([label]) => label === 'Spec · agente')?.[1]).toBe('claude'); // no model: the agent alone
});

test('items read <item>@<version>, sorted; a tasks list with the same counts but other tasks is still an override (#464)', () => {
  const [A, B] = COMPARE.arms;
  const e: Experiment = {
    ...COMPARE,
    arms: [
      { ...A, overrides: { items: { 'hive:new-spec': 'terse', 'hive:new-build': 'long' } } },
      { ...B, overrides: { tasks: COMPARE.base.tasks.map((task) => ({ ...task, title: `${task.title}!` })) } },
    ],
  };
  expect(grid(e).find(([label]) => label === 'itens')).toEqual(['itens', '—', 'hive:new-build@long, hive:new-spec@terse', '·']);
  expect(grid(e).find(([label]) => label === 'tarefas')).toEqual(['tarefas', '8 · 3 bloqueios · t·91d4', '·', '8 · 3 bloqueios']);
});

test('an overridden setup cell is copyable; an equal one is not; nothing is copyable while the experiment runs or sleeps (#464)', () => {
  const spec = compareRows(COMPARE)[0];
  expect(spec.cells.map((cell) => cell.isCopyable)).toEqual([true, false, false, false]);
  for (const status of ['running', 'sleeping'] as const) {
    expect(compareRows({ ...COMPARE, status }).flatMap((row) => row.cells).some((cell) => cell.isCopyable)).toBe(false);
  }
  expect(compareRows({ ...COMPARE, status: 'done' })[0].cells[0].isCopyable).toBe(true);
});

test('an isolation row appears only when a perArm value differs from all: the base shows all, that arm its value, the rest ·; never copyable, never hidden (#464)', () => {
  const isolation = {
    ...ISOLATION,
    network: { all: [], perArm: { a1: ['github.com', 'npmjs.org'] } },
    permissionMode: { all: 'dontAsk', perArm: { a2: 'dontAsk' } }, // equal to all: no row
    limits: { all: { turns: 200 }, perArm: { gone: { turns: 5 } } }, // an arm no longer in the experiment: no row
  };
  const e = { ...COMPARE, isolation };
  const rows = compareRows(e);
  expect(grid(e).slice(15)).toEqual([['rede', '—', 'github.com, npmjs.org', '·', '·', '·']]);
  expect(rows.at(-1)?.id).toBe('isolation.network');
  expect(rows.at(-1)?.cells.some((cell) => cell.isCopyable)).toBe(false);
  expect(hiddenCount(rows)).toBe(9);
  expect(compareRows(COMPARE)).toHaveLength(15); // the fixture's isolation varies nowhere
});

test('a record reads key=value pairs (#464)', () => {
  const isolation = { ...ISOLATION, env: { all: { CI: '1' }, perArm: { a3: { CI: '1', DEBUG: 'hive' } } } };
  expect(grid({ ...COMPARE, isolation }).at(-1)).toEqual(['variáveis de ambiente', 'CI=1', '·', '·', 'CI=1, DEBUG=hive', '·']);
});

const [A, B, C, D] = COMPARE.arms;

test("a copy sets one stage field on the target, field by field as the arms tab writes it, and keeps the target's other overrides (#464)", () => {
  expect(copiedOverrides(COMPARE, 'stage:Build:agent', C, A)).toEqual({
    stages: { Spec: { prompt: '/hive-spec {title}\n\n{body}' }, Plan: { prompt: '/hive-plan {title}\n\n{body}' }, Build: { prompt: '/hive-build {title}\n\n{body}', agent: 'codex', model: 'gpt-5' } },
    plugins: ['superpowers', 'ecc'],
  });
  expect(copiedOverrides(COMPARE, 'stage:Build:prompt', A, D)).toEqual({ stages: { Build: { prompt: '/hive-build {title}\n\n{body}' } }, tasks: D.overrides.tasks });
  expect(copiedOverrides(COMPARE, 'tasks', D, B)).toEqual({ tasks: D.overrides.tasks });
});

test("a copy that brings a key back to the base drops it; a source on the agent's own default model says null over the base's model (#464)", () => {
  expect(copiedOverrides(COMPARE, 'stage:Build:agent', A, C)).toEqual({}); // A's Build agent is the base's: C's stages are the base's again
  const E: Arm = { id: 'a5', letter: 'E', name: 'codex sem modelo', overrides: { stages: { Build: { agent: 'codex', model: null } } } };
  const copied = copiedOverrides({ ...COMPARE, arms: [...COMPARE.arms, E] }, 'stage:Build:agent', E, B);
  expect(copied).toEqual({ stages: { Build: { agent: 'codex', model: null } } });
});

test('holdsSame compares the two arms on the row; isSetupRowId tells the setup rows from the isolation ones (#464)', () => {
  expect([holdsSame(COMPARE, 'stage:Build:agent', A, B), holdsSame(COMPARE, 'stage:Build:agent', C, A), holdsSame(COMPARE, 'tasks', D, A)]).toEqual([true, false, false]);
  expect([isSetupRowId('tasks'), isSetupRowId('isolation.network')]).toEqual([true, false]);
});
