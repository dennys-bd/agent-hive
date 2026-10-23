import { beforeEach, expect, test } from 'vitest';
import { diffText, formatDuration, ratioText, type SpreadKind, spreadText } from '@/components/benchmark/report/report-format';
import { setLanguage } from '@/i18n';
import type { SpreadCell } from '../../src/benchmark/report';

const M = 1_000_000;
const MIN = 60_000;
const H = 60 * MIN;
const s = (median: number, min: number, max: number, extra: Partial<SpreadCell> = {}): SpreadCell => ({ value: { median, min, max, n: 3 }, ...extra });
const text = (kind: SpreadKind, cell: SpreadCell): [string, string | undefined] => {
  const { value, sub } = spreadText(kind, cell);
  return [value, sub];
};

beforeEach(() => setLanguage('pt'));

test('tokens: one decimal in millions with the unit once on the range, whole thousands under a million (#467)', () => {
  expect(text('tokens', s(3.1 * M, 2.8 * M, 3.4 * M))).toEqual(['3,1M', '2,8–3,4M']);
  expect(text('tokens', s(2.9 * M, 2.7 * M, 3 * M))).toEqual(['2,9M', '2,7–3,0M']);
  expect(text('tokens', s(640_000, 512_000, 980_000))).toEqual(['640k', '512–980k']);
  expect(text('tokens', s(999_600, 999_600, 999_600))).toEqual(['1,0M', '1,0M']);
  setLanguage('en');
  expect(text('tokens', s(3.1 * M, 2.8 * M, 3.4 * M))).toEqual(['3.1M', '2.8–3.4M']);
});

test('cost: whole dollars, one decimal under $10, the range without $ (#467)', () => {
  expect(text('cost', s(41, 37, 45))).toEqual(['$41', '37–45']);
  expect(text('cost', s(7.46, 6.5, 9.2))).toEqual(['$7,5', '6,5–9,2']);
  setLanguage('en');
  expect(text('cost', s(7.46, 6.5, 9.2))).toEqual(['$7.5', '6.5–9.2']);
});

test("time and waiting: 5h32 from an hour up, 22m under it; a cell's timeouts take the range's place (#467)", () => {
  expect(text('time', s(5 * H + 32 * MIN, 5 * H + 10 * MIN, 5 * H + 50 * MIN))).toEqual(['5h32', '5h10–5h50']);
  expect(text('time', s(22 * MIN, 14 * MIN, 30 * MIN))).toEqual(['22m', '14–30m']);
  expect(text('time', s(6 * H, 5 * H, 6 * H, { timeouts: 2 }))).toEqual(['6h00', 'timeout ×2']);
  expect(formatDuration(2 * H + 5 * MIN)).toBe('2h05');
  setLanguage('en');
  expect(text('time', s(6 * H, 5 * H, 6 * H, { timeouts: 2 }))).toEqual(['6h00', 'timeout ×2']);
});

test('restarts and judge: integers, a half with one decimal; a range whose ends are equal shows the single value (#467)', () => {
  expect(text('score', s(4.5, 4, 5))).toEqual(['4,5', '4–5']);
  expect(text('score', s(4, 4, 4))).toEqual(['4', '4']);
  expect(text('time', s(22 * MIN, 22 * MIN, 22 * MIN))).toEqual(['22m', '22m']);
  expect(spreadText('score', { ...s(5, 4, 5), best: true }).isBest).toBe(true);
  setLanguage('en');
  expect(text('score', s(4.5, 4, 5))).toEqual(['4.5', '4–5']);
});

test('diff: signed counts with the locale grouping and the files by plural; ratios; an absent cell is a dash (#467)', () => {
  expect(diffText({ insertions: 4120, deletions: 610, files: 38 })).toEqual({ value: '+4.120 −610', sub: '38 arquivos', isBest: false });
  expect(diffText({ insertions: 3, deletions: 0, files: 1 }).sub).toBe('1 arquivo');
  expect(ratioText({ passed: 16, total: 18 })).toEqual({ value: '16/18', isBest: false });
  expect(ratioText({ passed: 17, total: 18, best: true }).isBest).toBe(true);
  expect(ratioText({ passed: 0, total: 0 }).value).toBe('—');
  expect([spreadText('tokens', {}).value, spreadText('cost', undefined).value, diffText(undefined).value, ratioText(undefined).value]).toEqual(['—', '—', '—', '—']);
  setLanguage('en');
  expect(diffText({ insertions: 4120, deletions: 610, files: 38 })).toEqual({ value: '+4,120 −610', sub: '38 files', isBest: false });
});
