import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATUS } from '../../src/field-values.js';
import { adfToMarkdown } from '../../src/sources/adf.js';
import { jiraFieldsOf, type JiraFieldsContext } from '../../src/sources/jira-fields.js';
import { jiraItemOf, SPRINT_FIELD, TEXTAREA_FIELD } from '../../src/sources/jira-item.js';
import { taskOf } from '../../src/sources/jira-listing.js';
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
      return { rows, task: taskOf(rows, JIRA_ENTRY), isOwn: true };
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
