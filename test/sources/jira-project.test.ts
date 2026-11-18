import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATUS } from '../../src/field-values.js';
import type { SourceField, SourceItemValue } from '../../src/read-model/source-items.js';
import { viewFields, viewStatuses } from '../../src/sources/jira-project.js';

const FIELDS: SourceField[] = [
  { name: STATUS, kind: 'option', options: ['To Do', 'In Progress', 'Done'] },
  { name: 'Components', kind: 'option', options: null }, { name: 'Points', kind: 'number', options: null },
  { name: 'Due', kind: 'date', options: null }, { name: 'Notes', kind: 'text', options: null },
  { name: 'Sprint', kind: 'iteration', options: null }, { name: 'Odd', kind: 'weird', options: null },
  { name: 'Unread', kind: null, options: null }, { name: 'Team', kind: 'option', options: null },
];
const valued = (...pairs: [string, string][]): { values: SourceItemValue[] } => ({ values: pairs.map(([field, value]) => ({ field, kind: 'option', value })) });

test('the statuses are the stored Status options in their order; with no Status row there are none (#827)', () => {
  assert.deepEqual(viewStatuses(FIELDS), [{ name: 'To Do' }, { name: 'In Progress' }, { name: 'Done' }]);
  assert.deepEqual(viewStatuses(FIELDS.slice(1)), []);
});

test('every stored field but Status in its order, each with its kind; a choice field\'s options are its stored values, split and sorted as the table sorts (#827)', () => {
  const stored = [
    valued(['Components', 'web'], ['Components', 'Core'], ['Sprint', 'Sprint 10']),
    valued(['Components', 'Core'], ['Components', 'api 2'], ['Sprint', 'Sprint 9']),
    valued(['Components', 'api 10']),
  ];
  assert.deepEqual(viewFields(FIELDS, stored), [
    { name: 'Components', type: 'singleSelect', options: ['api 2', 'api 10', 'Core', 'web'] },
    { name: 'Points', type: 'number' }, { name: 'Due', type: 'date' }, { name: 'Notes', type: 'text' },
    { name: 'Sprint', type: 'iteration', options: ['Sprint 9', 'Sprint 10'] },
    { name: 'Odd', type: 'other' }, { name: 'Unread', type: 'other' }, { name: 'Team', type: 'singleSelect' },
  ]);
});
