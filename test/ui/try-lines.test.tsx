// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx
import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { exhaustedOf, recordsOf } from '@/lib/try-lines';
import type { Task, Transition, TryRecord } from '../../src/types';
import { taskPairOf } from '../fixtures/work';

const BACK: Transition = { from: 'checks', to: 'build', when: 'verdict', verdict: 'failed', maxTries: 3 };
const KEY = '["checks","verdict","failed"]';
const TASK: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'checks', boardColumn: '', auto: true };
const rec = (n: number, at: string, transition = KEY): TryRecord => ({ transition, n, max: 3, cause: 'lint', error: '', at, stage: 'build' });
// The task's activity, holding `error` when given, under the flow's one transition
function graph(error?: string) {
  const { activity, records } = taskPairOf('I1', error === undefined ? {} : { error });
  return { transitions: [BACK], activities: [activity], activityRecords: records };
}

beforeEach(() => setLanguage('pt'));

test('recordsOf keeps the key\'s records, newest first by at and then by n; every record without a key; none without a log (#916)', () => {
  const log = [rec(1, '2026-10-11T10:00:00.000Z'), rec(1, '2026-10-11T10:05:00.000Z', 'other'), rec(2, '2026-10-11T10:10:00.000Z'), rec(3, '2026-10-11T10:10:00.000Z')];
  expect(recordsOf({ tryLog: log }, KEY).map((r) => r.n)).toEqual([3, 2, 1]);
  expect(recordsOf({ tryLog: log }).map((r) => r.transition)).toEqual([KEY, KEY, 'other', KEY]);
  expect(recordsOf(undefined)).toEqual([]);
  expect(log.map((r) => r.n)).toEqual([1, 1, 2, 3]); // the log itself is left as it was
});

test('exhaustedOf names the spent transition, its trigger, its limit and its destination; undefined for a non-TRIES_OUT error, no error or a gone transition (#916)', () => {
  expect(exhaustedOf(graph('tries out: verdict:failed · 3'), TASK)).toEqual({ transition: BACK, trigger: 'falhou', max: 3, destination: 'build' });
  expect(exhaustedOf(graph('no transition: verdict:failed'), TASK)).toBeUndefined();
  expect(exhaustedOf(graph(), TASK)).toBeUndefined();
  expect(exhaustedOf({ ...graph('tries out: verdict:failed · 3'), transitions: [] }, TASK)).toBeUndefined();
});
