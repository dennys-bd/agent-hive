import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WireError } from '../../src/read-model/normalize.js';
import { adfToMarkdown } from '../../src/sources/adf.js';
import { MAX_TEXT } from '../../src/field-values.js';
import { fieldRowsOf, jiraItemOf, linksOf, SPRINT_FIELD, storedKindOf, TEXTAREA_FIELD } from '../../src/sources/jira-item.js';
import type { JiraFieldDef, JiraIssue, JiraSchema } from '../../src/sources/jira-queries.js';

const SOURCE = 'jira:acme.example:acct-1';
const DESCRIPTION = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] };
const NAMES: Record<string, string> = {
  summary: 'Summary', status: 'Status', issuetype: 'Issue Type', priority: 'Priority', components: 'Components', labels: 'Labels',
  customfield_10001: 'Story Points', customfield_10002: 'Team', customfield_10003: 'Due', customfield_10004: 'Reviewer',
  customfield_10005: 'Notes', customfield_10020: 'Sprint', customfield_10030: 'Region', customfield_10040: 'Anything',
};
const SCHEMA: Record<string, JiraSchema> = {
  summary: { type: 'string' }, status: { type: 'status' }, issuetype: { type: 'issuetype' }, priority: { type: 'priority' },
  labels: { type: 'array', items: 'string' }, components: { type: 'array', items: 'component' }, assignee: { type: 'user' },
  customfield_10001: { type: 'number' }, customfield_10002: { type: 'option' }, customfield_10003: { type: 'date' },
  customfield_10004: { type: 'user' }, customfield_10005: { type: 'string' }, customfield_10020: { type: 'array', items: 'json' },
  customfield_10030: { type: 'option-with-child' }, customfield_10040: { type: 'any' },
};
const other = (id: string, key: string, title: string, category: string) => ({ id, key, fields: { summary: title, status: { statusCategory: { key: category } } } });
const issue = (fields: Record<string, unknown> = {}, extra: Partial<JiraIssue> = {}): JiraIssue => ({
  id: '10001', key: 'ABC-1',
  fields: {
    summary: 'Ship it', updated: '2026-11-16T07:00:00.000-0300', created: '2026-11-01T10:00:00.000+0000', description: DESCRIPTION,
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Story', hierarchyLevel: 0 },
    assignee: { displayName: 'Ana Lima' }, labels: ['api', 'ui'], parent: { id: '10000', key: 'ABC-0', fields: { summary: 'The epic' } },
    priority: { name: 'High' }, components: [{ name: 'Core' }, { name: 'Web' }],
    customfield_10001: 5, customfield_10002: { value: 'Platform' }, customfield_10003: '2026-11-20', customfield_10004: { displayName: 'Bea' },
    customfield_10005: null, customfield_10020: [{ id: 1, name: 'Sprint 3' }], customfield_10030: { value: 'EU', child: { value: 'PT' } },
    customfield_10040: { anything: true },
    issuelinks: [
      { id: 'L1', type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: other('10002', 'ABC-2', 'Two', 'new') },
      { id: 'L2', type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, inwardIssue: other('10003', 'ABC-3', 'Three', 'done') },
    ],
    ...fields,
  },
  ...extra,
});

test('an issue maps to its item: identity, UTC updatedAt, parent columns and data', () => {
  const { item } = jiraItemOf(SOURCE, 'ABC', issue(), NAMES, SCHEMA);
  assert.deepEqual({ ...item, valuesSig: '' }, {
    source: SOURCE, nodeId: '10001', scope: 'ABC', key: 'ABC-1', updatedAt: '2026-11-16T10:00:00.000Z', valuesSig: '',
    parentId: '10000', parentKey: 'ABC-0', parentTitle: 'The epic', contentId: null,
    data: {
      title: 'Ship it', body: adfToMarkdown(DESCRIPTION as Parameters<typeof adfToMarkdown>[0]), status: 'In Progress', statusCategory: 'indeterminate',
      issueType: 'Story', hierarchyLevel: 0, assignees: ['Ana Lima'], labels: ['api', 'ui'], createdAt: '2026-11-01T10:00:00.000Z',
      links: [
        { type: 'Blocks', direction: 'outward', phrase: 'blocks', linkId: 'L1', id: '10002', key: 'ABC-2', title: 'Two', statusCategory: 'new' },
        { type: 'Relates', direction: 'inward', phrase: 'relates to', linkId: 'L2', id: '10003', key: 'ABC-3', title: 'Three', statusCategory: 'done' },
      ],
    },
  });
  assert.equal(item.data.body, 'Hello');
});

