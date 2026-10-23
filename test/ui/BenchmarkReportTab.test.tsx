import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { ReportTable } from '@/components/benchmark/report/ReportTable';
import { setLanguage } from '@/i18n';
import type { ArmColumn, BenchReport, DiffCell, RatioCell, ReportRow, SpreadCell } from '../../src/benchmark/report';

const M = 1_000_000;
const MIN = 60_000;
const H = 60 * MIN;
const BEST = { best: true } as const;
const s = (median: number, min: number, max: number, extra: Partial<SpreadCell> = {}): SpreadCell => ({ value: { median, min, max, n: 3 }, ...extra });
const row = <C,>(key: string, a: C, b: C, c: C, d: C): ReportRow<C> => ({ key, cells: { a1: a, a2: b, a3: c, a4: d } });
const col = (armId: string, letter: string, name: string, patch: Partial<ArmColumn> = {}): ArmColumn => ({
  armId, letter, name, runs: 3, inMedian: 3, intervened: 0, out: 0, slept: 1, onlyPerRun: false, ...patch,
});
const diff = (insertions: number, deletions: number, files: number): DiffCell => ({ insertions, deletions, files });
const ratio = (passed: number, total: number, best?: true): RatioCell => ({ passed, total, ...(best ? { best } : {}) });

/** benchmark.hv.html's relatório: four arms, three rounds, B and C intervened, round 2 slept once, C with two timeouts, D only per run, a3
 *  unpaired. A tie marks no best (3.6), so testes verdes and spec e plano bold nothing where the screen bolds two. */
const REPORT: BenchReport = {
  experimentId: 'exp-1', filter: 'in', rounds: 3, unpaired: ['a3'], judge: { agent: 'claude', model: 'fable' }, mixedRubrics: false,
  intervened: [{ token: '7d03b2c4', letter: 'B', inMedian: true }, { token: 'e30b71d9', letter: 'C', inMedian: true }],
  sleeps: [{ round: 2, times: 1, ms: 2 * H + 5 * MIN, reasons: ['preciso da máquina para outra coisa'] }],
  arms: [col('a1', 'A', 'comandos do repo'), col('a2', 'B', 'skills do plugin', { intervened: 1 }), col('a3', 'C', 'plugin + codex', { intervened: 1 }), col('a4', 'D', 'tarefas juntas', { onlyPerRun: true })],
  execution: {
    tokens: row('tokens', s(3.1 * M, 2.8 * M, 3.4 * M), s(2.5 * M, 2.2 * M, 2.7 * M), s(2.9 * M, 2.7 * M, 3 * M), s(2.2 * M, 2 * M, 2.5 * M, BEST)),
    cost: row('cost', s(41, 37, 45), s(33, 29, 36), s(36, 34, 38), s(29, 26, 33, BEST)),
    time: row('time', s(5 * H + 32 * MIN, 5 * H + 10 * MIN, 5 * H + 50 * MIN), s(4 * H + 48 * MIN, 4 * H + 30 * MIN, 5 * H + 5 * MIN), s(6 * H, 5 * H, 6 * H, { timeouts: 2 }), s(4 * H + 20 * MIN, 4 * H + 5 * MIN, 4 * H + 40 * MIN, BEST)),
    waiting: row('waiting', s(22 * MIN, 14 * MIN, 30 * MIN), s(18 * MIN, 9 * MIN, 25 * MIN), s(31 * MIN, 20 * MIN, 40 * MIN), s(12 * MIN, 8 * MIN, 20 * MIN, BEST)),
    restarts: row('restarts', s(2, 1, 3), s(1, 0, 2, BEST), s(4, 3, 5), s(2, 1, 3)),
    diff: row<DiffCell | undefined>('diff', diff(4120, 610, 38), diff(3480, 540, 33), diff(3900, 700, 36), diff(3610, 590, 34)),
    tests: row('tests', ratio(3, 3), ratio(3, 3), ratio(1, 3), ratio(2, 3)),
  },
  clicks: { first: 'S1', last: 'S6', row: row('clicks', ratio(16, 18), ratio(17, 18, true), ratio(11, 18), ratio(15, 18)) },
  judgeRows: [
    row('fidelidade', s(4, 4, 5), s(4, 4, 5), s(3, 3, 4), s(4, 3, 4)),
    row('comportamento', s(4, 3, 4), s(5, 4, 5, BEST), s(3, 2, 4), s(4, 3, 5)),
    row('código', s(4, 4, 4), s(4, 4, 4), s(4, 3, 4), s(4, 4, 4)),
    row('spec e plano', s(3, 3, 4), s(4, 4, 5), s(4, 4, 4), s(3, 2, 3)),
    row('testes', s(4, 4, 4), s(4, 4, 4), s(3, 2, 3), s(3, 3, 4)),
  ],
};

