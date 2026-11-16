import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WireError } from '../../src/read-model/normalize.js';
import { adfToMarkdown } from '../../src/sources/adf.js';
import { type JiraCall, projectJql, readComments, readFields, readIssue, readLinkTypes, readStatuses, searchIssues, sinceMinutes, utcIso } from '../../src/sources/jira-queries.js';

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
