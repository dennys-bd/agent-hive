import { expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { columnLabel, defaultColumns, openFirst, projectColumns } from '@/lib/project-columns';
import type { BlockerRef } from '../../src/types';

test('projectColumns puts blocked by, 112px, after the issue\'s dates and before PR; defaultColumns keeps it; its label in both languages (#61)', () => {
  const columns = projectColumns({ fields: [{ name: 'Priority', type: 'singleSelect' }], builtins: {} });
  expect(columns.slice(-5).map((c) => [c.key, c.width])).toEqual([['created', 72], ['updated', 72], ['closed', 72], ['blockedBy', 112], ['pr', 104]]);
  expect(defaultColumns(columns)).toContain('blockedBy');
  const blockedBy = columns.find((c) => c.key === 'blockedBy')!;
  setLanguage('en');
  expect(columnLabel(blockedBy)).toBe('blocked by');
  setLanguage('pt');
  expect(columnLabel(blockedBy)).toBe('bloqueada por');
});

test('openFirst puts the open refs before the closed ones, each in GitHub\'s order, without touching the list (#61)', () => {
  const refs: BlockerRef[] = [{ id: '521', title: 'a', state: 'closed' }, { id: '274', title: 'b', state: 'open' }, { id: '9', title: 'c', state: 'closed' }, { id: '7', title: 'd', state: 'open' }];
  expect(openFirst(refs).map((r) => r.id)).toEqual(['274', '7', '521', '9']);
  expect(refs.map((r) => r.id)).toEqual(['521', '274', '9', '7']);
});
