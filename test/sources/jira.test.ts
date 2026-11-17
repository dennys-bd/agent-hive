import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNotConnected } from '../../src/source-errors.js';
import { adfToMarkdown } from '../../src/sources/adf.js';
import { JiraNotFoundError } from '../../src/sources/jira-fetch.js';
import { createJiraSource, type JiraSourceConfig } from '../../src/sources/jira.js';
import type { FilterRule } from '../../src/types.js';
import { JIRA_ENTRY } from '../fakes.js';
import { adapter, CITED, CRED, doc, end, fakeJira, inward, issue, outward, read, ROWS, seeded, STATUSES } from './jira-fakes.js';

const markdown = (text: string): string => adfToMarkdown(doc(text) as Parameters<typeof adfToMarkdown>[0]);
const ids = (tasks: { item: { id: string } }[]): string[] => tasks.map((t) => t.item.id);

test('with no credential, listItems and resolveFields reject not connected before any call, and stored answers [] (#820)', async () => {
  const fake = fakeJira();
  const source = adapter({ call: fake.call, db: await seeded([issue(1, 'To Do')]), cred: null });
  for (const run of [source.listItems(), source.resolveFields()]) await assert.rejects(run, (err: unknown) => isNotConnected(err) && err.source === 'jira:acme.example');
  assert.deepEqual(await source.stored?.(), []);
  assert.deepEqual(fake.sent, []);
});

test('listItems answers the cited, filtered issues in listing order from the read model alone (#820)', async () => {
  const db = await seeded([issue(3, 'In Progress', { labels: ['ui'] }), issue(1, 'To Do'), issue(2, 'Done'), issue(4, 'To Do', { labels: ['other'] })]);
  const fake = fakeJira();
  const filter: FilterRule[] = [{ field: 'label', op: 'any', values: ['api', 'ui'] }];
  const taskProps = { ...JIRA_ENTRY.taskProps, rules: [{ field: 'Components', op: 'equals' as const, value: 'Web', set: { workspace: 'site' } }] };
  const listed = await adapter({ call: fake.call, db, source: { filter, taskProps } }).listItems();
  assert.deepEqual(listed.map((t) => [t.item.id, t.column]), [['ABC-1', 'To Do'], ['ABC-3', 'In Progress']]);
  assert.deepEqual(listed[0], {
    column: 'To Do',
    item: {
      itemId: '10001', id: 'ABC-1', title: 'Issue 1', body: markdown('Body 1'), url: 'https://acme.example/browse/ABC-1', createdAt: '2026-11-01T10:00:00.000Z',
      facets: { assignees: ['Ana Lima'], labels: ['api'], fields: { Components: 'Core, Web' } }, workspaceHint: 'site', autoOnEntry: true, entry: { flow: 'main' },
      blockers: { blockedBy: [], blocking: [] },
    },
  });
  assert.deepEqual(fake.sent, [], 'a listing makes no call to Jira');
});

test('listItems answers blockers on every task, and a source filter\'s blocked rule drops a task with an open blocker (#828)', async () => {
  const db = await seeded([issue(1, 'To Do', { issuelinks: [inward('20001', end(2))] }), issue(2, 'To Do', { issuelinks: [outward('20001', end(1))] }), issue(3, 'To Do')]);
  assert.deepEqual((await adapter({ db }).listItems()).map((t) => [t.item.id, t.item.blockers]), [
    ['ABC-1', { blockedBy: [{ id: 'ABC-2', title: 'Issue 2', state: 'open' }], blocking: [] }],
    ['ABC-2', { blockedBy: [], blocking: [{ id: 'ABC-1', title: 'Issue 1', state: 'open' }] }],
    ['ABC-3', { blockedBy: [], blocking: [] }],
  ]);
  const unblocked: FilterRule[] = [{ field: 'blocked', op: 'none' }];
  assert.deepEqual(ids(await adapter({ db, source: { filter: unblocked } }).listItems()), ['ABC-2', 'ABC-3']);
});

