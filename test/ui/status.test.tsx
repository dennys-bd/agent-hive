import { expect, test } from 'vitest';
import { mostUrgent, STATUS_BORDER, STATUS_TINT } from '@/lib/status';
import type { Worker, Status } from '../../src/types';

const at = (status: Status): Worker => ({ id: status, status });

test('mostUrgent answers empty with no occupied worker', () => {
  expect(mostUrgent([])).toBe('empty');
});

test('mostUrgent ranks waiting > approval > review > backoff > working, whatever order the workers come in (#229, #805)', () => {
  expect(mostUrgent([at('working'), at('waiting')])).toBe('waiting');
  expect(mostUrgent([at('waiting'), at('approval')])).toBe('waiting');
  expect(mostUrgent([at('approval'), at('review')])).toBe('approval');
  expect(mostUrgent([at('backoff'), at('review')])).toBe('review');
  expect(mostUrgent([at('working'), at('backoff')])).toBe('backoff');
  expect(mostUrgent([at('working')])).toBe('working');
});

test('STATUS_BORDER and STATUS_TINT carry one literal Tailwind class per status, so the scanner picks up every one', () => {
  for (const status of ['empty', 'working', 'waiting', 'review', 'approval', 'backoff'] as const) {
    expect(STATUS_BORDER[status]).toBe(`border-${status}`);
    expect(STATUS_TINT[status]).toBe(`bg-${status}/20`);
  }
});
