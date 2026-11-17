import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WireError } from '../../src/read-model/normalize.js';
import { adfToMarkdown } from '../../src/sources/adf.js';
import { type JiraCall, postTransition, projectJql, readComments, readAssignable, readCreateFields, readFields, readIssue, readIssueTypes, readLabels, readLinkTypes, readMyself, readProjects, readStatuses, readTransitions, searchIssues, sinceMinutes, utcIso } from '../../src/sources/jira-queries.js';

interface Sent { path: string; method: string; body: unknown }

// Answers in order; an Error answer is thrown, as the transport would
function fakeJira(answers: unknown[]): { call: JiraCall; sent: Sent[] } {
  const sent: Sent[] = [];
  let next = 0;
  const call: JiraCall = async (path, init = {}) => {
    sent.push({ path, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const answer = answers[next++];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { call, sent };
}

const FIELDS = ['*navigable', 'description'];

// The same page forever, counting the calls: what MAX_PAGES (1000) must stop
function endless(page: unknown): { call: JiraCall; calls: () => number } {
  let calls = 0;
  return { call: async () => { calls += 1; return page; }, calls: () => calls };
}

test('projectJql quotes the key, adds the relative window and always orders by key', () => {
  assert.equal(projectJql('ABC'), 'project = "ABC" ORDER BY key ASC');
  assert.equal(projectJql('AB_2', 7), 'project = "AB_2" AND updated >= "-7m" ORDER BY key ASC');
});

test('projectJql refuses a key that is not a Jira key', () => {
  for (const key of ['abc', '1AB', 'AB-1', 'A"B', 'AB C', '']) assert.throws(() => projectJql(key), /project key/, key);
});

test('sinceMinutes is the minutes since the cursor, rounded up, plus one; at least one; undefined for an unreadable cursor', () => {
  const cursor = '2026-11-16T10:00:00.000Z';
  assert.equal(sinceMinutes(cursor, Date.parse('2026-11-16T10:05:30.000Z')), 7);
  assert.equal(sinceMinutes(cursor, Date.parse('2026-11-16T10:05:00.000Z')), 6);
  assert.equal(sinceMinutes(cursor, Date.parse('2026-11-16T09:58:00.000Z')), 1, 'a Hive clock behind Jira still sends a valid window');
  assert.equal(sinceMinutes('not a date', Date.parse(cursor)), undefined);
});

test('utcIso reads Jira\'s offsets and answers UTC', () => {
  assert.equal(utcIso('2026-11-16T07:00:00.000-0300'), '2026-11-16T10:00:00.000Z');
  assert.equal(utcIso('2026-11-16T10:00:00.000+0000'), '2026-11-16T10:00:00.000Z');
  assert.equal(utcIso('2026-11-20'), '2026-11-20T00:00:00.000Z');
  assert.equal(utcIso('soon'), undefined);
  assert.equal(utcIso(5), undefined);
});

test('searchIssues pages by nextPageToken to the end and merges names and schema', async () => {
  const { call, sent } = fakeJira([
    { issues: [{ id: '1', key: 'ABC-1', fields: { summary: 'One' } }], names: { summary: 'Summary' }, schema: { summary: { type: 'string' } }, nextPageToken: 't1' },
    { issues: [{ id: '2', key: 'ABC-2' }], names: { customfield_1: 'Points' }, schema: { customfield_1: { type: 'number' } }, isLast: true },
  ]);
  const read = await searchIssues(call, 'project = "ABC" ORDER BY key ASC', FIELDS, 'names,schema');
  assert.deepEqual(read.issues, [{ id: '1', key: 'ABC-1', fields: { summary: 'One' } }, { id: '2', key: 'ABC-2', fields: {} }]);
  assert.deepEqual(read.names, { summary: 'Summary', customfield_1: 'Points' });
  assert.deepEqual(read.schema, { summary: { type: 'string' }, customfield_1: { type: 'number' } });
  assert.deepEqual(sent, [
    { path: '/search/jql', method: 'POST', body: { jql: 'project = "ABC" ORDER BY key ASC', fields: FIELDS, expand: 'names,schema', maxResults: 100 } },
    { path: '/search/jql', method: 'POST', body: { jql: 'project = "ABC" ORDER BY key ASC', fields: FIELDS, expand: 'names,schema', maxResults: 100, nextPageToken: 't1' } },
  ]);
});

test('searchIssues stops at isLast even when a token comes with it, and sends no expand when none is asked', async () => {
  const { call, sent } = fakeJira([{ issues: [{ id: '1' }], nextPageToken: 't1', isLast: true }]);
  const read = await searchIssues(call, 'project = "ABC" ORDER BY key ASC', ['id']);
  assert.deepEqual(read, { issues: [{ id: '1', key: undefined, fields: {} }], names: {}, schema: {} });
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(sent[0]?.body).includes('expand'), false);
});

test('searchIssues refuses a page that is not a search page, and a token that repeats', async () => {
  await assert.rejects(searchIssues(fakeJira([{ issues: 'nope' }]).call, 'j', FIELDS), WireError);
  await assert.rejects(searchIssues(fakeJira([{ issues: [{ id: 7 }] }]).call, 'j', FIELDS), WireError);
  await assert.rejects(searchIssues(fakeJira([[]]).call, 'j', FIELDS), /jira search page/);
  const looping = fakeJira([{ issues: [], nextPageToken: 't1' }, { issues: [], nextPageToken: 't1' }]);
  await assert.rejects(searchIssues(looping.call, 'j', FIELDS), /nextPageToken/);
  const cycling = fakeJira([{ issues: [], nextPageToken: 't1' }, { issues: [], nextPageToken: 't2' }, { issues: [], nextPageToken: 't1' }]);
  await assert.rejects(searchIssues(cycling.call, 'j', FIELDS), /nextPageToken/);
});

test('readIssue asks the search\'s fields and expand, and answers the issue with its names and schema', async () => {
  const { call, sent } = fakeJira([{ id: '1', key: 'ABC-1', fields: { summary: 'One' }, names: { summary: 'Summary' }, schema: { summary: { type: 'string' } } }]);
  const read = await readIssue(call, 'ABC-1');
  assert.deepEqual(read, { issue: { id: '1', key: 'ABC-1', fields: { summary: 'One' } }, names: { summary: 'Summary' }, schema: { summary: { type: 'string' } } });
  assert.deepEqual(sent.map((s) => s.path), ['/issue/ABC-1?fields=*navigable%2Cdescription&expand=names%2Cschema']);
});

test('readIssue refuses an id or key that is neither, before any call', async () => {
  const { call, sent } = fakeJira([]);
  for (const ref of ['..', 'abc-1', 'ABC-1/comment', '']) await assert.rejects(readIssue(call, ref), /id or key/, ref);
  assert.equal(sent.length, 0);
});

const doc = (text: string) => ({ version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const comment = (id: string, text: string, author: unknown = { displayName: 'Ana Lima' }) =>
  ({ id, author, created: '2026-11-16T07:00:00.000-0300', body: doc(text) });

test('readComments pages by startAt until total and answers each comment as Markdown', async () => {
  const { call, sent } = fakeJira([
    { startAt: 0, maxResults: 2, total: 3, comments: [comment('1', 'one'), comment('2', 'two', null)] },
    { startAt: 2, maxResults: 2, total: 3, comments: [comment('3', 'three')] },
  ]);
  const comments = await readComments(call, '10001');
  assert.deepEqual(sent.map((s) => s.path), ['/issue/10001/comment?startAt=0&maxResults=100', '/issue/10001/comment?startAt=2&maxResults=100']);
  assert.deepEqual(comments.map((c) => [c.id, c.author, c.created]), [
    ['1', 'Ana Lima', '2026-11-16T10:00:00.000Z'], ['2', null, '2026-11-16T10:00:00.000Z'], ['3', 'Ana Lima', '2026-11-16T10:00:00.000Z'],
  ]);
  assert.equal(comments[0]?.body, adfToMarkdown(doc('one') as Parameters<typeof adfToMarkdown>[0]));
});

test('readComments stops on an empty page even if total says more, and refuses a page without total', async () => {
  assert.deepEqual(await readComments(fakeJira([{ total: 5, comments: [] }]).call, '1'), []);
  await assert.rejects(readComments(fakeJira([{ comments: [] }]).call, '1'), /jira comments total/);
});

test('readComments refuses a total that is not a count', async () => {
  await assert.rejects(readComments(fakeJira([{ comments: [], total: Number.NaN }]).call, 'ABC-1'), /jira comments total/);
  await assert.rejects(readComments(fakeJira([{ comments: [], total: -1 }]).call, 'ABC-1'), /jira comments total/);
});

test('readStatuses answers the union over issue types, first seen first, each with its category', async () => {
  const { call, sent } = fakeJira([[
    { name: 'Story', statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }, { name: 'In Progress', statusCategory: { key: 'indeterminate' } }] },
    { name: 'Bug', statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }, { name: 'Done', statusCategory: { key: 'done' } }] },
  ]]);
  assert.deepEqual(await readStatuses(call, 'ABC'), [
    { name: 'To Do', category: 'new' }, { name: 'In Progress', category: 'indeterminate' }, { name: 'Done', category: 'done' },
  ]);
  assert.deepEqual(sent.map((s) => s.path), ['/project/ABC/statuses']);
});

