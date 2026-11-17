import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATUS } from '../../src/field-values.js';
import { adfToMarkdown } from '../../src/sources/adf.js';
import { markdownToAdf } from '../../src/sources/adf-parse.js';
import { SourceNotConnectedError, SourceRateLimitError } from '../../src/source-errors.js';
import { JiraBadRequestError, JiraHttpError, JiraNotFoundError } from '../../src/sources/jira-fetch.js';
import { jiraFieldsOf, type JiraFieldsContext, jiraSetField } from '../../src/sources/jira-fields.js';
import { jiraItemOf, SPRINT_FIELD, TEXTAREA_FIELD } from '../../src/sources/jira-item.js';
import { taskOf } from '../../src/sources/jira-listing.js';
import { NO_CATEGORIES } from '../../src/sources/jira-relations.js';
import type { JiraCall, JiraSchema } from '../../src/sources/jira-queries.js';
import { JIRA_ENTRY } from '../fakes.js';

const ROWS = 'jira:acme.example:acc-1';
const doc = (text: string) => ({ version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

interface Fake { call: JiraCall; sent: string[]; bodies: unknown[] }
// Each `METHOD path` (query left out) answers its queue in order; an Error answer is thrown, as the transport would
function fakeJira(answers: Record<string, unknown[]> = {}): Fake {
  const sent: string[] = [];
  const bodies: unknown[] = [];
  const call: JiraCall = async (path, init = {}) => {
    const key = `${init.method ?? 'GET'} ${path.split('?')[0]}`;
    sent.push(key);
    if (typeof init.body === 'string') bodies.push(JSON.parse(init.body));
    const queue = answers[key];
    if (queue === undefined || queue.length === 0) throw new Error(`unexpected ${key}`);
    const answer = queue.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { call, sent, bodies };
}

// One row per field: [id, name, schema, value, editmeta (absent = off the edit screen)]
type Row = [string, string, JiraSchema, unknown, { required?: boolean; operations?: string[]; allowedValues?: unknown[] }?];
const SET = ['set'];
const ROWS_OF: Row[] = [
  ['assignee', 'Assignee', { type: 'user', system: 'assignee' }, { accountId: 'acc-1', displayName: 'Ana Lima' }, { operations: SET }],
  ['customfield_1', 'Team', { type: 'option' }, { id: '1', value: 'Platform' }, { required: true, operations: SET, allowedValues: [{ id: '1', value: 'Platform' }, { id: '2', value: 'Web' }] }],
  ['customfield_2', 'Tags', { type: 'array', items: 'option' }, [{ id: '5', value: 'A' }], { operations: SET, allowedValues: [{ id: '5', value: 'A' }, { id: '6', value: 'B' }] }],
  ['priority', 'Priority', { type: 'priority' }, { id: '3', name: 'High' }, { operations: SET, allowedValues: [{ id: '2', name: 'Highest' }, { id: '3', name: 'High' }] }],
  ['issuetype', 'Issue Type', { type: 'issuetype' }, { id: '10', name: 'Story' }, { operations: SET, allowedValues: [{ id: '10', name: 'Story' }, { id: '11', name: 'Bug' }] }],
  ['components', 'Components', { type: 'array', items: 'component' }, [{ id: '20', name: 'Core' }], { operations: SET, allowedValues: [{ id: '20', name: 'Core' }, { id: '21', name: 'Web' }] }],
  ['fixVersions', 'Fix versions', { type: 'array', items: 'version' }, [], { operations: SET, allowedValues: [{ id: '30', name: '1.0' }] }],
  ['customfield_3', 'Points', { type: 'number' }, 5, { operations: SET }],
  ['customfield_4', 'Due', { type: 'date' }, '2026-11-20', { operations: SET }],
  ['customfield_5', 'Starts', { type: 'datetime' }, '2026-11-17T14:30:00.000-0300', { operations: SET }],
  ['customfield_6', 'Notes', { type: 'string', custom: TEXTAREA_FIELD }, doc('Hello'), { operations: SET }],
  ['customfield_7', 'Code', { type: 'string' }, 'X1', { operations: SET }],
  ['customfield_8', 'Reviewers', { type: 'array', items: 'user' }, [{ accountId: 'acc-2', displayName: 'Bea' }], { operations: SET }],
  ['labels', 'Labels', { type: 'array', items: 'string', system: 'labels' }, ['api'], { operations: ['add', 'set', 'remove'] }],
  ['customfield_9', 'Sprint', { type: 'array', items: 'json', custom: SPRINT_FIELD }, [{ id: 7, name: 'Sprint 7', state: 'closed' }, { id: 8, name: 'Sprint 8', state: 'active' }], { operations: SET }],
  ['customfield_10', 'Region', { type: 'option-with-child' }, { value: 'EU', child: { value: 'PT' } }, { operations: SET }],
  ['project', 'Project', { type: 'project', system: 'project' }, { key: 'ABC', name: 'Alpha' }],
  ['creator', 'Creator', { type: 'user', system: 'creator' }, { accountId: 'acc-9', displayName: 'Carl' }],
  ['votes', 'Votes', { type: 'votes', system: 'votes' }, { votes: 0, hasVoted: false }],
];

// What readEditable answers: the issue in fields order (title, dates and status first), its names and schema, and the edit screen in ROWS_OF's order
function edit(patch: Record<string, unknown> = {}, rows: Row[] = ROWS_OF) {
  const fields = {
    summary: 'Ship it', updated: '2026-11-16T10:00:00.000+0000', created: '2026-11-01T10:00:00.000+0000', status: { name: 'To Do', statusCategory: { key: 'new' } },
    ...Object.fromEntries(rows.map(([id, , , value]) => [id, value])), ...patch,
  };
  const editmeta = Object.fromEntries(rows.flatMap(([id, name, schema, , meta]) => (meta === undefined ? [] : [[id, { name, schema, required: false, operations: [], allowedValues: [], ...meta }]])));
  return { id: '10001', key: 'ABC-1', fields, names: Object.fromEntries(rows.map(([id, name]) => [id, name])), schema: Object.fromEntries(rows.map(([id, , schema]) => [id, schema])), editmeta: { fields: editmeta } };
}

const TRANSITIONS = { transitions: [{ id: '11', to: { name: 'In Progress' } }, { id: '12', to: { name: 'To Do' } }] };
const USERS = [{ accountId: 'acc-1', displayName: 'Ana Lima' }, { accountId: 'acc-2', displayName: 'Bea' }, { accountId: 'acc-4', displayName: 'Caio' }];
const BOARDS = { values: [{ id: 1 }], isLast: true };
const SPRINTS = { values: [{ id: 8, name: 'Sprint 8', state: 'active' }, { id: 9, name: 'Sprint 9', state: 'future' }], isLast: true };

// The reads of one fieldsOf, `times` over: the issue, its transitions, the assignable users and the sprints
interface Answers { call: Record<string, unknown[]>; agile: Record<string, unknown[]> }
function reads(times: number, issue = edit(), users: unknown = USERS): Answers {
  const n = <T>(value: T): T[] => Array.from({ length: times }, () => structuredClone(value));
  return {
    call: { 'GET /issue/10001': n(issue), 'GET /issue/10001/transitions': n(TRANSITIONS), 'GET /user/assignable/search': n(users) },
    agile: { 'GET /board': n(BOARDS), 'GET /board/1/sprint': n(SPRINTS) },
  };
}

interface Harness { ctx: JiraFieldsContext; call: Fake; agile: Fake; kept: string[]; moved: [string, string][] }
function harness(answers: Answers, extra: Record<string, unknown[]> = {}): Harness {
  const call = fakeJira({ ...answers.call, ...extra });
  const agile = fakeJira(answers.agile);
  const kept: string[] = [];
  const moved: [string, string][] = [];
  const ctx: JiraFieldsContext = {
    call: call.call, agile: agile.call, source: JIRA_ENTRY,
    keep: (read) => {
      const rows = jiraItemOf(ROWS, 'ABC', read.issue, read.names, read.schema);
      kept.push(rows.item.updatedAt);
      return { rows, task: taskOf(rows, JIRA_ENTRY, NO_CATEGORIES), isOwn: true };
    },
    setColumn: async (id, column) => { moved.push([id, column]); },
    labels: () => ['api', 'ui'], isListed: () => true, isFiltered: () => false,
  };
  return { ctx, call, agile, kept, moved };
}

test('fieldsOf answers Status first, then the edit screen in its order, then the read-only fields with a value, each by the kind table (#826)', async () => {
  const h = harness(reads(1));
  assert.deepEqual(await jiraFieldsOf(h.ctx, '10001'), [
    { name: STATUS, type: 'singleSelect', value: 'To Do', options: ['To Do', 'In Progress'] },
    { name: 'Assignee', type: 'user', value: 'Ana Lima', options: ['Ana Lima', 'Bea', 'Caio'] },
    { name: 'Team', type: 'singleSelect', value: 'Platform', options: ['Platform', 'Web'], isRequired: true },
    { name: 'Tags', type: 'multiSelect', value: ['A'], options: ['A', 'B'] },
    { name: 'Priority', type: 'singleSelect', value: 'High', options: ['Highest', 'High'] },
    { name: 'Issue Type', type: 'issueType', value: 'Story', options: ['Story', 'Bug'] },
    { name: 'Components', type: 'multiSelect', value: ['Core'], options: ['Core', 'Web'] },
    { name: 'Fix versions', type: 'multiSelect', value: [], options: ['1.0'] },
    { name: 'Points', type: 'number', value: 5 },
    { name: 'Due', type: 'date', value: '2026-11-20' },
    { name: 'Starts', type: 'datetime', value: '2026-11-17T14:30:00.000-0300' },
    { name: 'Notes', type: 'longText', value: adfToMarkdown(doc('Hello') as Parameters<typeof adfToMarkdown>[0]) },
    { name: 'Code', type: 'text', value: 'X1' },
    { name: 'Reviewers', type: 'users', value: ['Bea'], options: ['Ana Lima', 'Bea', 'Caio'] },
    { name: 'Labels', type: 'labels', value: ['api'], options: ['api', 'ui'], isOpen: true },
    { name: 'Sprint', type: 'iteration', value: 'Sprint 8', options: ['Sprint 8', 'Sprint 9'] },
    { name: 'Region', type: 'other', value: 'EU - PT', readOnly: true },
    { name: 'Project', type: 'other', value: 'Alpha', readOnly: true },
    { name: 'Creator', type: 'user', value: 'Carl', readOnly: true },
  ]);
  assert.equal(h.kept.length, 1, 'the read is stored as a write');
});

test('a field with no set operation is read only, and the users and sprints are read only when such a field is editable (#826)', async () => {
  const rows = ROWS_OF.filter(([id]) => ['customfield_1', 'customfield_7'].includes(id)).map((r): Row => (r[0] === 'customfield_7' ? [r[0], r[1], r[2], r[3], { operations: ['add'] }] : r));
  const h = harness({ call: { 'GET /issue/10001': [edit({}, rows)], 'GET /issue/10001/transitions': [TRANSITIONS] }, agile: {} });
  const fields = await jiraFieldsOf(h.ctx, '10001');
  assert.deepEqual(fields.find((f) => f.name === 'Code'), { name: 'Code', type: 'text', value: 'X1', readOnly: true });
  assert.deepEqual(h.call.sent, ['GET /issue/10001', 'GET /issue/10001/transitions']);
  assert.deepEqual(h.agile.sent, []);
});

const WRITTEN = edit({ updated: '2026-11-17T10:00:00.000+0000', customfield_1: { id: '2', value: 'Web' } });

test('setField writes each kind with the body of the kind table, by id, then re-reads and stores (#826)', async () => {
  const cases: [string, unknown, Record<string, unknown>][] = [
    ['Team', 'Web', { customfield_1: { id: '2' } }],
    ['Priority', 'High', { priority: { id: '3' } }],
    ['Issue Type', 'Bug', { issuetype: { id: '11' } }],
    ['Tags', ['A', 'B'], { customfield_2: [{ id: '5' }, { id: '6' }] }],
    ['Fix versions', [], { fixVersions: [] }],
    ['Assignee', 'Bea', { assignee: { accountId: 'acc-2' } }],
    ['Assignee', null, { assignee: null }],
    ['Reviewers', ['Bea', 'Caio'], { customfield_8: [{ accountId: 'acc-2' }, { accountId: 'acc-4' }] }],
    ['Sprint', 'Sprint 9', { customfield_9: 9 }],
    ['Sprint', null, { customfield_9: null }],
    ['Notes', 'Hi **there**', { customfield_6: markdownToAdf('Hi **there**') }],
    ['Starts', '2026-11-18T09:00:00.000+01:00', { customfield_5: '2026-11-18T09:00:00.000+0100' }],
    ['Starts', '2026-11-18T09:00Z', { customfield_5: '2026-11-18T09:00:00.000+0000' }],
    ['Starts', '2026-11-18T09:00:05.5-0300', { customfield_5: '2026-11-18T09:00:05.500-0300' }],
    ['Labels', ['api', 'new'], { labels: ['api', 'new'] }],
    ['Points', 8, { customfield_3: 8 }],
  ];
  for (const [name, value, fields] of cases) {
    const h = harness(reads(2), { 'PUT /issue/10001': [undefined] });
    await jiraSetField(h.ctx, '10001', name, value as never);
    assert.deepEqual(h.call.bodies, [{ fields }], name);
    assert.equal(h.kept.length, 2, `${name}: both reads stored`);
  }
});

test('the write answers the re-read: its fields, the row under the key with the new value, and the entry of a listed task (#826)', async () => {
  const answers = reads(2);
  answers.call['GET /issue/10001'][1] = WRITTEN;
  const h = harness(answers, { 'PUT /issue/10001': [undefined] });
  const written = await jiraSetField(h.ctx, '10001', 'Team', 'Web');
  assert.equal(written.fields.find((f) => f.name === 'Team')?.value, 'Web');
  assert.deepEqual([written.row.itemId, written.row.id, written.row.fields.Team, written.row.updatedAt], ['10001', 'ABC-1', 'Web', '2026-11-17T10:00:00.000Z']);
  assert.equal(written.entry?.item.id, 'ABC-1');
  const quiet = harness(reads(2), { 'PUT /issue/10001': [undefined] });
  assert.equal('entry' in (await jiraSetField({ ...quiet.ctx, isListed: () => false }, '10001', 'Team', 'Web')), false);
});

test('Status runs the transition through setColumn and sends no PUT (#826)', async () => {
  const h = harness(reads(2));
  await jiraSetField(h.ctx, '10001', STATUS, 'In Progress');
  assert.deepEqual(h.moved, [['10001', 'In Progress']]);
  assert.equal(h.call.sent.includes('PUT /issue/10001'), false);
});

test('a read-only, required or unknown field, an unknown option, an ambiguous user and a spaced label are refused before any PUT (#826)', async () => {
  const refused: [string, unknown, RegExp, ReturnType<typeof reads>?][] = [
    ['Region', 'x', /"Region" is read only/],
    ['Team', null, /"Team" is required/],
    ['Nope', 'x', /"Nope" is not a field of ABC-1/],
    ['Tags', ['Z'], /"Tags" takes one of its options/],
    ['Labels', ['two words'], /"two words" cannot contain a space/],
    ['Assignee', 'Bea', /"Bea" names more than one account/, reads(1, edit(), [...USERS, { accountId: 'acc-5', displayName: 'Bea' }])],
  ];
  for (const [name, value, message, answers] of refused) {
    const h = harness(answers ?? reads(1));
    await assert.rejects(jiraSetField(h.ctx, '10001', name, value as never), message, name);
    assert.equal(h.call.sent.includes('PUT /issue/10001'), false, name);
  }
});

test('a 400 on the write shows Jira\'s reason under the field\'s name (#826)', async () => {
  const h = harness(reads(1), { 'PUT /issue/10001': [new JiraBadRequestError(['customfield_9'], { customfield_9: 'Sprint is closed' }, [])] });
  await assert.rejects(jiraSetField(h.ctx, '10001', 'Sprint', 'Sprint 9'), { message: 'Sprint: Sprint is closed' });
});

test('two fields of one name refuse the write before any PUT; a custom field named Status never shadows Status (#826)', async () => {
  const twin: Row = ['customfield_20', 'Code', { type: 'string' }, 'Y', { operations: SET }];
  const h = harness(reads(1, edit({}, [...ROWS_OF, twin])));
  await assert.rejects(jiraSetField(h.ctx, '10001', 'Code', 'Z'), { message: '"Code" names more than one field of ABC-1' });
  assert.equal(h.call.sent.includes('PUT /issue/10001'), false);

  const shadow: Row = ['customfield_21', 'Status', { type: 'string' }, 'Y', { operations: SET }];
  const s = harness(reads(2, edit({}, [...ROWS_OF, shadow])));
  await jiraSetField(s.ctx, '10001', 'Status', 'In Progress');
  assert.deepEqual(s.moved, [['10001', 'In Progress']]);
});

test('a 403 or 404 on the extra reads degrades their fields; anything else is rethrown (#826)', async () => {
  const degrading = [new JiraHttpError(403, []), new JiraHttpError(404, []), new JiraNotFoundError()];
  for (const err of degrading) {
    const base = reads(1);
    const h = harness({ call: { ...base.call, 'GET /user/assignable/search': [err], 'GET /issue/10001/transitions': [err] }, agile: { ...base.agile, 'GET /board': [err] } });
    const fields = await jiraFieldsOf(h.ctx, '10001');
    for (const name of ['Assignee', 'Reviewers', 'Sprint']) {
      const f = fields.find((x) => x.name === name);
      assert.equal(f?.readOnly, true, name);
      assert.equal(f?.options, undefined, name);
    }
    assert.deepEqual(fields[0].options, ['To Do']);
  }
  for (const err of [new SourceNotConnectedError('jira:acme.example'), new SourceRateLimitError('2026-11-17T10:00:00.000Z'), new JiraHttpError(500, [])]) {
    for (const [side, key] of [['call', 'GET /user/assignable/search'], ['call', 'GET /issue/10001/transitions'], ['agile', 'GET /board']] as const) {
      const base = reads(1);
      const answers: Answers = { call: { ...base.call }, agile: { ...base.agile } };
      answers[side][key] = [err];
      await assert.rejects(jiraFieldsOf(harness(answers).ctx, '10001'), (e: unknown) => e === err, `${err.name} ${key}`);
    }
  }
});
