import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemFields, readItemFields, writeItemField, writesFor, type FieldsContext } from '../../src/sources/github-fields.js';
import {
  assigneesMutation, CLEAR_FIELD, CLEAR_ISSUE_TYPE, CLEAR_MILESTONE, ITEM_FIELDS, PROJECT_FIELDS, SET_DATE, SET_ISSUE_TYPE, SET_ITERATION, SET_MILESTONE, SET_NUMBER,
  SET_OPTION, SET_TEXT, type GhItemFieldsNode, type GhItemNode, type GhProjectField,
} from '../../src/sources/github-queries.js';
import { PartialWriteError } from '../../src/field-values.js';
import { parseConfig } from '../../src/config.js';
import { createSource, sourceSpec } from '../../src/source.js';
import type { Gql, SourceItem, TaskFilter } from '../../src/types.js';
import { combConfig, FILTER, FIXED } from '../fakes.js';

// One item's fields as GitHub answers them (#686): what the editors read, which mutations a write sends with which ids, and the re-read.

const FIELDS: GhProjectField[] = [
  { id: 'F_title', name: 'Title', dataType: 'TITLE' },
  { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'O_ready', name: 'Ready' }, { id: 'O_rev', name: 'In review' }, { id: 'O_done', name: 'Done' }] },
  { id: 'F_assignees', name: 'Assignees', dataType: 'ASSIGNEES' },
  { id: 'F_labels', name: 'Labels', dataType: 'LABELS' },
  { id: 'F_prio', name: 'Priority', dataType: 'SINGLE_SELECT', options: [{ id: 'O_p0', name: 'P0' }, { id: 'O_p1', name: 'P1' }] },
  { id: 'F_notes', name: 'Notes', dataType: 'TEXT' },
  { id: 'F_est', name: 'Estimate', dataType: 'NUMBER' },
  { id: 'F_due', name: 'Due', dataType: 'DATE' },
  { id: 'F_sprint', name: 'Sprint', dataType: 'ITERATION', configuration: { iterations: [{ id: 'IT_1', title: 'Sprint 1' }, { id: 'IT_2', title: 'Sprint 2' }] } },
  { id: 'F_ms', name: 'Milestone', dataType: 'MILESTONE' },
  { id: 'F_type', name: 'Type', dataType: 'ISSUE_TYPE' },
  { id: 'F_repo', name: 'Repository', dataType: 'REPOSITORY' },
  { id: 'F_prog', name: 'Progress', dataType: 'SUB_ISSUES_PROGRESS' },
  { id: 'F_rev', name: 'Reviewers', dataType: 'REVIEWERS' },
];
type Content = NonNullable<GhItemNode['content']>;
// Issue #12 in Ready, P1, Estimate 3, Sprint 1, milestone v1, assigned to ana; its repository's choices beside it
const fieldsNode = (extra: Partial<GhItemFieldsNode> = {}, content: Partial<Content> = {}): GhItemFieldsNode => ({
  id: 'PVTI_1',
  project: { id: 'PVT_1', fields: { nodes: FIELDS } },
  fieldValueByName: { name: 'Ready' },
  fieldValues: { nodes: [{ name: 'Ready', field: { name: 'Status' } }, { name: 'P1', field: { name: 'Priority' } }, { number: 3, field: { name: 'Estimate' } }, { title: 'Sprint 1', field: { name: 'Sprint' } }] },
  content: {
    __typename: 'Issue', id: 'I_1', number: 12, title: 'Pager breaks', body: 'b', url: 'https://github.com/acme/site/issues/12',
    assignees: { nodes: [{ id: 'U_ana', login: 'ana' }] }, labels: { nodes: [] }, milestone: { id: 'M_1', title: 'v1' }, issueType: null,
    repository: {
      nameWithOwner: 'acme/site',
      assignableUsers: { nodes: [{ id: 'U_ana', login: 'ana' }, { id: 'U_bia', login: 'bia' }] },
      milestones: { nodes: [{ id: 'M_1', title: 'v1' }, { id: 'M_2', title: 'v2' }] },
      issueTypes: { nodes: [{ id: 'T_bug', name: 'Bug' }] },
    },
    ...content,
  },
  ...extra,
});