test('readStatuses refuses a key that is not a Jira key before any call, and an answer that is not a list', async () => {
  const none = fakeJira([]);
  await assert.rejects(readStatuses(none.call, '..'), /project key/);
  assert.equal(none.sent.length, 0);
  await assert.rejects(readStatuses(fakeJira([{}]).call, 'ABC'), /jira statuses/);
});

test('readFields answers each field\'s id, name and schema; a field without a schema has null', async () => {
  const { call } = fakeJira([[
    { id: 'summary', name: 'Summary', schema: { type: 'string', system: 'summary' } },
    { id: 'customfield_1', name: 'Team', schema: { type: 'option', custom: 'x' } },
    { id: 'thumbnail', name: 'Images' },
  ]]);
  assert.deepEqual(await readFields(call), [
    { id: 'summary', name: 'Summary', schema: { type: 'string' } },
    { id: 'customfield_1', name: 'Team', schema: { type: 'option' } },
    { id: 'thumbnail', name: 'Images', schema: null },
  ]);
  await assert.rejects(readFields(fakeJira([[{ id: 'x' }]]).call), /jira fields/);
});

test('readLinkTypes answers each type with its two phrases', async () => {
  const { call, sent } = fakeJira([{ issueLinkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }] }]);
  assert.deepEqual(await readLinkTypes(call), [{ name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }]);
  assert.deepEqual(sent.map((s) => s.path), ['/issueLinkType']);
  await assert.rejects(readLinkTypes(fakeJira([[]]).call), /jira link types/);
});

