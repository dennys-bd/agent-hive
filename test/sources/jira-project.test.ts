import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNotConnected } from '../../src/source-errors.js';
import { STATUS } from '../../src/field-values.js';
import type { SourceField, SourceItemValue } from '../../src/read-model/source-items.js';
import { viewFields, viewStatuses } from '../../src/sources/jira-project.js';
import type { FilterRule } from '../../src/types.js';
import { adapter, fakeJira, issue, seeded } from './jira-fakes.js';

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

const COMPONENTS = { id: 'components', name: 'Components', schema: { type: 'array', items: 'component' } };
const EPIC = { name: 'Epic', hierarchyLevel: 1 };
const STORY = { name: 'Story', hierarchyLevel: 0 };

test('project answers from the read model alone: the statuses, the stored fields, the built-ins first, every issue of the project by key, uncited and filtered ones too (#827)', async () => {
  const db = await seeded([issue(12, 'To Do'), issue(2, 'Done', { labels: ['other'] }), issue(9, 'In Progress', { components: [{ name: 'Web' }] })], [COMPONENTS]);
  const fake = fakeJira();
  const filter: FilterRule[] = [{ field: 'label', op: 'any', values: ['api'] }];
  const view = await adapter({ call: fake.call, db, source: { filter } }).project!();
  assert.deepEqual(view.statuses, [{ name: 'To Do' }, { name: 'In Progress' }, { name: 'Done' }]);
  assert.deepEqual(view.fields, [{ name: 'Components', type: 'singleSelect', options: ['Core', 'Web'] }]);
  assert.deepEqual([view.builtins, view.truncated], [{ status: 0, labels: 0, assignees: 0 }, false]);
  assert.deepEqual(view.items.map((i) => [i.itemId, i.id, i.status, i.url, i.out]), [
    ['10002', 'ABC-2', 'Done', 'https://acme.example/browse/ABC-2', 'filter'],
    ['10009', 'ABC-9', 'In Progress', 'https://acme.example/browse/ABC-9', undefined],
    ['10012', 'ABC-12', 'To Do', 'https://acme.example/browse/ABC-12', undefined],
  ]);
  assert.deepEqual(fake.sent, [], 'the plain read makes no call to Jira');
});

test('under epics: hide a parent is out as epic and its child stays, named by its parent\'s key (#827)', async () => {
  const db = await seeded([issue(1, 'To Do', { issuetype: EPIC }), issue(2, 'To Do', { issuetype: STORY, parent: { id: '10001', key: 'ABC-1' } })]);
  const view = await adapter({ db, source: { tree: { epics: true, subtasks: false }, epics: 'hide' } }).project!();
  assert.deepEqual(view.items.map((i) => [i.id, i.out, i.parent]), [['ABC-1', 'epic', undefined], ['ABC-2', undefined, 'ABC-1']]);
});

test('fresh runs a round and the reconcile before reading: an issue Jira no longer lists goes, a new status shows (#827)', async () => {
  const db = await seeded([issue(1, 'To Do'), issue(2, 'To Do')]);
  const statuses = [{ name: 'Story', statuses: ['To Do', 'Blocked', 'Done'].map((name) => ({ name, statusCategory: { key: 'new' } })) }];
  const fake = fakeJira({
    'POST /search/jql': [{ issues: [], isLast: true }, { issues: [{ id: '10001' }], isLast: true }],
    'GET /field': [[], []], 'GET /project/ABC/statuses': [statuses, statuses],
  });
  const view = await adapter({ call: fake.call, db }).project!({ fresh: true });
  assert.equal(fake.sent.filter((k) => k === 'POST /search/jql').length, 2, 'one search for the round, one for the reconcile');
  assert.deepEqual(view.statuses.map((s) => s.name), ['To Do', 'Blocked', 'Done']);
  assert.deepEqual(view.items.map((i) => i.id), ['ABC-1']);
});

test('without a read model the adapter has no project; without a credential it rejects not connected (#827)', async () => {
  assert.equal(adapter({}).project, undefined);
  await assert.rejects(adapter({ db: await seeded([issue(1, 'To Do')]), cred: null }).project!(), (err: unknown) => isNotConnected(err));
});