test('field values follow the schema, one row per element in Jira\'s order, and skip what data holds, nulls and unknown kinds', () => {
  const { item, values } = jiraItemOf(SOURCE, 'ABC', issue(), NAMES, SCHEMA);
  assert.deepEqual(values, [
    { field: 'Issue Type', kind: 'option', value: 'Story' },
    { field: 'Priority', kind: 'option', value: 'High' },
    { field: 'Components', kind: 'option', value: 'Core' },
    { field: 'Components', kind: 'option', value: 'Web' },
    { field: 'Story Points', kind: 'number', value: '5' },
    { field: 'Team', kind: 'option', value: 'Platform' },
    { field: 'Due', kind: 'date', value: '2026-11-20T00:00:00.000Z' },
    { field: 'Reviewer', kind: 'text', value: 'Bea' },
  ]);
  assert.equal(item.valuesSig, JSON.stringify([...values].sort((a, b) => Number(a.field > b.field) - Number(a.field < b.field))));
});

test('an issue with only fields of unknown kinds is stored without them, never refused', () => {
  const bare = issue({ issuetype: undefined, priority: undefined, components: undefined, customfield_10001: undefined, customfield_10002: undefined,
    customfield_10003: undefined, customfield_10004: undefined });
  assert.deepEqual(jiraItemOf(SOURCE, 'ABC', bare, NAMES, SCHEMA).values, []);
  const unknownSchema = jiraItemOf(SOURCE, 'ABC', issue({ customfield_10099: 'x' }), NAMES, SCHEMA).values;
  assert.equal(unknownSchema.some((v) => v.value === 'x'), false, 'a field the page gave no schema for gives no row');
});

test('a value of the wrong shape gives no row', () => {
  const { values } = jiraItemOf(SOURCE, 'ABC', issue({ customfield_10003: 'soon', customfield_10002: { id: '1' }, customfield_10001: 'five' }), NAMES, SCHEMA);
  assert.deepEqual(values.filter((v) => ['Due', 'Team', 'Story Points'].includes(v.field)), []);
});

test('a missing description, assignee, parent, links and level read as empty, not as an error', () => {
  const { item } = jiraItemOf(SOURCE, 'ABC', issue({ description: null, assignee: null, parent: undefined, issuelinks: undefined, issuetype: { name: 'Task' } }), NAMES, SCHEMA);
  assert.deepEqual([item.data.body, item.data.assignees, item.parentId, item.parentKey, item.parentTitle, item.data.links, item.data.hierarchyLevel],
    ['', [], null, null, null, [], null]);
});

test('an issue without an id, a key or updated is refused with a wire error', () => {
  assert.throws(() => jiraItemOf(SOURCE, 'ABC', issue({}, { id: undefined }), NAMES, SCHEMA), WireError);
  assert.throws(() => jiraItemOf(SOURCE, 'ABC', issue({}, { key: undefined }), NAMES, SCHEMA), /jira issue key/);
  assert.throws(() => jiraItemOf(SOURCE, 'ABC', issue({ updated: undefined }), NAMES, SCHEMA), /jira issue updated/);
  assert.throws(() => jiraItemOf(SOURCE, 'ABC', issue({ updated: 'yesterday' }), NAMES, SCHEMA), /jira issue updated/);
});