const STATUS_OPTIONS = ['Ready', 'In progress', 'In review', 'Done'].map((name) => ({ id: `O_${name}`, name }));
interface ItemCall { query: string; variables?: Record<string, string | number | boolean> }
// A Gql over the item's reads, in order; every other call (a mutation, the relations query) answers {}, as the writes read nothing back
function itemGql(reads: GhItemFieldsNode[]): { gql: Gql; calls: ItemCall[] } {
  const queue = [...reads];
  const calls: ItemCall[] = [];
  const gql: Gql = async (query, variables) => {
    calls.push({ query, variables });
    if (query === PROJECT_FIELDS) return { repositoryOwner: { projectV2: { id: 'PVT_1', field: { id: 'F_status', options: STATUS_OPTIONS } } } };
    return query === ITEM_FIELDS ? { node: queue.shift() } : {};
  };
  return { gql, calls };
}
const PROJECT = 'PVT_1';
const READ = { login: 'acme', number: 6, notFound: 'source not found', filter: [], me: undefined, epics: 'queue' as const, taskProps: FIXED };
const IDS = { projectId: 'PVT_1', itemId: 'PVTI_1' };

test('itemFields lists Status, the assignees and every shown field in the project\'s order, each with its value and choices; the read-only kinds flagged (#686)', () => {
  assert.deepEqual(itemFields(fieldsNode()), [
    { name: 'Status', type: 'singleSelect', value: 'Ready', options: ['Ready', 'In review', 'Done'] },
    { name: 'Assignees', type: 'assignees', value: ['ana'], options: ['ana', 'bia'] },
    { name: 'Priority', type: 'singleSelect', value: 'P1', options: ['P0', 'P1'] },
    { name: 'Notes', type: 'text', value: null },
    { name: 'Estimate', type: 'number', value: 3 },
    { name: 'Due', type: 'date', value: null },
    { name: 'Sprint', type: 'iteration', value: 'Sprint 1', options: ['Sprint 1', 'Sprint 2'] },
    { name: 'Milestone', type: 'milestone', value: 'v1', options: ['v1', 'v2'] },
    { name: 'Type', type: 'issueType', value: null, options: ['Bug'] },
    { name: 'Repository', type: 'repository', value: 'acme/site', readOnly: true },
    { name: 'Progress', type: 'progress', value: null, readOnly: true },
    { name: 'Reviewers', type: 'other', value: null, readOnly: true },
  ]);
});

test('writesFor maps each kind to its mutation with the ids its names resolve to; null clears (#686)', () => {
  const node = fieldsNode();
  const cases: [string, Parameters<typeof writesFor>[2], unknown][] = [
    ['Status', 'Done', [{ query: SET_OPTION, variables: { ...IDS, fieldId: 'F_status', singleSelectOptionId: 'O_done' } }]],
    ['Priority', 'P0', [{ query: SET_OPTION, variables: { ...IDS, fieldId: 'F_prio', singleSelectOptionId: 'O_p0' } }]],
    ['Notes', 'hello', [{ query: SET_TEXT, variables: { ...IDS, fieldId: 'F_notes', text: 'hello' } }]],
    ['Estimate', 5, [{ query: SET_NUMBER, variables: { ...IDS, fieldId: 'F_est', number: 5 } }]],
    ['Due', '2026-10-20', [{ query: SET_DATE, variables: { ...IDS, fieldId: 'F_due', date: '2026-10-20' } }]],
    ['Sprint', 'Sprint 2', [{ query: SET_ITERATION, variables: { ...IDS, fieldId: 'F_sprint', iterationId: 'IT_2' } }]],
    ['Priority', null, [{ query: CLEAR_FIELD, variables: { ...IDS, fieldId: 'F_prio' } }]],
    ['Milestone', 'v2', [{ query: SET_MILESTONE, variables: { issueId: 'I_1', milestoneId: 'M_2' } }]],
    ['Milestone', null, [{ query: CLEAR_MILESTONE, variables: { issueId: 'I_1' } }]],
    ['Type', 'Bug', [{ query: SET_ISSUE_TYPE, variables: { issueId: 'I_1', issueTypeId: 'T_bug' } }]],
    ['Type', null, [{ query: CLEAR_ISSUE_TYPE, variables: { issueId: 'I_1' } }]],
  ];
  for (const [field, value, expected] of cases) assert.deepEqual(writesFor(node, field, value), expected, `${field}=${String(value)}`);
});

