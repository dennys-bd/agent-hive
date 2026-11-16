import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openReadModel, type ReadModel } from '../../src/read-model/db.js';
import { WireError } from '../../src/read-model/normalize.js';
import { SourceRateLimitError } from '../../src/source-errors.js';
import { jiraItemOf } from '../../src/sources/jira-item.js';
import type { JiraCall, JiraIssue } from '../../src/sources/jira-queries.js';
import { reconcileProject, syncProject } from '../../src/sources/jira-sync.js';

const SOURCE = 'jira:acme.example:acct-1';
const T1 = '2026-11-16T10:00:00.000+0000';
const T2 = '2026-11-16T10:02:00.000+0000';
const T3 = '2026-11-16T10:06:00.000+0000';
const NAMES = { summary: 'Summary', issuetype: 'Issue Type', customfield_10001: 'Story Points', customfield_10020: 'Sprint' };
const SCHEMA = { summary: { type: 'string' }, issuetype: { type: 'issuetype' }, customfield_10001: { type: 'number' }, customfield_10020: { type: 'array', items: 'json' } };
const FIELDS = [
  { id: 'summary', name: 'Summary', schema: { type: 'string' } },
  { id: 'customfield_10001', name: 'Story Points', schema: { type: 'number' } },
  { id: 'customfield_10020', name: 'Sprint', schema: { type: 'array', items: 'json' } },
];
const STATUSES = [
  { name: 'Story', statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }, { name: 'Done', statusCategory: { key: 'done' } }] },
  { name: 'Bug', statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }] },
];
const STORED_FIELDS = [{ name: 'Status', kind: 'option', options: ['To Do', 'Done'] }, { name: 'Story Points', kind: 'number', options: null }];

const issue = (n: number, updated: string, title = `Issue ${n}`): JiraIssue => ({
  id: String(10000 + n), key: `ABC-${n}`,
  fields: {
    summary: title, updated, status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Story', hierarchyLevel: 0 },
    customfield_10001: n, customfield_10020: [{ id: 1, name: 'Sprint 3' }], parent: { id: '10000', key: 'ABC-0', fields: { summary: 'Epic' } },
    issuelinks: [{ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
      outwardIssue: { id: '10099', key: 'ABC-99', fields: { summary: 'Other', status: { statusCategory: { key: 'done' } } } } }],
  },
});
const page = (issues: JiraIssue[], nextPageToken?: string) =>
  ({ issues, names: NAMES, schema: SCHEMA, ...(nextPageToken === undefined ? { isLast: true } : { nextPageToken }) });