test('readMyself answers the account id and the name, which may be absent, and refuses an answer with no account id (#820)', async () => {
  const { call, sent } = fakeJira([{ accountId: 'acc-1', displayName: 'Ana Lima', emailAddress: 'ana@example.com' }, { accountId: 'acc-2' }, { displayName: 'Bea' }]);
  assert.deepEqual(await readMyself(call), { accountId: 'acc-1', displayName: 'Ana Lima' });
  assert.deepEqual(await readMyself(call), { accountId: 'acc-2' });
  await assert.rejects(readMyself(call), /jira myself accountId/);
  assert.deepEqual(sent.map((s) => s.path), ['/myself', '/myself', '/myself']);
});

test('readTransitions answers each transition\'s id and target, postTransition posts the id, and both refuse a ref that is neither before any call (#820)', async () => {
  const { call, sent } = fakeJira([{ transitions: [{ id: '11', name: 'Start', to: { id: '3', name: 'In Progress' } }] }, undefined]);
  assert.deepEqual(await readTransitions(call, '10001'), [{ id: '11', to: 'In Progress' }]);
  await postTransition(call, '10001', '11');
  assert.deepEqual(sent, [
    { path: '/issue/10001/transitions', method: 'GET', body: undefined },
    { path: '/issue/10001/transitions', method: 'POST', body: { transition: { id: '11' } } },
  ]);
  const none = fakeJira([]);
  await assert.rejects(readTransitions(none.call, '..'), /id or key/);
  await assert.rejects(postTransition(none.call, 'ABC-1/x', '11'), /id or key/);
  assert.equal(none.sent.length, 0);
  await assert.rejects(readTransitions(fakeJira([{}]).call, '10001'), /jira transitions/);
});