test('writesFor sends the assignees\' difference only: who is added, who is removed, nothing when the set is the same (#686)', () => {
  assert.deepEqual(writesFor(fieldsNode(), 'Assignees', ['bia']), [
    { query: assigneesMutation('addAssigneesToAssignable', 1), variables: { assignableId: 'I_1', u0: 'U_bia' } },
    { query: assigneesMutation('removeAssigneesFromAssignable', 1), variables: { assignableId: 'I_1', u0: 'U_ana' } },
  ]);
  assert.deepEqual(writesFor(fieldsNode(), 'Assignees', ['ana']), []);
  assert.deepEqual(writesFor(fieldsNode(), 'Assignees', []), [{ query: assigneesMutation('removeAssigneesFromAssignable', 1), variables: { assignableId: 'I_1', u0: 'U_ana' } }]);
  assert.match(assigneesMutation('addAssigneesToAssignable', 2), /\$u0: ID!, \$u1: ID!/);
});

test('writesFor throws before anything is sent on a name with no match, a read-only kind or a value of another type (#686)', () => {
  const node = fieldsNode();
  const refusals: [string, Parameters<typeof writesFor>[2], string][] = [
    ['Nope', 'x', '"Nope" is not a field of the project'],
    ['Priority', 'P9', '"P9" is not an option of "Priority"'],
    ['Sprint', 'Sprint 9', '"Sprint 9" is not an iteration of "Sprint"'],
    ['Milestone', 'v9', '"v9" is not an open milestone'],
    ['Type', 'Task', '"Task" is not an issue type of the repository'],
    ['Assignees', ['zoe'], '"zoe" is not an assignable user'],
    ['Repository', 'acme/x', '"Repository" is read only'],
    ['Title', 'x', '"Title" is read only'],
    ['Estimate', '5', '"Estimate" takes a number'],
  ];
  for (const [field, value, message] of refusals) assert.throws(() => writesFor(node, field, value), { message }, field);
});

test('writeItemField reads, sends the mutation, re-reads: the fields and the row are the re-read item\'s, the entry the poll\'s step answers (#686)', async () => {
  const { gql, calls } = itemGql([fieldsNode(), fieldsNode({ fieldValueByName: { name: 'In review' } }, { title: 'Renamed' })]);
  const entry: SourceItem = { item: { itemId: 'PVTI_1', id: '12', title: 'Renamed', body: 'b', url: 'https://github.com/acme/site/issues/12' }, column: 'In review' };
  const ctx: FieldsContext = { gql, projectId: PROJECT, read: READ, entry: async () => entry };
  const written = await writeItemField(ctx, 'PVTI_1', 'Status', 'In review');
  assert.deepEqual(calls.map((c) => c.query), [ITEM_FIELDS, SET_OPTION, ITEM_FIELDS]);
  assert.deepEqual([written.row.itemId, written.row.title, written.row.status], ['PVTI_1', 'Renamed', 'In review']);
  assert.equal(written.fields[0].value, 'In review');
  assert.equal(written.entry, entry);
  const none = await writeItemField({ ...ctx, gql: itemGql([fieldsNode(), fieldsNode()]).gql, entry: async () => undefined }, 'PVTI_1', 'Priority', 'P0');
  assert.equal('entry' in none, false);
});

test('writeItemField sends nothing on a refused name, and an id that is no project item is not on the source (#686)', async () => {
  const { gql, calls } = itemGql([fieldsNode()]);
  await assert.rejects(writeItemField({ gql, projectId: PROJECT, read: READ, entry: async () => undefined }, 'PVTI_1', 'Priority', 'P9'), { message: '"P9" is not an option of "Priority"' });
  assert.deepEqual(calls.map((c) => c.query), [ITEM_FIELDS]);
  await assert.rejects(readItemFields(async () => ({ node: {} }), 'PVTI_X', PROJECT), { message: 'item PVTI_X is not on the source' });
});

// The GitHub source over STAGES (board cites Ready, In progress, In review) with these filter rules
const specOf = (filter: TaskFilter = FILTER) => {
  const config = parseConfig(combConfig({ source: { type: 'github', owner: 'acme', number: 6, filter } }));
  return sourceSpec(config, config.comb.sources[0]);
};