test('linksOf skips a link with no type, no other issue or no link id, and a missing phrase reads as the type\'s name (#828)', () => {
  const links = linksOf(issue({ issuelinks: [
    { id: '20002', type: { name: 'Blocks' }, outwardIssue: other('10002', 'ABC-2', 'Two', 'new') },
    { id: '20004', type: {}, outwardIssue: other('10004', 'ABC-4', 'Four', 'new') },
    { id: '20005', type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' } },
    { type: { name: 'Blocks' }, outwardIssue: other('10006', 'ABC-6', 'Six', 'new') },
  ] }));
  assert.deepEqual(links, [{ type: 'Blocks', direction: 'outward', phrase: 'Blocks', linkId: '20002', id: '10002', key: 'ABC-2', title: 'Two', statusCategory: 'new' }]);
});

test('fieldRowsOf puts Status first with the statuses, then each field the mapping knows, by kind', () => {
  const rows = fieldRowsOf([
    { id: 'summary', name: 'Summary', schema: { type: 'string' } },
    { id: 'issuetype', name: 'Issue Type', schema: { type: 'issuetype' } },
    { id: 'customfield_10001', name: 'Story Points', schema: { type: 'number' } },
    { id: 'components', name: 'Components', schema: { type: 'array', items: 'component' } },
    { id: 'customfield_10020', name: 'Sprint', schema: { type: 'array', items: 'json' } },
    { id: 'thumbnail', name: 'Images', schema: null },
  ], [{ name: 'To Do', category: 'new' }, { name: 'Done', category: 'done' }]);
  assert.deepEqual(rows, [
    { name: 'Status', kind: 'option', options: ['To Do', 'Done'] },
    { name: 'Issue Type', kind: 'option', options: null },
    { name: 'Story Points', kind: 'number', options: null },
    { name: 'Components', kind: 'option', options: null },
  ]);
});

test('storedKindOf names the kind the sync stores a field under, and none for an own field, no schema or an unknown kind (#821)', () => {
  const cases: [JiraFieldDef, string | undefined][] = [
    [{ id: 'customfield_1', name: 'Team', schema: { type: 'option' } }, 'option'],
    [{ id: 'components', name: 'Components', schema: { type: 'array', items: 'component' } }, 'option'],
    [{ id: 'customfield_2', name: 'Points', schema: { type: 'number' } }, 'number'],
    [{ id: 'summary', name: 'Summary', schema: { type: 'string' } }, undefined],
    [{ id: 'customfield_3', name: 'Sprint', schema: { type: 'array', items: 'json' } }, undefined],
    [{ id: 'thumbnail', name: 'Images', schema: null }, undefined],
  ];
  for (const [field, kind] of cases) assert.equal(storedKindOf(field), kind, field.id);
});

test('a sprint stores its open sprint\'s name, else its last; a textarea its Markdown cut to MAX_TEXT; a multi-user picker one row per user (#826)', () => {
  const names = { customfield_20: 'Sprint', customfield_21: 'Notes', customfield_22: 'Reviewers' };
  const schema: Record<string, JiraSchema> = {
    customfield_20: { type: 'array', items: 'json', custom: SPRINT_FIELD }, customfield_21: { type: 'string', custom: TEXTAREA_FIELD }, customfield_22: { type: 'array', items: 'user' },
  };
  const ours = (fields: Record<string, unknown>) => jiraItemOf(SOURCE, 'ABC', issue(fields), names, schema).values.filter((v) => Object.values(names).includes(v.field));
  assert.deepEqual(ours({
    customfield_20: [{ id: 7, name: 'Sprint 7', state: 'closed' }, { id: 8, name: 'Sprint 8', state: 'active' }],
    customfield_21: DESCRIPTION, customfield_22: [{ displayName: 'Ana Lima' }, { displayName: 'Bea' }],
  }), [
    { field: 'Sprint', kind: 'option', value: 'Sprint 8' }, { field: 'Notes', kind: 'text', value: 'Hello' },
    { field: 'Reviewers', kind: 'text', value: 'Ana Lima' }, { field: 'Reviewers', kind: 'text', value: 'Bea' },
  ]);
  const long = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(MAX_TEXT + 5) }] }] };
  assert.deepEqual(ours({ customfield_20: [{ id: 6, name: 'Sprint 6', state: 'closed' }, { id: 7, name: 'Sprint 7', state: 'closed' }], customfield_21: long }), [
    { field: 'Sprint', kind: 'option', value: 'Sprint 7' }, { field: 'Notes', kind: 'text', value: 'x'.repeat(MAX_TEXT) },
  ]);
});
