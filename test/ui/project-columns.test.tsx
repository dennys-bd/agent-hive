import { expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { ACTION_WIDTH, columnLabel, defaultColumns, hiveColumns, openFirst, projectColumns } from '@/lib/project-columns';
import { hiveProject } from '../../src/hive-project';
import type { BlockerRef, ProjectField } from '../../src/types';

test('projectColumns puts blocked by, 112px, after the issue\'s dates and before PR; defaultColumns leaves it hidden; its label in both languages (#61)', () => {
  const columns = projectColumns({ fields: [{ name: 'Priority', type: 'singleSelect' }], builtins: {} });
  expect(columns.slice(-5).map((c) => [c.key, c.width])).toEqual([['created', 72], ['updated', 72], ['closed', 72], ['blockedBy', 112], ['pr', 104]]);
  expect(defaultColumns(columns)).not.toContain('blockedBy'); // #583: hidden with nothing saved
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

test('with nothing saved: status, labels, every milestone and progress field by kind, whatever its name, and PR; assignees, blocked by, the dates and every other kind start hidden (#583)', () => {
  const fields: ProjectField[] = [
    { name: 'Priority', type: 'singleSelect' }, { name: 'Marco', type: 'milestone' }, { name: 'Sub-issues progress', type: 'progress' },
    { name: 'Notes', type: 'text' }, { name: 'Due', type: 'date' }, { name: 'Progresso', type: 'progress' }, { name: 'Sprint', type: 'iteration' },
  ];
  const columns = projectColumns({ fields, builtins: { status: 0, labels: 0, assignees: 0 } });
  expect(defaultColumns(columns)).toEqual(['status', 'labels', 'field:Marco', 'field:Sub-issues progress', 'field:Progresso', 'pr']);
});

test('the hive\'s columns are status, its Workspace text field and PR; the task column is 150px (#583)', () => {
  const view = hiveProject({ flows: [], tasks: [], activityRecords: [] });
  expect(hiveColumns(view).map((c) => [c.key, c.width])).toEqual([['status', 128], ['field:Workspace', 120], ['pr', 104]]);
  expect(ACTION_WIDTH).toBe(150);
});