test('readProjects pages /project/search by startAt until isLast and answers each key and name in Jira\'s order (#821)', async () => {
  const { call, sent } = fakeJira([
    { startAt: 0, maxResults: 1, total: 2, isLast: false, values: [{ id: '1', key: 'ABC', name: 'Alpha', projectTypeKey: 'software' }] },
    { startAt: 1, maxResults: 1, total: 2, isLast: true, values: [{ id: '2', key: 'XYZ', name: 'Zed' }] },
  ]);
  assert.deepEqual(await readProjects(call), [{ key: 'ABC', name: 'Alpha' }, { key: 'XYZ', name: 'Zed' }]);
  assert.deepEqual(sent.map((s) => s.path), ['/project/search?startAt=0&maxResults=100', '/project/search?startAt=1&maxResults=100']);
});

test('readLabels pages /label until isLast and answers the names (#821)', async () => {
  const { call, sent } = fakeJira([{ isLast: false, values: ['api', 'wip'] }, { isLast: true, values: ['ux'] }]);
  assert.deepEqual(await readLabels(call), ['api', 'wip', 'ux']);
  assert.deepEqual(sent.map((s) => s.path), ['/label?startAt=0&maxResults=100', '/label?startAt=2&maxResults=100']);
});

test('readProjects and readLabels stop on an empty page, refuse a malformed body, and stop after MAX_PAGES (#821)', async () => {
  assert.deepEqual(await readProjects(fakeJira([{ values: [] }]).call), []);
  await assert.rejects(readProjects(fakeJira([{ values: 'nope' }]).call), WireError);
  await assert.rejects(readProjects(fakeJira([{ isLast: true, values: [{ key: 'ABC' }] }]).call), /jira project name/);
  await assert.rejects(readLabels(fakeJira([{ isLast: true, values: ['api', 7] }]).call), /jira label/);
  const projects = endless({ isLast: false, values: [{ key: 'ABC', name: 'Alpha' }] });
  await assert.rejects(readProjects(projects.call), /jira projects page count/);
  assert.equal(projects.calls(), 1000);
  const labels = endless({ isLast: false, values: ['api'] });
  await assert.rejects(readLabels(labels.call), /jira labels page count/);
  assert.equal(labels.calls(), 1000);
});

test('readIssueTypes pages createmeta by its total and answers id, name and subtask; values is read when issueTypes is absent (#821)', async () => {
  const { call, sent } = fakeJira([
    { startAt: 0, maxResults: 1, total: 2, issueTypes: [{ id: '10001', name: 'Story', subtask: false, description: 'x' }] },
    { startAt: 1, maxResults: 1, total: 2, issueTypes: [{ id: '10002', name: 'Sub-task', subtask: true }] },
  ]);
  assert.deepEqual(await readIssueTypes(call, 'ABC'), [{ id: '10001', name: 'Story', subtask: false }, { id: '10002', name: 'Sub-task', subtask: true }]);
  assert.deepEqual(sent.map((s) => s.path), ['/issue/createmeta/ABC/issuetypes?startAt=0&maxResults=100', '/issue/createmeta/ABC/issuetypes?startAt=1&maxResults=100']);
  const values = fakeJira([{ startAt: 0, total: 1, values: [{ id: '10003', name: 'Bug', subtask: false }] }]);
  assert.deepEqual(await readIssueTypes(values.call, 'ABC'), [{ id: '10003', name: 'Bug', subtask: false }]);
});

