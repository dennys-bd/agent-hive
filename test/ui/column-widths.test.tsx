import { expect, test } from 'vitest';
import { clampWidth, dividerOffsets, gridTemplate, parseWidths, tableMinWidth, withWidths } from '@/lib/column-widths';

const TWO = [{ key: 'status', width: 128 }, { key: 'labels', width: 136 }];

test('gridTemplate: the title fluid from 160px, each column at its width, then the trailing column when given (#59)', () => {
  expect(gridTemplate(TWO, 76)).toBe('minmax(160px,1fr) 128px 136px 76px');
  expect(gridTemplate(TWO)).toBe('minmax(160px,1fr) 128px 136px');
  expect(gridTemplate([])).toBe('minmax(160px,1fr)');
});

test('tableMinWidth: the title at its least, every width, a gap before each track and both paddings (#59)', () => {
  expect(tableMinWidth(TWO, 76)).toBe(160 + 128 + 136 + 76 + 3 * 12 + 24); // 560
  expect(tableMinWidth(TWO)).toBe(160 + 128 + 136 + 2 * 12 + 24); // 472
});

test('dividerOffsets: each column\'s left edge from the right, centred on its gap (the handoff\'s table()) (#59)', () => {
  expect(dividerOffsets(TWO, 76)).toEqual([382, 242]); // 18 + 2×12 + 340; 18 + 12 + 212
  expect(dividerOffsets(TWO)).toEqual([294, 154]); // 18 + 12 + 264; 18 + 136
  expect(dividerOffsets([], 76)).toEqual([]);
});

test('clampWidth: whole px within 40–480 (#59)', () => {
  expect([39, 40, 480, 481, 100.6].map(clampWidth)).toEqual([40, 40, 480, 480, 101]);
});

test('withWidths: a saved width replaces the default, clamped; an unknown key is ignored; the input is not mutated (#59)', () => {
  expect(withWidths(TWO, { status: 5000, gone: 90 })).toEqual([{ key: 'status', width: 480 }, { key: 'labels', width: 136 }]);
  expect(TWO[0].width).toBe(128);
});

test('parseWidths: a record of numbers reads as is; one with a non-number, or no record, is undefined (#59)', () => {
  expect(parseWidths({ status: 140 })).toEqual({ status: 140 });
  for (const value of [{ status: '140' }, [140], null, 'x', undefined]) expect(parseWidths(value)).toBeUndefined();
});