test('stored answers every cited issue unfiltered; with no store, both listings are empty (#820)', async () => {
  const db = await seeded([issue(1, 'To Do'), issue(2, 'Done'), issue(3, 'To Do', { labels: ['other'] })]);
  const filter: FilterRule[] = [{ field: 'label', op: 'any', values: ['api'] }];
  assert.deepEqual(ids((await adapter({ db, source: { filter } }).stored?.()) ?? []), ['ABC-1', 'ABC-3']);
  assert.deepEqual(await adapter({}).listItems(), []);
  assert.deepEqual(await adapter({}).stored?.(), []);
});

test('@me resolves to the stored display name, and with none it stays unresolved (#820)', async () => {
  const db = await seeded([issue(1, 'To Do'), issue(2, 'To Do', { assignee: { displayName: 'Bea Reis' } })]);
  const source = { filter: [{ field: 'assignee', op: 'any', values: ['@me'] }] as FilterRule[] };
  assert.deepEqual(ids(await adapter({ db, source }).listItems()), ['ABC-1']);
  const { displayName: _name, ...unnamed } = CRED;
  assert.deepEqual(ids(await adapter({ db, source, cred: unnamed }).listItems()), []);
});

test('resolveFields rejects naming a cited column the statuses lack, and renews the name only for the same account under another name (#820)', async () => {
  const lacking = fakeJira({ 'GET /project/ABC/statuses': [[{ name: 'Story', statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }, { name: 'Done', statusCategory: { key: 'done' } }] }]] });
  await assert.rejects(adapter({ call: lacking.call }).resolveFields(), { message: '"In Progress" is not a status of ABC: To Do, Done' });
  const cases: [unknown, string[]][] = [
    [{ accountId: 'acc-1', displayName: 'Ana L.' }, ['Ana L.']],
    [{ accountId: 'acc-1', displayName: 'Ana Lima' }, []],
    [{ accountId: 'acc-9', displayName: 'Someone' }, []],
  ];
  for (const [me, expected] of cases) {
    const renamed: string[] = [];
    await adapter({ call: fakeJira({ 'GET /project/ABC/statuses': [STATUSES], 'GET /myself': [me] }).call, renamed }).resolveFields();
    assert.deepEqual(renamed, expected, JSON.stringify(me));
  }
});

test('a name renewal that fails to write never fails the resolve, and is logged (#820)', async () => {
  const warned: string[] = [];
  const source = createJiraSource(JIRA_ENTRY, CITED, {
    call: fakeJira({ 'GET /project/ABC/statuses': [STATUSES], 'GET /myself': [{ accountId: 'acc-1', displayName: 'Ana L.' }] }).call,
    credential: async () => CRED, renewName: async () => { throw new Error('EACCES'); }, log: { warn: (line: string) => { warned.push(line); } },
  });
  await source.resolveFields();
  assert.deepEqual(warned, ['jira:acme.example: display name not renewed (EACCES)']);
});

test('settingsOptions answers the project\'s statuses in Jira\'s order (#820)', async () => {
  assert.deepEqual(await adapter({ call: fakeJira({ 'GET /project/ABC/statuses': [STATUSES] }).call }).settingsOptions(), ['To Do', 'In Progress', 'Done']);
});

test('setColumn posts the transition whose target is the column, then re-reads, and the stored row shows the new status (#820)', async () => {
  const db = await seeded([issue(1, 'To Do')]);
  const fake = fakeJira({
    'GET /issue/10001': [read(issue(1, 'To Do')), read(issue(1, 'In Progress', { updated: '2026-11-16T10:05:00.000+0000' }))],
    'GET /issue/10001/transitions': [{ transitions: [{ id: '31', name: 'Finish', to: { name: 'Done' } }, { id: '11', name: 'Start', to: { name: 'In Progress' } }] }],
    'POST /issue/10001/transitions': [undefined],
  });
  await adapter({ call: fake.call, db }).setColumn('10001', 'In Progress');
  assert.deepEqual(fake.sent, ['GET /issue/10001', 'GET /issue/10001/transitions', 'POST /issue/10001/transitions', 'GET /issue/10001']);
  assert.deepEqual(fake.bodies, [{ transition: { id: '11' } }]);
  assert.equal(db.items.items(ROWS, ['10001'])[0]?.item.data.status, 'In Progress');
});

