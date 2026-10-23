import { beforeEach, expect, test } from 'vitest';
import { runContext, runText, tokensText } from '@/components/benchmark/execution/run-text';
import { setLanguage } from '@/i18n';
import type { BenchPace, Experiment } from '../../src/types';
import { arm, experiment } from '../benchmark/fixtures';

beforeEach(() => setLanguage('pt'));
const PACE: BenchPace = { pairs: 3, until: '07:00', runTimeoutMs: 72_000_000, workersPerArm: 3, cap: { tokens: 4_000_000, planPercent: 40 } };
const of = (pace: Partial<BenchPace> = {}, arms = 4): Experiment =>
  experiment({ name: 'skills: comandos × plugin', arms: ['A', 'B', 'C', 'D'].slice(0, arms).map((l, i) => arm(`a${i + 1}`, l)), pace: { ...PACE, ...pace } });
const LEAD = 'executa 3 pares, um run de cada braço por par, até 3 workers por braço.';

test("the screen's dlg-run: the context, and the text with until, the token cap and the plan cap (#465)", () => {
  expect(runContext(of())).toBe('skills: comandos × plugin · 4 braços · 3 pares');
  expect(runText(of())).toBe(`${LEAD} nenhum par novo começa depois de 07:00 nem acima de 4M tokens ou 40% do plano.`);
});

test('only the clauses the pace sets; a pace with neither until nor cap prints no limit sentence (#465)', () => {
  expect(runText(of({ until: undefined }))).toBe(`${LEAD} nenhum par novo começa acima de 4M tokens ou 40% do plano.`);
  expect(runText(of({ cap: { tokens: 4_000_000 } }))).toBe(`${LEAD} nenhum par novo começa depois de 07:00 nem acima de 4M tokens.`);
  expect(runText(of({ cap: { planPercent: 40 }, until: undefined }))).toBe(`${LEAD} nenhum par novo começa acima de 40% do plano.`);
  expect(runText(of({ cap: {} }))).toBe(`${LEAD} nenhum par novo começa depois de 07:00.`);
  expect(runText(of({ cap: {}, until: undefined }))).toBe(LEAD);
});

test("one arm and one pair read in the singular; tokens in the language's decimals; English (#465)", () => {
  expect(runContext(of({ pairs: 1 }, 1))).toBe('skills: comandos × plugin · 1 braço · 1 par');
  expect([tokensText(1_900_000), tokensText(4_000_000), tokensText(850_000)]).toEqual(['1,9M', '4M', '850k']);
  setLanguage('en');
  expect(runText(of())).toBe('runs 3 pairs, one run of each arm per pair, up to 3 workers per arm. no new pair starts after 07:00 nor above 4M tokens or 40% of the plan.');
  expect(tokensText(1_900_000)).toBe('1.9M');
});
