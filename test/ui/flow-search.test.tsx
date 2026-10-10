import { expect, test } from 'vitest';
import { matchesSearch } from '@/lib/flow-search';
import type { WithWork } from '../fixtures/work';

const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I12', id: '12', title: 'Fix the Pager', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});

// #629: the branch is the live activity's, which the caller reads
const matches = (c: WithWork, term: string): boolean => matchesSearch(c, c.branch ?? '', term);

test('matchesSearch finds the title, the number and the branch, in any case; a blank term matches every task (#542)', () => {
  expect(matches(task(), 'pager')).toBe(true);
  expect(matches(task(), 'FIX THE')).toBe(true);
  expect(matches(task(), '#12')).toBe(true);
  expect(matches(task(), '12')).toBe(true);
  expect(matches(task({ branch: 'hive/12-fix-the-pager' }), 'HIVE/12')).toBe(true);
  expect(matches(task(), 'hive/12')).toBe(false); // no branch yet
  expect(matches(task({ created: true, item: { ...task().item, id: 'HIVE-3' } }), 'hive-3')).toBe(true);
  expect(matches(task(), 'nope')).toBe(false);
  expect(matches(task(), '')).toBe(true);
  expect(matches(task(), '   ')).toBe(true);
});