test('setColumn with no transition to the status rejects naming the key and the status before any POST; already there, it posts nothing (#820)', async () => {
  const none = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do'))], 'GET /issue/10001/transitions': [{ transitions: [{ id: '31', name: 'Finish', to: { name: 'Done' } }] }] });
  await assert.rejects(adapter({ call: none.call }).setColumn('10001', 'Review'), { message: 'ABC-1: no transition to "Review"' });
  assert.equal(none.sent.includes('POST /issue/10001/transitions'), false);
  const there = fakeJira({ 'GET /issue/10001': [read(issue(1, 'In Progress'))] });
  await adapter({ call: there.call }).setColumn('10001', 'In Progress');
  assert.deepEqual(there.sent, ['GET /issue/10001']);
});

test('item answers project (storing nothing), listing, filter and gone (#820)', async () => {
  const db = await seeded([]);
  const itemOf = (answer: unknown, source: Partial<JiraSourceConfig> = {}) => adapter({ call: fakeJira({ 'GET /issue/10001': [answer] }).call, db, source }).item('10001', '');
  const elsewhere = await itemOf(read({ ...issue(1, 'To Do', { project: { key: 'XYZ' } }), key: 'XYZ-1' }));
  assert.deepEqual([elsewhere.reason, 'item' in elsewhere && elsewhere.item.id], ['project', 'XYZ-1']);
  assert.deepEqual(db.items.items(ROWS, ['10001']), [], 'another project\'s issue is not stored');
  const listed = await itemOf(read(issue(1, 'To Do')));
  assert.deepEqual([listed.reason, 'entry' in listed && listed.entry.column], ['listing', 'To Do']);
  assert.equal(db.items.items(ROWS, ['10001']).length, 1, 'an issue of the project is stored');
  const uncited = await itemOf(read(issue(1, 'Done')));
  assert.deepEqual([uncited.reason, 'entry' in uncited && uncited.entry.column], ['filter', 'Done']);
  const filtered = await itemOf(read(issue(1, 'To Do')), { filter: [{ field: 'label', op: 'none', values: ['api'] }] });
  assert.equal(filtered.reason, 'filter');
  assert.deepEqual(await itemOf(new JiraNotFoundError()), { reason: 'gone' });
});

test('comments answers Jira\'s order with the author (Former user for a deleted one), the Markdown body and the comment\'s link (#820)', async () => {
  const db = await seeded([issue(1, 'To Do')]);
  const comment = (id: string, author: unknown) => ({ id, author, created: '2026-11-16T07:00:00.000-0300', body: doc(`c${id}`) });
  const fake = fakeJira({ 'GET /issue/10001/comment': [{ total: 2, comments: [comment('1', { displayName: 'Ana Lima' }), comment('2', null)] }] });
  assert.deepEqual(await adapter({ call: fake.call, db }).comments?.('10001'), [
    { author: 'Ana Lima', createdAt: '2026-11-16T10:00:00.000Z', body: markdown('c1'), url: 'https://acme.example/browse/ABC-1?focusedCommentId=1' },
    { author: 'Former user', createdAt: '2026-11-16T10:00:00.000Z', body: markdown('c2'), url: 'https://acme.example/browse/ABC-1?focusedCommentId=2' },
  ]);
  assert.deepEqual(fake.sent, ['GET /issue/10001/comment'], 'the key comes from the stored row: no issue read');
});

test('apply rejects remove, which a Jira source has no Project for, naming it (#823)', async () => {
  const fake = fakeJira();
  await assert.rejects(adapter({ call: fake.call }).apply('10001', { type: 'remove' }, ''), { message: '"remove" is not an action of a jira source' });
  assert.deepEqual(fake.sent, []);
});

test('resolveFields rejects a doneStatus the project lacks, naming it and the statuses, before reading /myself (#823)', async () => {
  const fake = fakeJira({ 'GET /project/ABC/statuses': [STATUSES] });
  await assert.rejects(adapter({ call: fake.call, source: { doneStatus: 'Closed' } }).resolveFields(), { message: '"Closed" is not a status of ABC: To Do, In Progress, Done' });
  assert.deepEqual(fake.sent, ['GET /project/ABC/statuses']);
});