interface Sent { path: string; body: Record<string, unknown> | undefined }
// Searches answer in order (an Error answer is thrown); fields and statuses answer whenever asked
function fakeJira(searches: unknown[]): { call: JiraCall; sent: Sent[] } {
  const sent: Sent[] = [];
  let next = 0;
  const call: JiraCall = async (path, init = {}) => {
    sent.push({ path, body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    if (path === '/field') return FIELDS;
    if (path === '/project/ABC/statuses') return STATUSES;
    if (path !== '/search/jql') throw new Error(`unexpected ${path}`);
    const answer = searches[next++];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { call, sent };
}
const memory = async (): Promise<ReadModel> => (await openReadModel(':memory:', { now: () => Date.parse('2026-11-16T12:00:00Z') })).db;
const searchBodies = (sent: Sent[]) => sent.filter((s) => s.path === '/search/jql').map((s) => s.body);
const stored = (db: ReadModel) => db.items.items(SOURCE, db.items.listing(SOURCE, 'ABC'));

test('a first sync pages to the end and stores every issue in key order with its fields, values, parent and links', async () => {
  const db = await memory();
  const { call, sent } = fakeJira([page([issue(2, T1), issue(3, T1)], 't1'), page([issue(10, T2)])]);
  assert.deepEqual(await syncProject({ call, db, source: SOURCE, project: 'ABC' }), { changed: true });

  const base = { jql: 'project = "ABC" ORDER BY key ASC', fields: ['*navigable', 'description'], expand: 'names,schema', maxResults: 100 };
  assert.deepEqual(searchBodies(sent), [base, { ...base, nextPageToken: 't1' }]);
  assert.deepEqual(sent.map((s) => s.path).sort(), ['/field', '/project/ABC/statuses', '/search/jql', '/search/jql']);
  assert.deepEqual(db.items.listing(SOURCE, 'ABC'), ['10002', '10003', '10010'], 'by key number, as Jira answered: a text sort would put ABC-10 first');
  assert.deepEqual(db.items.fields(SOURCE, 'ABC'), STORED_FIELDS);
  assert.equal(db.items.cursor(SOURCE, 'ABC'), '2026-11-16T10:02:00.000Z');

  const [two] = db.items.items(SOURCE, ['10002']);
  const expected = jiraItemOf(SOURCE, 'ABC', issue(2, T1), NAMES, SCHEMA);
  assert.deepEqual(two, { item: expected.item, values: expected.values, relations: [], relationsRead: null });
  assert.deepEqual(two?.values, [{ field: 'Issue Type', kind: 'option', value: 'Story' }, { field: 'Story Points', kind: 'number', value: '2' }]);
  assert.deepEqual([two?.item.key, two?.item.parentKey, two?.item.data.status, two?.item.data.statusCategory, two?.item.data.hierarchyLevel],
    ['ABC-2', 'ABC-0', 'To Do', 'new', 0]);
  assert.deepEqual(two?.item.data.links, [{ type: 'Blocks', direction: 'outward', phrase: 'blocks', id: '10099', key: 'ABC-99', title: 'Other', statusCategory: 'done' }]);
});

test('a second sync sends the relative window from the cursor, upserts only what came back and advances the cursor', async () => {
  const db = await memory();
  await syncProject({ call: fakeJira([page([issue(1, T1), issue(2, T2)])]).call, db, source: SOURCE, project: 'ABC' });
  const untouched = db.items.items(SOURCE, ['10001']);

  const { call, sent } = fakeJira([page([issue(2, T3, 'Renamed')])]);
  const now = () => Date.parse('2026-11-16T10:07:30.000Z'); // 5.5 minutes after the cursor: ceil + 1 = 7
  assert.deepEqual(await syncProject({ call, db, source: SOURCE, project: 'ABC', now }), { changed: true });

  assert.deepEqual(searchBodies(sent).map((b) => b?.jql), ['project = "ABC" AND updated >= "-7m" ORDER BY key ASC']);
  assert.deepEqual(sent.map((s) => s.path), ['/search/jql'], 'no fields or statuses read on a plain round');
  assert.equal(db.items.items(SOURCE, ['10002'])[0]?.item.data.title, 'Renamed');
  assert.deepEqual(db.items.items(SOURCE, ['10001']), untouched);
  assert.deepEqual(db.items.listing(SOURCE, 'ABC'), ['10001', '10002']);
  assert.equal(db.items.cursor(SOURCE, 'ABC'), '2026-11-16T10:06:00.000Z');
  assert.deepEqual(db.items.fields(SOURCE, 'ABC'), STORED_FIELDS, 'the first sync\'s fields stay');
});

test('a round whose answer is what is stored changes nothing, and an older answer never moves the cursor back', async () => {
  const db = await memory();
  await syncProject({ call: fakeJira([page([issue(1, T1), issue(2, T2)])]).call, db, source: SOURCE, project: 'ABC' });
  const now = () => Date.parse('2026-11-16T10:03:00.000Z');
  assert.deepEqual(await syncProject({ call: fakeJira([page([issue(1, T1)])]).call, db, source: SOURCE, project: 'ABC', now }), { changed: false });
  assert.equal(db.items.cursor(SOURCE, 'ABC'), '2026-11-16T10:02:00.000Z');
});

test('a new issue in a later round takes its place in the listing by key number', async () => {
  const db = await memory();
  await syncProject({ call: fakeJira([page([issue(1, T1), issue(10, T1)])]).call, db, source: SOURCE, project: 'ABC' });
  await syncProject({ call: fakeJira([page([issue(9, T2)])]).call, db, source: SOURCE, project: 'ABC', now: () => Date.parse(T2) });
  assert.deepEqual(db.items.listing(SOURCE, 'ABC'), ['10001', '10009', '10010']);
});

test('a rate-limit error from any page leaves the rows and the cursor where they were and reaches the caller', async () => {
  const db = await memory();
  await syncProject({ call: fakeJira([page([issue(1, T1)])]).call, db, source: SOURCE, project: 'ABC' });
  const before = { rows: stored(db), cursor: db.items.cursor(SOURCE, 'ABC'), listing: db.items.listing(SOURCE, 'ABC') };
  const limited = new SourceRateLimitError('2026-11-16T11:00:00.000Z');

  const { call } = fakeJira([page([issue(1, T3, 'Renamed'), issue(2, T3)], 't1'), limited]);
  await assert.rejects(syncProject({ call, db, source: SOURCE, project: 'ABC', now: () => Date.parse(T3) }), (err) => err === limited);
  assert.deepEqual({ rows: stored(db), cursor: db.items.cursor(SOURCE, 'ABC'), listing: db.items.listing(SOURCE, 'ABC') }, before);
  assert.deepEqual(db.items.items(SOURCE, ['10002']), []);
});

test('a first sync limited on its first page stores nothing: no rows, no fields, no cursor', async () => {
  const db = await memory();
  const limited = new SourceRateLimitError('2026-11-16T11:00:00.000Z');
  await assert.rejects(syncProject({ call: fakeJira([limited]).call, db, source: SOURCE, project: 'ABC' }), (err) => err === limited);
  assert.deepEqual([db.items.listing(SOURCE, 'ABC'), db.items.fields(SOURCE, 'ABC'), db.items.cursor(SOURCE, 'ABC')], [[], [], null]);
});

test('a malformed issue refuses the whole round', async () => {
  const db = await memory();
  const bad: JiraIssue = { id: '10005', key: 'ABC-5', fields: { summary: 'No updated' } };
  await assert.rejects(syncProject({ call: fakeJira([page([issue(1, T1), bad])]).call, db, source: SOURCE, project: 'ABC' }), WireError);
  assert.deepEqual([db.items.items(SOURCE, ['10001']), db.items.cursor(SOURCE, 'ABC')], [[], null]);
});

test('a project key that is not a Jira key is refused before any call', async () => {
  const db = await memory();
  const { call, sent } = fakeJira([]);
  await assert.rejects(syncProject({ call, db, source: SOURCE, project: 'abc' }), /project key/);
  await assert.rejects(syncProject({ call, db, source: SOURCE, project: 'ABC" OR project = "XYZ' }), /project key/);
  assert.equal(sent.length, 0);
});

const ids = (...n: number[]) => ({ issues: n.map((i) => ({ id: String(10000 + i) })), isLast: true });

test('the reconcile asks only ids, removes an issue the project no longer lists, rebuilds the listing and re-reads fields', async () => {
  const db = await memory();
  await syncProject({ call: fakeJira([page([issue(1, T1), issue(2, T1), issue(3, T1)])]).call, db, source: SOURCE, project: 'ABC' });
  db.items.setFields(SOURCE, 'ABC', []);

  const { call, sent } = fakeJira([ids(1, 3)]);
  assert.deepEqual(await reconcileProject({ call, db, source: SOURCE, project: 'ABC' }), { changed: true });
  assert.deepEqual(searchBodies(sent), [{ jql: 'project = "ABC" ORDER BY key ASC', fields: ['id'], maxResults: 100 }]);
  assert.deepEqual(db.items.items(SOURCE, ['10002']), [], 'its row, values and relations are gone');
  assert.deepEqual(db.items.listing(SOURCE, 'ABC'), ['10001', '10003']);
  assert.deepEqual(db.items.fields(SOURCE, 'ABC'), STORED_FIELDS);
});

test('an empty reconcile answer over stored items removes nothing', async () => {
  const db = await memory();
  await syncProject({ call: fakeJira([page([issue(1, T1), issue(2, T1)])]).call, db, source: SOURCE, project: 'ABC' });
  const before = stored(db);
  assert.deepEqual(await reconcileProject({ call: fakeJira([{ issues: [], isLast: true }]).call, db, source: SOURCE, project: 'ABC' }), { changed: false });
  assert.deepEqual(stored(db), before);
});

test('an issue moved to another project is dropped from this listing but its row, now that project\'s, stays', async () => {
  const db = await memory();
  await syncProject({ call: fakeJira([page([issue(1, T1), issue(2, T1)])]).call, db, source: SOURCE, project: 'ABC' });
  const moved = jiraItemOf(SOURCE, 'DEF', { ...issue(2, T3), key: 'DEF-7' }, NAMES, SCHEMA); // as DEF's sync stores it
  assert.equal(db.items.upsertItem(moved.item, 'sync'), true);

  assert.deepEqual(await reconcileProject({ call: fakeJira([ids(1)]).call, db, source: SOURCE, project: 'ABC' }), { changed: true });
  assert.deepEqual(db.items.listing(SOURCE, 'ABC'), ['10001']);
  assert.equal(db.items.items(SOURCE, ['10002'])[0]?.item.scope, 'DEF');
});

test('a reconcile limited on a page removes nothing and reaches the caller; a bad key is refused before any call', async () => {
  const db = await memory();
  await syncProject({ call: fakeJira([page([issue(1, T1), issue(2, T1)])]).call, db, source: SOURCE, project: 'ABC' });
  const before = stored(db);
  const limited = new SourceRateLimitError('2026-11-16T11:00:00.000Z');
  await assert.rejects(reconcileProject({ call: fakeJira([{ issues: [{ id: '10001' }], nextPageToken: 't1' }, limited]).call, db, source: SOURCE, project: 'ABC' }),
    (err) => err === limited);
  assert.deepEqual(stored(db), before);

  const { call, sent } = fakeJira([]);
  await assert.rejects(reconcileProject({ call, db, source: SOURCE, project: 'A-1' }), /project key/);
  assert.equal(sent.length, 0);
});