// The source with its project resolved, as the server has it before any route runs
const resolved = async (spec: ReturnType<typeof specOf>, gql: Gql): Promise<ReturnType<typeof createSource>> => {
  const source = createSource(spec, { gql });
  await source.resolveFields();
  return source;
};

test('the GitHub source answers an item\'s fields from one read (#686)', async () => {
  const { gql, calls } = itemGql([fieldsNode()]);
  assert.deepEqual(await (await resolved(specOf(), gql)).fieldsOf?.('PVTI_1'), itemFields(fieldsNode()));
  assert.deepEqual(calls.filter((c) => c.query === ITEM_FIELDS).map((c) => c.variables), [{ itemId: 'PVTI_1' }]);
});

test('the GitHub source\'s setField re-reads the item through the poll\'s own steps: listed, it has an entry; out of the filter or in an uncited column, none (#686)', async () => {
  const listed = await (await resolved(specOf(), itemGql([fieldsNode(), fieldsNode()]).gql)).setField?.('PVTI_1', 'Priority', 'P0');
  assert.deepEqual([listed?.entry?.item.itemId, listed?.entry?.item.id, listed?.entry?.column, listed?.row.out], ['PVTI_1', '12', 'Ready', undefined]);
  const filter: TaskFilter = [{ field: 'label', op: 'any', values: ['hive'] }];
  const filtered = await (await resolved(specOf(filter), itemGql([fieldsNode(), fieldsNode()]).gql)).setField?.('PVTI_1', 'Priority', 'P0');
  assert.deepEqual([filtered?.entry, filtered?.row.out], [undefined, 'filter']);
  const moved = await (await resolved(specOf(), itemGql([fieldsNode(), fieldsNode({ fieldValueByName: { name: 'Done' } })]).gql)).setField?.('PVTI_1', 'Status', 'Done');
  assert.deepEqual([moved?.entry, moved?.row.status], [undefined, 'Done']);
});

test('an item of another project is refused before any mutation, by the fields read and by the write (#686)', async () => {
  const foreign = fieldsNode({ project: { id: 'PVT_OTHER', fields: { nodes: FIELDS } } });
  const { gql, calls } = itemGql([foreign]);
  await assert.rejects(writeItemField({ gql, projectId: PROJECT, read: READ, entry: async () => undefined }, 'PVTI_1', 'Priority', 'P0'), { message: 'item PVTI_1 is not on the source' });
  assert.deepEqual(calls.map((c) => c.query), [ITEM_FIELDS]);
  await assert.rejects(readItemFields(itemGql([foreign]).gql, 'PVTI_1', PROJECT), { message: 'item PVTI_1 is not on the source' });
  const source = await resolved(specOf(), itemGql([foreign]).gql);
  await assert.rejects(source.fieldsOf!('PVTI_1'), { message: 'item PVTI_1 is not on the source' });
});

test('a write that fails midway re-reads the item and carries what it found on the error: the assignees\' second mutation (#686)', async () => {
  const reads = [fieldsNode(), fieldsNode({}, { assignees: { nodes: [{ id: 'U_ana', login: 'ana' }, { id: 'U_bia', login: 'bia' }] } })];
  const queue = [...reads];
  const gql: Gql = async (query) => {
    if (query === ITEM_FIELDS) return { node: queue.shift() };
    if (query.includes('removeAssigneesFromAssignable')) throw new Error('Resource not accessible by integration');
    return {};
  };
  const err = await writeItemField({ gql, projectId: PROJECT, read: READ, entry: async () => undefined }, 'PVTI_1', 'Assignees', ['bia']).catch((e: unknown) => e);
  assert.ok(err instanceof PartialWriteError);
  assert.equal(err.message, 'Resource not accessible by integration');
  assert.deepEqual(err.written.fields.find((f) => f.name === 'Assignees')?.value, ['ana', 'bia']);
  assert.equal(err.written.row.itemId, 'PVTI_1');
  let isFirstRead = true; // the re-read fails too: the mutation's own words win
  const dead: Gql = async (query) => {
    if (query !== ITEM_FIELDS) throw new Error('mutation failed');
    if (!isFirstRead) throw new Error('re-read failed');
    isFirstRead = false;
    return { node: fieldsNode() };
  };
  await assert.rejects(writeItemField({ gql: dead, projectId: PROJECT, read: READ, entry: async () => undefined }, 'PVTI_1', 'Priority', 'P0'), { message: 'mutation failed' });
});
