import { beforeEach, expect, test } from 'vitest';
import {
  armMedians, collectorView, lastShot, metricCells, runChip, runOf, scenarioTone, scenarioTotals, screenUrl, sleepsInRound, waitingTasks,
} from '@/components/benchmark/result/result-view';
import { setLanguage } from '@/i18n';
import { EVALUATION, METRICS, NOW, RESULT_EXP, RUN_B1, RUN_B2 } from './benchmark-result-fixtures';

beforeEach(() => setLanguage('pt'));

test('runOf finds a run of the experiment by token; an unknown or no token is none (#466)', () => {
  expect(runOf(RESULT_EXP, RUN_B2.token)).toBe(RUN_B2);
  expect(runOf(RESULT_EXP, 'zzzz')).toBeUndefined();
  expect(runOf(RESULT_EXP, undefined)).toBeUndefined();
});

test('the arm medians are the report\'s in-filter medians; an arm with no run has none (#466)', () => {
  expect(armMedians(RESULT_EXP, 'a2', NOW)).toEqual({ tokens: 2_500_000, costUsd: 33 });
  expect(armMedians(RESULT_EXP, 'a1', NOW)).toEqual({ tokens: undefined, costUsd: undefined });
});

test('the strip\'s eight cells read the run B · par 1 as the screen does (#466)', () => {
  expect(metricCells(RESULT_EXP, RUN_B1, NOW)).toEqual([
    { label: 'tokens', value: '2.6M', context: ['mediana B 2.5M'] },
    { label: 'custo', value: '$31', context: ['mediana B $33'] },
    { label: 'tempo', value: '4h55', context: ['sem tempo dormindo'] },
    { label: 'aguardando', value: '18m', context: ['em 1 tarefa'] },
    { label: 'restarts', value: '1', context: ['build · HIV-415'] },
    { label: 'diff', value: '+3.480 −540', context: ['33 arquivos'] },
    { label: 'testes', value: '3/3', context: ['verdes'] },
    { label: 'cenários', value: '17/18', context: ['S4 falhou 1×'] },
  ]);
});

test('unpriced models add a line to the cost; no waiting task, no restart and no failure leave their lines out or say so (#466)', () => {
  expect(metricCells(RESULT_EXP, { ...RUN_B1, unpriced: ['gpt-x', 'local-y'] }, NOW)?.[1].context).toEqual(['mediana B $33', 'sem preço para gpt-x, local-y']);
  const calm = { ...METRICS, restarts: { count: 0, where: [] }, tasks: METRICS.tasks.map((task) => ({ ...task, waitingMs: 0 })) };
  const allGreen = { ...EVALUATION, scenarios: EVALUATION.scenarios.map((s) => ({ ...s, passed: s.total })) };
  const cells = metricCells(RESULT_EXP, { ...RUN_B1, metrics: calm, evaluation: allGreen }, NOW) ?? [];
  expect([cells[3].context, cells[4].context, cells[7].context]).toEqual([[], [], ['todos verdes']]);
});

test('a run with no metrics has no strip; one with no evaluation reads — and ainda não avaliado for scenarios (#466)', () => {
  expect(metricCells(RESULT_EXP, { ...RUN_B1, metrics: undefined }, NOW)).toBeUndefined();
  expect(metricCells(RESULT_EXP, { ...RUN_B1, evaluation: undefined }, NOW)?.[7]).toEqual({ label: 'cenários', value: '—', context: ['ainda não avaliado'] });
});

test('scenario totals, the first failure, the tone and the last screenshot with its URL (#466)', () => {
  expect(scenarioTotals(EVALUATION.scenarios)).toEqual({ passed: 17, total: 18, walks: 3, firstFailure: { id: 'S4', failed: 1 } });
  expect(scenarioTotals([])).toEqual({ passed: 0, total: 0, walks: 0 });
  expect(EVALUATION.scenarios.map(scenarioTone)).toEqual(['green', 'green', 'green', 'yellow', 'green', 'green']);
  expect([lastShot(EVALUATION.scenarios[0]), lastShot(EVALUATION.scenarios[5])]).toEqual(['S1-3.png', undefined]);
  expect(screenUrl('exp-1', '7d03b2a1', 'S1-3.png')).toBe('/benchmark/experiments/exp-1/runs/7d03b2a1/screens/S1-3.png');
  expect(screenUrl('exp-1', 'tok', 'a b.png')).toBe('/benchmark/experiments/exp-1/runs/tok/screens/a%20b.png');
});

test('a collector reads ok green, N achados yellow, erro red, and an empty summary as — (#466)', () => {
  const [reviewer, tdd, lint] = EVALUATION.collectors;
  expect(collectorView(reviewer)).toEqual({ tone: 'yellow', text: '3 achados', summary: reviewer.summary });
  expect(collectorView(tdd)).toEqual({ tone: 'green', text: 'ok', summary: tdd.summary });
  expect(collectorView(lint).summary).toBe('—');
  expect(collectorView({ ...lint, status: 'error' })).toEqual({ tone: 'red', text: 'erro', summary: '—' });
});

test('waiting tasks, the round\'s sleeps and the run chip (#466)', () => {
  expect(waitingTasks(METRICS)).toBe(1);
  const slept = { ...RESULT_EXP, sleeps: [{ round: 1, at: '2026-10-21T01:00:00', reason: 'quota' }, { round: 2, at: '2026-10-22T01:00:00', reason: 'quota' }] };
  expect([sleepsInRound(slept, 1), sleepsInRound(RESULT_EXP, 1)]).toEqual([1, 0]);
  expect(runChip(RUN_B1)).toEqual({ tone: 'muted', text: 'concluída · 22:01 → 02:56' });
  expect(runChip({ ...RUN_B1, status: 'timeout' })).toEqual({ tone: 'yellow', text: 'tempo esgotado' });
  expect(runChip({ ...RUN_B1, status: 'error' })).toEqual({ tone: 'red', text: 'erro' });
  expect(runChip({ ...RUN_B1, status: 'interrupted' })).toEqual({ tone: 'muted', text: 'interrompida' });
  expect(runChip({ ...RUN_B1, endedAt: undefined }).text).toBe('concluída');
});