const rowOf = (label: string) => within(screen.getByRole('rowheader', { name: label }).closest('[role="row"]') as HTMLElement);
const cells = (label: string): (string | null)[] => rowOf(label).getAllByRole('cell').map((cell) => cell.textContent);
const bold = (label: string): boolean[] => rowOf(label).getAllByRole('cell').map((cell) => cell.querySelector('strong') !== null);

beforeEach(() => setLanguage('pt'));

test("ReportTable draws every header and cell of the screen's relatório, the row's best in bold and nothing else (#467)", () => {
  render(<ReportTable report={REPORT} />);
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
    'A · comandos do repo3 runs1 dormiu', 'B · skills do plugin3 runs1 com intervenção1 dormiu',
    'C · plugin + codex3 runs1 com intervenção1 dormiu', 'D · tarefas juntas3 runs · só por run1 dormiu',
  ]);
  expect(screen.getAllByText('1 com intervenção', { selector: '.text-waiting' })).toHaveLength(2); // B and C
  for (const section of ['execução', 'cenários de clique', 'juiz']) expect(screen.getByRole('rowheader', { name: section })).toBeInTheDocument();
  expect(cells('tokens')).toEqual(['3,1M 2,8–3,4M', '2,5M 2,2–2,7M', '2,9M 2,7–3,0M', '2,2M 2,0–2,5M']);
  expect(cells('custo')).toEqual(['$41 37–45', '$33 29–36', '$36 34–38', '$29 26–33']);
  expect(cells('tempo')).toEqual(['5h32 5h10–5h50', '4h48 4h30–5h05', '6h00 timeout ×2', '4h20 4h05–4h40']);
  expect(cells('tempo aguardando')).toEqual(['22m 14–30m', '18m 9–25m', '31m 20–40m', '12m 8–20m']);
  expect(cells('restarts')).toEqual(['2 1–3', '1 0–2', '4 3–5', '2 1–3']);
  expect(cells('diff')).toEqual(['+4.120 −610 38 arquivos', '+3.480 −540 33 arquivos', '+3.900 −700 36 arquivos', '+3.610 −590 34 arquivos']);
  expect(cells('testes verdes')).toEqual(['3/3', '3/3', '1/3', '2/3']);
  expect(cells('S1 · S6')).toEqual(['16/18', '17/18', '11/18', '15/18']);
  expect(cells('fidelidade')).toEqual(['4 4–5', '4 4–5', '3 3–4', '4 3–4']);
  expect(cells('comportamento')).toEqual(['4 3–4', '5 4–5', '3 2–4', '4 3–5']);
  expect(cells('código')).toEqual(['4 4', '4 4', '4 3–4', '4 4']);
  expect(cells('spec e plano')).toEqual(['3 3–4', '4 4–5', '4 4', '3 2–3']);
  expect(cells('testes')).toEqual(['4 4', '4 4', '3 2–3', '3 3–4']);
  for (const label of ['tokens', 'custo', 'tempo', 'tempo aguardando']) expect(bold(label)).toEqual([false, false, false, true]);
  for (const label of ['restarts', 'S1 · S6', 'comportamento']) expect(bold(label)).toEqual([false, true, false, false]);
  for (const label of ['diff', 'testes verdes', 'fidelidade', 'código', 'spec e plano', 'testes']) expect(bold(label)).toEqual([false, false, false, false]);
});

test('the click row hides when no arm has a scenario total and the judge section when it has no row; six arms widen the grid, a missing cell a dash (#467)', () => {
  const noClicks = { row: row('clicks', ratio(0, 0), ratio(0, 0), ratio(0, 0), ratio(0, 0)) };
  const arms = [...REPORT.arms, col('a5', 'E', 'e'), col('a6', 'F', 'f')];
  render(<ReportTable report={{ ...REPORT, clicks: noClicks, judgeRows: [], arms }} />);
  expect(screen.queryByRole('rowheader', { name: 'cenários de clique' })).not.toBeInTheDocument();
  expect(screen.queryByRole('rowheader', { name: 'juiz' })).not.toBeInTheDocument();
  expect((screen.getAllByRole('row')[0] as HTMLElement).style.gridTemplateColumns).toBe('180px repeat(6, minmax(120px, 1fr))');
  expect(cells('tokens')).toHaveLength(6);
  expect(cells('tokens').slice(4)).toEqual(['—', '—']);
  expect(cells('diff').slice(4)).toEqual(['—', '—']);
});