test('readIssueTypes refuses a bad key before any call, a page without a total, a subtask that is no boolean, and paging past MAX_PAGES (#821)', async () => {
  const none = fakeJira([]);
  await assert.rejects(readIssueTypes(none.call, 'abc'), /project key/);
  assert.equal(none.sent.length, 0);
  await assert.rejects(readIssueTypes(fakeJira([{ issueTypes: [] }]).call, 'ABC'), /jira issue types total/);
  await assert.rejects(readIssueTypes(fakeJira([{ total: 1, issueTypes: [{ id: '1', name: 'Story', subtask: 'no' }] }]).call, 'ABC'), /jira issue type subtask/);
  const never = endless({ startAt: 0, total: 1_000_000, issueTypes: [{ id: '1', name: 'Story', subtask: false }] });
  await assert.rejects(readIssueTypes(never.call, 'ABC'), /jira issue types page count/);
  assert.equal(never.calls(), 1000);
});

test('readCreateFields answers each field\'s name and allowed values, an option\'s value else its name, [] when it allows none (#821)', async () => {
  const { call, sent } = fakeJira([{ startAt: 0, total: 3, fields: [
    { fieldId: 'customfield_1', key: 'customfield_1', name: 'Team', required: false, schema: { type: 'option' }, allowedValues: [{ id: '1', value: 'Core' }, { id: '2', value: 'Web' }] },
    { fieldId: 'priority', name: 'Priority', schema: { type: 'priority' }, allowedValues: [{ id: '3', name: 'High' }, { id: '4' }] },
    { fieldId: 'summary', name: 'Summary', schema: { type: 'string' } },
  ] }]);
  assert.deepEqual(await readCreateFields(call, 'ABC', '10001'), [
    { name: 'Team', allowedValues: ['Core', 'Web'] }, { name: 'Priority', allowedValues: ['High'] }, { name: 'Summary', allowedValues: [] },
  ]);
  assert.deepEqual(sent.map((s) => s.path), ['/issue/createmeta/ABC/issuetypes/10001?startAt=0&maxResults=100']);
  const values = fakeJira([{ startAt: 0, total: 1, values: [{ fieldId: 'customfield_1', name: 'Team', allowedValues: [{ value: 'Ops' }] }] }]);
  assert.deepEqual(await readCreateFields(values.call, 'ABC', '10001'), [{ name: 'Team', allowedValues: ['Ops'] }]);
});

test('readCreateFields refuses a type id that is none and a bad key before any call, and a field with no name (#821)', async () => {
  const none = fakeJira([]);
  await assert.rejects(readCreateFields(none.call, 'ABC', '1/x'), /issue type id/);
  await assert.rejects(readCreateFields(none.call, 'AB-1', '10001'), /project key/);
  assert.equal(none.sent.length, 0);
  await assert.rejects(readCreateFields(fakeJira([{ total: 1, fields: [{ fieldId: 'x' }] }]).call, 'ABC', '10001'), /jira create field name/);
});

test('readAssignable pages until a short page and answers the display names in Jira\'s order, skipping an account without one (#821)', async () => {
  const full = Array.from({ length: 100 }, (_, i) => (i === 5 ? { accountId: 'acc-5' } : { accountId: `acc-${i}`, displayName: `User ${i}` }));
  const { call, sent } = fakeJira([full, [{ accountId: 'acc-x', displayName: 'Ana Lima' }]]);
  const names = await readAssignable(call, 'ABC');
  assert.deepEqual(names, [...full.flatMap((u) => ('displayName' in u ? [u.displayName] : [])), 'Ana Lima']);
  assert.deepEqual(sent.map((s) => s.path), [
    '/user/assignable/search?project=ABC&startAt=0&maxResults=100',
    '/user/assignable/search?project=ABC&startAt=100&maxResults=100', // the skipped account still counts
  ]);
});

test('readAssignable refuses a bad key before any call, a body that is no list, and paging past MAX_PAGES (#821)', async () => {
  const none = fakeJira([]);
  await assert.rejects(readAssignable(none.call, '..'), /project key/);
  assert.equal(none.sent.length, 0);
  await assert.rejects(readAssignable(fakeJira([{ values: [] }]).call, 'ABC'), /jira assignable/);
  const never = endless(Array.from({ length: 100 }, (_, i) => ({ accountId: `acc-${i}`, displayName: 'Ana Lima' })));
  await assert.rejects(readAssignable(never.call, 'ABC'), /jira assignable page count/);
  assert.equal(never.calls(), 1000);
});
