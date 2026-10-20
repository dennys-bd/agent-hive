import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceSpec, createSource, createSources, namespaced, resolveSources } from '../src/source.js';
import { groupUnderEpics, listFilterOptions, listProjects, listStatusOptions, treeLinks } from '../src/sources/github.js';
import { RelationRereadError } from '../src/sources/github-blockers.js';
import { ITEMS, ITEM_FIELDS, type GhItemNode } from '../src/sources/github-queries.js';
import { citedColumns, itemSource } from '../src/tasks.js';
import { parseConfig } from '../src/config.js';
import type { FieldWrite, ProjectView, Source, SourceConfig, SourceSpec, TaskFilter, TaskRule } from '../src/types.js';
import { EPICS, SOURCE, STAGES, FILTER, FIXED, chained, combConfig, fakeGql, fakeLog, move } from './fakes.js';

const GITHUB_SOURCE = { type: 'github', owner: 'acme', number: 6, filter: FILTER };
/** The SourceSpec the server would build from a Comb with the GitHub source and `extra` on top (source, columns or a top-level key). */
const specOf = (extra: Record<string, unknown> = {}) => { const config = parseConfig(combConfig({ source: GITHUB_SOURCE, ...extra })); return sourceSpec(config, config.comb.sources[0]); };
const config = specOf();
const ignored = specOf({ source: { ...GITHUB_SOURCE, epics: 'ignore' } });
const hidden = specOf({ source: { ...GITHUB_SOURCE, epics: 'hide' } });

const options = [{ id: 'O_ready', name: 'Ready' }, { id: 'O_prog', name: 'In progress' }, { id: 'O_rev', name: 'In review' }, { id: 'O_done', name: 'Done' }];
const fields = { repositoryOwner: { projectV2: { id: 'PVT_1', field: { id: 'F_status', options } } } };
const RATE = { limit: 5000, remaining: 4320, resetAt: '2026-09-16T13:00:00.000Z' };
/** What a listed issue with no assignee, label, milestone, repository or single-select value carries for the view filter (#374). */
const NO_FACETS = { assignees: [], labels: [], fields: {} };

/** One page of `items`: `nodes`, and whether another page follows. */
const page = (nodes: unknown[], hasNextPage = false, endCursor = 'CUR') => ({
  rateLimit: RATE,
  repositoryOwner: { projectV2: { items: { pageInfo: { hasNextPage, endCursor }, nodes } } },
});
const item = (n: number, status = 'Ready') => ({
  id: `I${n}`,
  fieldValueByName: { name: status },
  content: { __typename: 'Issue', number: n, title: `T${n}`, body: '', url: `https://github.com/acme/r/issues/${n}` },
});
type Rel = [number, string, string?];
// A blocker relation's other issue as the relations query asks it (#56): in acme/r unless named, titled T<n>
const relRef = ([number, state, repo = 'acme/r']: Rel) => ({ number, title: `T${number}`, state, repository: { nameWithOwner: repo } });
const relations = (blockedBy: Rel[], subIssues: [number, string][] = [], blocking: Rel[] = []) => ({
  issue: {
    blockedBy: { nodes: blockedBy.map(relRef) },
    blocking: { nodes: blocking.map(relRef) },
    subIssues: { nodes: subIssues.map(([number, state]) => ({ number, state })) },
  },
});
/** An issue item carrying the filter's attributes; absent ones come back as GitHub sends them (empty nodes, null). `fields`: single-select
 * values by field name (#245); `textFields`: text values by field name, which a project rule reads too (#293). */
const issue = (
  n: number,
  attrs: { assignees?: string[]; labels?: string[]; milestone?: string; repository?: string; fields?: Record<string, string>; textFields?: Record<string, string> } = {},
) => ({
  ...item(n),
  fieldValues: {
    nodes: [
      ...Object.entries(attrs.fields ?? {}).map(([field, name]) => ({ name, field: { name: field } })),
      ...Object.entries(attrs.textFields ?? {}).map(([field, text]) => ({ text, field: { name: field } })),
    ],
  },
  content: {
    ...item(n).content,
    assignees: { nodes: (attrs.assignees ?? []).map((login) => ({ login })) },
    labels: { nodes: (attrs.labels ?? []).map((name) => ({ name })) },
    milestone: attrs.milestone === undefined ? null : { title: attrs.milestone },
    repository: attrs.repository === undefined ? null : { nameWithOwner: attrs.repository },
  },
});
/** The GitHub spec with these filter rules. */
const filtered = (filter: TaskFilter) => specOf({ source: { ...GITHUB_SOURCE, filter } });
/** An issue item carrying its node id (`N<n>`) and its sub-issues' node ids in the epic's own order, as the items query asks (#211), each
 * with its state: those in `closed` are CLOSED (#28). */
const linked = (n: number, subIssues: number[] = [], status = 'Ready', closed: number[] = []) => ({
  ...item(n, status),
  content: {
    ...item(n).content, id: `N${n}`,
    subIssuesSummary: { total: subIssues.length },
    subIssues: { nodes: subIssues.map((s): { id: string; state: 'OPEN' | 'CLOSED' } => ({ id: `N${s}`, state: closed.includes(s) ? 'CLOSED' : 'OPEN' })) },
  },
});

test('resolveFields maps every cited column to its option id in one call and setColumn edits the item with it', async () => {
  const { gql, calls } = fakeGql({ fields, setOption: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'I1' } } } });
  const source = createSource(config, { gql });
  await source.resolveFields();
  assert.deepEqual(calls.map((c) => c.name), ['fields'], 'one call, not the old view + field-list pair');
  assert.deepEqual(calls[0].variables, { login: 'acme', number: 6 });
  await source.setColumn('ITEM_1', 'In review');
  assert.deepEqual(calls[1].variables, { projectId: 'PVT_1', itemId: 'ITEM_1', fieldId: 'F_status', singleSelectOptionId: 'O_rev' });
  await assert.rejects(source.setColumn('ITEM_1', 'Done'), /"Done" is not a column the config cites/);
});

test('resolveFields fails naming the missing option, the Hive column that cites it and the available ones', async () => {
  const bad = specOf({ stages: [{ ...STAGES[0], onFinish: { board: [move('Todo')] } }] });
  const source = createSource(bad, { gql: fakeGql({ fields }).gql });
  await assert.rejects(source.resolveFields(), /"Todo" \(fila → end\.sources\).*Ready, In progress, In review, Done/s);
});

test('resolveFields names the project when the owner or the project is gone, and keeps the Status wording when the field is', async () => {
  const noProject = { repositoryOwner: { projectV2: null } };
  await assert.rejects(createSource(config, { gql: fakeGql({ fields: noProject }).gql }).resolveFields(), /6.*acme/s);
  await assert.rejects(createSource(config, { gql: fakeGql({ fields: { repositoryOwner: null } }).gql }).resolveFields(), /6.*acme/s);
  const noField = { repositoryOwner: { projectV2: { id: 'PVT_1', field: null } } };
  await assert.rejects(createSource(config, { gql: fakeGql({ fields: noField }).gql }).resolveFields(), /source has no single-select "Status" field/);
});

test('setColumn before resolveFields throws', async () => {
  await assert.rejects(createSource(config, { gql: fakeGql({}).gql }).setColumn('x', 'Ready'), /not resolved/);
});

test('apply (#286): archive and remove send the item mutation with the project id, close and delete the issue mutation with its content id; a draft cannot be closed and is deleted as an item; any before resolveFields rejects (an item not listed: the #353 test below)', async () => {
  const draft = { id: 'I3', fieldValueByName: { name: 'Ready' }, content: { __typename: 'DraftIssue', title: 'Draft' } };
  const { gql, calls } = fakeGql({ fields, items: page([linked(1), draft]), relations: {}, archiveItem: {}, deleteItem: {}, closeIssue: {}, deleteIssue: {} });
  const source = createSource(config, { gql });
  await assert.rejects(source.apply('I1', { type: 'archive' }), /not resolved/);
  await source.resolveFields();
  await source.listItems();
  for (const type of ['archive', 'remove', 'close', 'delete'] as const) await source.apply('I1', { type });
  await source.apply('I3', { type: 'delete' });
  await assert.rejects(source.apply('I3', { type: 'close' }), { message: '"close" needs an issue, not a draft or a pull request' });
  const writes = calls.filter((c) => ['archiveItem', 'deleteItem', 'closeIssue', 'deleteIssue'].includes(c.name)).map((c) => [c.name, c.variables]);
  assert.deepEqual(writes, [
    ['archiveItem', { projectId: 'PVT_1', itemId: 'I1' }], ['deleteItem', { projectId: 'PVT_1', itemId: 'I1' }],
    ['closeIssue', { issueId: 'N1' }], ['deleteIssue', { issueId: 'N1' }], ['deleteItem', { projectId: 'PVT_1', itemId: 'I3' }],
  ]);
});

test('apply close with hive_stop\'s reason (#314): wontDo sends NOT_PLANNED; duplicate with duplicateOf resolves the original in the item\'s repository and sends its node id; an unknown original rejects and closes nothing', async () => {
  const originals = [{ repository: { issue: { id: 'N7' } } }, { repository: { issue: null } }];
  const { gql, calls } = fakeGql({ fields, items: page([linked(1)]), relations: {}, closeIssue: {}, issueId: originals });
  const source = createSource(config, { gql });
  await source.resolveFields();
  await source.listItems();
  await source.apply('I1', { type: 'close', reason: 'wontDo' });
  await source.apply('I1', { type: 'close', reason: 'duplicate', duplicateOf: 7 });
  await assert.rejects(source.apply('I1', { type: 'close', reason: 'duplicate', duplicateOf: 8 }), { message: 'issue #8 not found in acme/r' });
  const sent = calls.filter((c) => ['issueId', 'closeIssue'].includes(c.name)).map((c) => [c.name, c.variables]);
  assert.deepEqual(sent, [
    ['closeIssue', { issueId: 'N1', stateReason: 'NOT_PLANNED' }],
    ['issueId', { owner: 'acme', name: 'r', number: 7 }], ['closeIssue', { issueId: 'N1', stateReason: 'DUPLICATE', duplicateIssueId: 'N7' }],
    ['issueId', { owner: 'acme', name: 'r', number: 8 }],
  ], 'the bare close keeps sending { issueId } alone: the #286 test above');
});

test('apply before the adapter ever listed (#353): it runs the listing query first, then the action; an item still absent from that listing rejects as before', async () => {
  const { gql, calls } = fakeGql({ fields, items: page([linked(1)]), relations: {}, archiveItem: {} });
  const source = createSource(config, { gql });
  await source.resolveFields();
  await source.apply('I1', { type: 'archive' });
  assert.deepEqual(calls.map((c) => c.name).filter((name) => name === 'items' || name === 'archiveItem'), ['items', 'archiveItem']);
  await source.apply('I1', { type: 'archive' });
  assert.equal(calls.filter((c) => c.name === 'items').length, 1, 'listed once: the listing filled what apply acts on');

  const fresh = fakeGql({ fields, items: page([linked(1)]), relations: {} });
  const other = createSource(config, { gql: fresh.gql });
  await other.resolveFields();
  await assert.rejects(other.apply('I9', { type: 'archive' }), { message: 'item I9 is not on the source' });
  assert.equal(fresh.calls.filter((c) => c.name === 'items').length, 1, 'it listed before refusing');
});

test('listItems returns the issues in any cited column with the column name, in source order', async () => {
  const nodes = [
    item(1), { ...item(2), fieldValueByName: { name: 'In progress' } },
    { id: 'I3', fieldValueByName: { name: 'Ready' }, content: { __typename: 'DraftIssue', title: 'Draft' } },
    { ...item(4), fieldValueByName: { name: 'Done' } },
    { ...item(5), fieldValueByName: null },
  ];
  const source = createSource(config, { gql: fakeGql({ items: page(nodes), relations: {} }).gql });
  assert.deepEqual(await source.listItems(), [
    { item: { itemId: 'I1', id: '1', title: 'T1', body: '', url: 'https://github.com/acme/r/issues/1', facets: NO_FACETS, autoOnEntry: true }, column: 'Ready' },
    { item: { itemId: 'I2', id: '2', title: 'T2', body: '', url: 'https://github.com/acme/r/issues/2', facets: NO_FACETS, autoOnEntry: true }, column: 'In progress' },
  ]);
});

test('listItems pages items by cursor and concatenates the pages, stopping at hasNextPage false', async () => {
  const { gql, calls } = fakeGql({ items: [page([item(1)], true, 'CUR_1'), page([item(2)])], relations: {} });
  const tasks = await createSource(config, { gql }).listItems();
  assert.deepEqual(tasks.map((c) => c.item.id), ['1', '2']);
  const items = calls.filter((c) => c.name === 'items');
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].variables, { login: 'acme', number: 6 }, 'the first page carries no cursor');
  assert.deepEqual(items[1].variables, { login: 'acme', number: 6, after: 'CUR_1' });
});

test('listItems hands GitHub the filter as the items query, and warns when the pages still end before the items do (#234)', async () => {
  const { gql, calls } = fakeGql({ items: [page([item(1)], true, 'CUR_1'), page([item(2)], true, 'CUR_2')], relations: {} });
  const { log, lines } = fakeLog();
  await createSource(filtered([{ field: 'milestone', op: 'any', values: ['Wave 1'] }]), { gql, log }).listItems();
  assert.ok(calls.filter((c) => c.name === 'items').every((c) => c.variables?.filter === 'milestone:"Wave 1"'));
  assert.deepEqual(lines.filter((l) => l.startsWith('WARN')), ['WARN source acme/6: more than 200 items pass its filter; the ones past them never reach the flow']);
});

test('with owner @me, listItems resolves the login once and polls with it', async () => {
  const mine = specOf({ source: { ...GITHUB_SOURCE, owner: '@me' } });
  const { gql, calls } = fakeGql({ viewer: { viewer: { login: 'dennys' } }, items: [page([item(1)]), page([item(2)])], relations: {} });
  const source = createSource(mine, { gql });
  await source.listItems();
  await source.listItems();
  assert.deepEqual(calls.filter((c) => c.name === 'viewer').length, 1);
  assert.ok(calls.filter((c) => c.name === 'items').every((c) => c.variables?.login === 'dennys'));
});

test('citedColumns lists every source column the config mentions once, naming the first Hive column and field that cites it', () => {
  const { stages, transitions } = chained([
    { name: 'spec', from: { board: ['Backlog'] }, onFinish: { board: [move('Ready')] } },
    { name: 'dev', from: { board: ['Ready'] }, onStart: { board: [move('In progress')] }, onFinish: { board: [move('In review')] } },
    { name: 'review', from: { board: ['In review'] } },
  ]);
  assert.deepEqual(citedColumns(stages, transitions, SOURCE), [
    { column: 'Backlog', by: 'spec.from' }, { column: 'Ready', by: 'dev.from' },
    { column: 'In progress', by: 'dev.onStart' }, { column: 'In review', by: 'review.from' },
  ]);
});

test('with epics: ignore, listItems keeps epics and resolves open blockers with one graphql call, one alias per listed issue, OPEN only and deduped', async () => {
  const { gql, calls } = fakeGql({
    items: page([item(1), item(2, 'Done'), item(3), item(4)]),
    relations: {
      i0: relations([[7, 'OPEN'], [8, 'CLOSED']], [[7, 'OPEN'], [9, 'OPEN']]),
      i1: relations([[10, 'CLOSED']], [[11, 'CLOSED']]),
      i2: relations([], []),
    },
  });
  const tasks = await createSource(ignored, { gql }).listItems();
  assert.deepEqual(tasks.map((c) => [c.item.id, c.item.blockedBy]), [['1', ['7', '9']], ['3', undefined], ['4', undefined]]);
  assert.ok(!('blockedBy' in tasks[1].item), 'field omitted when there is no open blocker');
  const graphql = calls.filter((c) => c.name === 'relations');
  assert.equal(graphql.length, 1);
  const { query } = graphql[0];
  assert.match(query, /^query \{ i0: repository\(owner: "acme", name: "r"\) \{ issue\(number: 1\) \{ blockedBy\(first: 50\) \{ nodes \{ number title state repository \{ nameWithOwner \} \} \} blocking\(first: 50\) \{ nodes \{ number title state repository \{ nameWithOwner \} \} \} subIssues\(first: 50\) \{ nodes \{ number state \} \} \} \} i1: /);
  assert.match(query, /i1: repository\(owner: "acme", name: "r"\) \{ issue\(number: 3\)/);
  assert.match(query, /i2: repository\(owner: "acme", name: "r"\) \{ issue\(number: 4\)/);
  assert.ok(!query.includes('i3:'), 'no alias for issues outside the cited columns');
});

test('listItems with nothing in the queue column makes no graphql call', async () => {
  const { gql, calls } = fakeGql({ items: page([item(2, 'Done')]) });
  assert.deepEqual(await createSource(config, { gql }).listItems(), []);
  assert.deepEqual(calls.map((c) => c.name), ['items']);
});

test('listItems treats issue: null, a null repository or a missing alias as no blockers and not as an epic', async () => {
  const { gql, calls } = fakeGql({
    items: page([item(1), item(2), item(3)]),
    relations: { i0: { issue: null }, i1: null },
  });
  const tasks = await createSource(config, { gql }).listItems();
  assert.deepEqual(tasks.map((c) => c.item.blockedBy), [undefined, undefined, undefined]);
  assert.deepEqual(tasks.map((c) => c.item.id), ['1', '2', '3'], 'nothing dropped: no item is an epic');
  assert.equal(calls.filter((c) => c.name === 'relations').length, 1);
});

test('listItems reads an issue\'s blocker relations both ways with titles and states into blockers, sub-issues never; blockedBy stays the start gate (#56)', async () => {
  const { gql, calls } = fakeGql({
    items: page([item(1), item(2), item(3)]),
    relations: {
      i0: relations([[7, 'OPEN'], [8, 'CLOSED', 'other/lib']], [[9, 'OPEN']], [[5, 'OPEN']]),
      i1: relations([]),
      i2: { issue: null },
    },
  });
  const [blocked, free, unread] = (await createSource(config, { gql }).listItems()).map((c) => c.item);
  assert.deepEqual(blocked.blockers, {
    blockedBy: [{ id: '7', title: 'T7', state: 'open' }, { id: 'other/lib#8', title: 'T8', state: 'closed' }],
    blocking: [{ id: '5', title: 'T5', state: 'open' }],
  }, 'the open sub-issue 9 is no relation');
  assert.deepEqual(blocked.blockedBy, ['7', '9'], 'the start gate as before: open blockers and open sub-issues');
  assert.deepEqual(free.blockers, { blockedBy: [], blocking: [] }, 'read and none: not absent');
  assert.equal('blockers' in unread, false, 'not read: absent');
  const { query } = calls.find((c) => c.name === 'relations')!;
  assert.match(query, /blocking\(first: 50\) \{ nodes \{ number title state repository \{ nameWithOwner \} \} \}/);
});

test('with epics: hide, listItems drops epics (subIssuesSummary.total > 0) straight from the listing, with no relations alias spent on them', async () => {
  const epic = (n: number, total: number) => ({ ...item(n), content: { ...item(n).content, subIssuesSummary: { total } } });
  const { gql, calls } = fakeGql({
    items: page([epic(1, 1), epic(2, 3), item(3), item(4)]),
    relations: { i0: relations([[7, 'OPEN']]), i1: relations([[9, 'CLOSED']]) },
  });
  const tasks = await createSource(hidden, { gql }).listItems();
  assert.deepEqual(tasks.map((c) => [c.item.id, c.item.blockedBy]), [['3', ['7']], ['4', undefined]]);
  const { query } = calls.find((c) => c.name === 'relations')!;
  assert.ok(!query.includes('issue(number: 1)') && !query.includes('issue(number: 2)'), 'epics cost no relations alias');
  assert.equal(calls.filter((c) => c.name === 'relations').length, 1);
});

test('epics: hide drops an epic wherever it sits on the source, before the relations query: it costs no alias', async () => {
  const epic = { ...item(2), fieldValueByName: { name: 'In progress' }, content: { ...item(2).content, subIssuesSummary: { total: 2 } } };
  const other = { ...item(3), fieldValueByName: { name: 'In review' } };
  const { gql, calls } = fakeGql({ items: page([epic, other]), relations: {} });
  const tasks = await createSource(hidden, { gql }).listItems();
  assert.deepEqual(tasks.map((c) => c.item.id), ['3'], 'the epic is dropped wherever it sits');
  const { query } = calls.find((c) => c.name === 'relations')!;
  assert.ok(!query.includes('issue(number: 2)'), 'the epic gets no alias');
  assert.match(query, /^query \{ i0: repository\(owner: "acme", name: "r"\) \{ issue\(number: 3\)/, 'a task outside a prompt-entry column is asked for (#441)');
});

test('epics: ignore keeps an epic (unlike hide) and its open sub-issues block it', async () => {
  const epic = { ...item(1), content: { ...item(1).content, subIssuesSummary: { total: 2 } } }; // 'Ready': the prompt-entry column
  const { gql } = fakeGql({ items: page([epic]), relations: { i0: relations([], [[5, 'OPEN'], [6, 'CLOSED']]) } });
  const tasks = await createSource(ignored, { gql }).listItems();
  assert.deepEqual(tasks.map((c) => [c.item.id, c.item.blockedBy]), [['1', ['5']]]);
});

test('epics: show stamps an issue with sub-issues as an epic carrying the source\'s rule, and a leaf not; ignore and hide never stamp it (#31)', async () => {
  const epic = { ...item(1), content: { ...item(1).content, subIssuesSummary: { total: 2 } } };
  const read = async (spec: SourceSpec) => createSource(spec, { gql: fakeGql({ items: page([epic, item(2)]), relations: {} }).gql }).listItems();
  const [shown, leaf] = (await read(config)).map((c) => c.item);
  assert.deepEqual(shown.epic, { follows: EPICS.epicFollows, switchAt: EPICS.switchAt }, 'show is what combConfig gives a source');
  assert.ok(!('epic' in leaf), 'a leaf is no epic');
  assert.ok((await read(ignored)).every((c) => !('epic' in c.item)), 'ignore: a regular task');
  assert.deepEqual((await read(hidden)).map((c) => [c.item.id, 'epic' in c.item]), [['2', false]], 'hide: the epic is gone');
});

test('groupUnderEpics puts an epic\'s sub-issues right after it in the epic\'s own order; one in another column or past the listed ones keeps its source position; the input is untouched (#211)', () => {
  const ids = (list: GhItemNode[]): string[] => list.map((i) => i.id);
  // the issue's example: A B C D F G, where B (2) is an epic with sub-issues F (6) and G (7)
  const column = [linked(1), linked(2, [6, 7]), linked(3), linked(4), linked(6), linked(7)];
  assert.deepEqual(ids(groupUnderEpics(column)), ['I1', 'I2', 'I6', 'I7', 'I3', 'I4']);
  assert.deepEqual(ids(column), ['I1', 'I2', 'I3', 'I4', 'I6', 'I7'], 'the input is untouched');
  assert.deepEqual(ids(groupUnderEpics([linked(1), linked(2, [7, 6]), linked(3), linked(6), linked(7)])), ['I1', 'I2', 'I7', 'I6', 'I3'], 'the epic\'s sub-issue order, not the source order');
  assert.deepEqual(ids(groupUnderEpics([linked(1), linked(2, [6, 7]), linked(3), linked(6, [], 'In progress'), linked(7)])), ['I1', 'I2', 'I7', 'I3', 'I6'], 'another column: 6 keeps its place there');
  assert.deepEqual(ids(groupUnderEpics([linked(1), linked(2, [6]), linked(3), linked(6), linked(7)])), ['I1', 'I2', 'I6', 'I3', 'I7'], '7 is past what the epic listed (SUB_ISSUE_LIMIT): its own position');
  assert.deepEqual(ids(groupUnderEpics([item(1), item(2)])), ['I1', 'I2'], 'no node ids, no sub-issues: source order');
  assert.deepEqual(groupUnderEpics([]), []);
});

test('groupUnderEpics goes depth first through epics inside epics, gives a sub-issue to the first epic that lists it, and a cycle or a self-reference neither loops nor drops or duplicates an item (#211)', () => {
  const ids = (list: GhItemNode[]): string[] => list.map((i) => i.id);
  // the spec's worked example: A B C D E1 F E G E2, with B (2) → [E (5), G (7)] and E (5) → [E1 (11), E2 (12)]
  const nested = [linked(1), linked(2, [5, 7]), linked(3), linked(4), linked(11), linked(6), linked(5, [11, 12]), linked(7), linked(12)];
  assert.deepEqual(ids(groupUnderEpics(nested)), ['I1', 'I2', 'I5', 'I11', 'I12', 'I7', 'I3', 'I4', 'I6'], 'A, B, E, E1, E2, G, C, D, F');
  assert.deepEqual(ids(groupUnderEpics([linked(1, [3]), linked(2, [3]), linked(3)])), ['I1', 'I3', 'I2'], 'claimed twice: the first epic in source order');
  assert.deepEqual(ids(groupUnderEpics([linked(1, [2]), linked(2, [1]), linked(3)])), ['I3', 'I1', 'I2'], 'a cycle has no root: its items come last, in source order, once each');
  assert.deepEqual(ids(groupUnderEpics([linked(1, [1]), linked(2)])), ['I1', 'I2'], 'an item is never its own sub-issue');
});

test('treeLinks gives a sub-issue its parent\'s item id and the parent its children in sub-issue order, across Status columns; closed ones also land in closedChildren; a sub-issue with no item is skipped (#28)', () => {
  const links = treeLinks([linked(1, [3, 9, 2], 'Ready', [2]), linked(2, [], 'In progress'), linked(3, [], 'Done'), linked(4)]);
  assert.deepEqual(links.get('I1'), { children: ['I3', 'I2'], closedChildren: ['I2'] }, '9 has no item; 2 is closed');
  assert.deepEqual(links.get('I2'), { parent: 'I1', children: [], closedChildren: [] }, 'another column keeps its parent');
  assert.deepEqual(links.get('I3'), { parent: 'I1', children: [], closedChildren: [] });
  assert.deepEqual(links.get('I4'), { children: [], closedChildren: [] }, 'a leaf with no parent');
  assert.deepEqual(treeLinks([item(1), item(2)]).get('I1'), { children: [], closedChildren: [] }, 'no node ids: no links');
});

test('treeLinks on a cycle, a duplicate sub-issue and a self-reference terminates and lists each child once; the first parent in listing order wins (#28)', () => {
  const links = treeLinks([linked(1, [2, 2, 1]), linked(2, [1]), linked(3, [2])]);
  assert.deepEqual(links.get('I1'), { parent: 'I2', children: ['I2'], closedChildren: [] }, 'the repeat and the self-reference are dropped');
  assert.deepEqual(links.get('I2'), { parent: 'I1', children: ['I1'], closedChildren: [] });
  assert.deepEqual(links.get('I3'), { children: ['I2'], closedChildren: [] }, '3 lists 2 too, but 1 came first');
});

test('the listing and the one-item re-read ask each sub-issue\'s state (#28)', () => {
  assert.match(ITEMS, /subIssues\(first: 50\) \{ nodes \{ id state \} \}/);
  assert.match(ITEM_FIELDS, /subIssues\(first: 50\) \{ nodes \{ id state \} \}/);
});

test('a poll\'s listed item carries parent, children and closedChildren, linked before the column and filter steps drop anything; a leaf carries none of them (#28)', async () => {
  const hive = (n: number, subIssues: number[] = [], status = 'Ready', closed: number[] = []) => {
    const node = linked(n, subIssues, status, closed);
    return { ...node, content: { ...node.content, labels: { nodes: [{ name: 'hive' }] } } };
  };
  const labelled = specOf({ source: { ...GITHUB_SOURCE, epics: 'ignore', filter: [{ field: 'label', op: 'any', values: ['hive'] }] } });
  // 1 lists 2 (listed), 3 (filtered out: no label), 9 (no item) and 4 (closed, in the uncited Done); 5 is a leaf
  const nodes = [hive(1, [2, 3, 9, 4], 'Ready', [4]), hive(2), linked(3), hive(4, [], 'Done'), hive(5)];
  const listed = await createSource(labelled, { gql: fakeGql({ items: page(nodes), relations: {} }).gql }).listItems();
  assert.deepEqual(listed.map((c) => c.item.id), ['1', '2', '5']);
  const [parent, child, leaf] = listed.map((c) => c.item);
  assert.deepEqual([parent.parent, parent.children, parent.closedChildren], [undefined, ['I2', 'I3', 'I4'], ['I4']]);
  assert.deepEqual([child.parent, 'children' in child, 'closedChildren' in child], ['I1', false, false]);
  assert.deepEqual(['parent' in leaf, 'children' in leaf, 'closedChildren' in leaf], [false, false, false]);
});

test('listItems groups before it drops: with epics: hide the epic\'s sub-issues take its place, with epics: ignore they follow it; the items query asks each issue for its node id and its sub-issue ids, at no extra call (#211)', async () => {
  // A B C D F G, where B (2) is an epic with sub-issues F (6) then G (7)
  const nodes = [linked(1), linked(2, [6, 7]), linked(3), linked(4), linked(6), linked(7)];
  const { gql, calls } = fakeGql({ items: page(nodes), relations: {} });
  assert.deepEqual((await createSource(hidden, { gql }).listItems()).map((c) => c.item.id), ['1', '6', '7', '3', '4'], 'A F G C D');
  const kept = await createSource(ignored, { gql: fakeGql({ items: page(nodes), relations: {} }).gql }).listItems();
  assert.deepEqual(kept.map((c) => c.item.id), ['1', '2', '6', '7', '3', '4'], 'A B F G C D');
  assert.match(calls[0].query, /\.\.\. on Issue \{ id number .* subIssues\(first: 50\) \{ nodes \{ id state \} \}/);
  assert.deepEqual(calls.map((c) => c.name), ['items', 'relations'], 'the grouping costs no call of its own');
});

test('an epic the task filter hides still lends its place to the sub-issues that pass the filter, even under epics: ignore (#211)', async () => {
  const hive = (n: number) => ({ ...linked(n), content: { ...linked(n).content, labels: { nodes: [{ name: 'hive' }] } } });
  const labelled = specOf({ source: { ...GITHUB_SOURCE, epics: 'ignore', filter: [{ field: 'label', op: 'any', values: ['hive'] }] } });
  // the epic 2 (no label) lists 6 (labelled) and 7 (no label); 3 sits between them on the source
  const { gql } = fakeGql({ items: page([hive(1), linked(2, [6, 7]), hive(3), hive(6), linked(7)]), relations: {} });
  assert.deepEqual((await createSource(labelled, { gql }).listItems()).map((c) => c.item.id), ['1', '6', '3'], 'the epic and 7 are filtered out; 6 still takes the epic\'s place');
});

test('the relations query covers every listed task whatever its column: a task outside a prompt-entry column gets its blockedBy too (#441)', async () => {
  const nodes = [item(1), { ...item(2), fieldValueByName: { name: 'In progress' } }, { ...item(3), fieldValueByName: { name: 'In review' } }];
  const { gql, calls } = fakeGql({ items: page(nodes), relations: { i0: relations([[7, 'OPEN']]), i2: relations([[8, 'OPEN'], [9, 'CLOSED']]) } });
  const tasks = await createSource(config, { gql }).listItems();
  assert.deepEqual(tasks.map((c) => [c.item.id, c.item.blockedBy]), [['1', ['7']], ['2', undefined], ['3', ['8']]], 'board order is kept');
  const relationCalls = calls.filter((c) => c.name === 'relations');
  assert.equal(relationCalls.length, 1, 'still one query per poll');
  assert.match(relationCalls[0].query, /i1: repository\(owner: "acme", name: "r"\) \{ issue\(number: 2\)/);
  assert.match(relationCalls[0].query, /i2: repository\(owner: "acme", name: "r"\) \{ issue\(number: 3\)/);
});

test('quota is what the last poll read from the rateLimit field: no call of its own, undefined before the first poll', async () => {
  const { gql, calls } = fakeGql({ items: page([item(1)]), relations: {} });
  const source = createSource(config, { gql });
  assert.equal(await source.quota!(), undefined, 'nothing polled yet');
  const before = Date.now();
  await source.listItems();
  const quota = await source.quota!();
  assert.equal(quota?.limit, 5000);
  assert.equal(quota?.remaining, 4320);
  assert.equal(quota?.resetsAt, '2026-09-16T13:00:00.000Z');
  assert.ok(quota && Date.parse(quota.at) >= before && Date.parse(quota.at) <= Date.now(), 'at is when it was read');
  assert.deepEqual(calls.map((c) => c.name), ['items', 'relations'], 'the REST rate_limit call is gone');
});

test('quota stays undefined for an unexpected rateLimit shape', async () => {
  const shapes: unknown[] = [
    null, {}, { limit: '5000', remaining: 1, resetAt: 'x' }, { limit: 5000, remaining: 1 },
    { limit: 5000, remaining: 1, resetAt: 5 }, { limit: 5000, remaining: null, resetAt: 'x' },
  ];
  for (const rateLimit of shapes) {
    const source = createSource(config, { gql: fakeGql({ items: { ...page([]), rateLimit }, relations: {} }).gql });
    await source.listItems();
    assert.equal(await source.quota!(), undefined, JSON.stringify(rateLimit));
  }
});

test('a failing poll rejects and never degrades into no blockers or a stale quota', async () => {
  const { gql } = fakeGql({ items: page([item(1)]) }); // the relations query has no answer: the whole poll fails
  const source = createSource(config, { gql });
  await assert.rejects(source.listItems(), /unexpected graphql call: relations/);
});

test('createSource with a log wraps the Gql: every call leaves a debug line with the variables, the query (cut at 200 chars), the duration and ok / error, and errors rethrow', async () => {
  const { log, lines } = fakeLog();
  const { gql } = fakeGql({ fields, items: page([item(1)]), relations: {} });
  const source = createSource(config, { gql, log });
  assert.deepEqual(await source.settingsOptions(), ['Ready', 'In progress', 'In review', 'Done']);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^DEBUG graphql \{"login":"acme","number":6\} query.{0,200}… \d+ms ok$/);
  assert.match(lines[0], /^DEBUG graphql .{200}… \d+ms ok$/, 'the head is cut at 200 characters');
  assert.ok(!lines[0].includes('O_ready'), 'the response is never logged');
  await source.listItems(); // items + one relations query
  assert.ok(lines.some((l) => l.includes('blockedBy(first: 50)') || l.startsWith('DEBUG graphql {} query')), lines.join('\n'));
  await assert.rejects(source.setColumn('x', 'Ready'), /not resolved/); // thrown before the call: no graphql line
  const failing = createSource(config, { gql: fakeGql({}).gql, log });
  await assert.rejects(failing.listItems(), /unexpected graphql call: items/);
  assert.match(lines.at(-1) as string, /ms error: unexpected graphql call: items$/);
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => l.startsWith('DEBUG ')), 'graphql calls are debug only');
});

test('listProjects lists only open projects as { number, title, url }', async () => {
  const nodes = [
    { number: 6, title: 'Roadmap', url: 'https://github.com/users/acme/projects/6', closed: false },
    { number: 2, title: 'Antigo', url: 'https://github.com/users/acme/projects/2', closed: true },
  ];
  const { gql, calls } = fakeGql({ projects: { repositoryOwner: { projectsV2: { nodes } } } });
  assert.deepEqual(await listProjects('acme', gql), [{ number: 6, title: 'Roadmap', url: 'https://github.com/users/acme/projects/6' }]);
  assert.deepEqual(calls[0].variables, { login: 'acme' });
  assert.deepEqual(await listProjects('acme', fakeGql({ projects: { repositoryOwner: null } }).gql), [], 'an owner with nothing is empty, not a failure');
});

test('@me, the gh CLI shorthand, resolves to the logged-in user before any project query', async () => {
  const nodes = [{ number: 6, title: 'Roadmap', url: 'https://github.com/users/dennys/projects/6', closed: false }];
  const { gql, calls } = fakeGql({ viewer: { viewer: { login: 'dennys' } }, projects: { repositoryOwner: { projectsV2: { nodes } } }, fields });
  assert.equal((await listProjects('@me', gql)).length, 1);
  assert.deepEqual(calls[1].variables, { login: 'dennys' });
  await listStatusOptions('@me', 6, gql);
  assert.deepEqual(calls.at(-1)?.variables, { login: 'dennys', number: 6 });
});

test('listStatusOptions returns the Status option names in source order without resolveFields', async () => {
  const { gql, calls } = fakeGql({ fields });
  assert.deepEqual(await listStatusOptions('acme', 6, gql), ['Ready', 'In progress', 'In review', 'Done']);
  assert.deepEqual(calls[0].variables, { login: 'acme', number: 6 });
});

test('listStatusOptions fails when the source has no single-select Status field', async () => {
  const noField = { repositoryOwner: { projectV2: { id: 'PVT_1', field: null } } };
  await assert.rejects(listStatusOptions('acme', 6, fakeGql({ fields: noField }).gql), /"Status"/);
});

test('settingsOptions on a github source lists the Status option names in source order', async () => {
  const { gql, calls } = fakeGql({ fields });
  assert.deepEqual(await createSource(config, { gql }).settingsOptions(), ['Ready', 'In progress', 'In review', 'Done']);
  assert.equal(calls.length, 1);
});

const COMMENT_NODES = [
  { author: { login: 'dennys-bd' }, createdAt: '2026-09-20T10:00:00Z', body: '## plan\n- [x] spec', url: 'https://github.com/acme/r/issues/1#issuecomment-1' },
  { author: null, createdAt: '2026-09-21T10:00:00Z', body: 'lgtm', url: 'https://github.com/acme/r/issues/1#issuecomment-2' },
];

test('comments asks the item node once for its issue\'s first 100 comments and keeps GitHub\'s order (oldest first); a deleted author reads ghost', async () => {
  const { gql, calls } = fakeGql({ comments: { node: { content: { comments: { nodes: COMMENT_NODES } } } } });
  const comments = await createSource(config, { gql }).comments!('PVTI_1');
  assert.deepEqual(calls.map((c) => [c.name, c.variables]), [['comments', { id: 'PVTI_1' }]], 'one call, by the item id the Hive already holds');
  assert.match(calls[0].query, /comments\(first: 100\)/);
  assert.deepEqual(comments, [
    { author: 'dennys-bd', createdAt: '2026-09-20T10:00:00Z', body: '## plan\n- [x] spec', url: 'https://github.com/acme/r/issues/1#issuecomment-1' },
    { author: 'ghost', createdAt: '2026-09-21T10:00:00Z', body: 'lgtm', url: 'https://github.com/acme/r/issues/1#issuecomment-2' },
  ]);
});

test('comments resolves [] for an item that is gone or whose content is not an issue, and rejects when the call fails', async () => {
  // node null: gone; content {}: a draft or a pull request (the Issue fragment selects nothing); content null: no content at all
  for (const data of [{ node: null }, { node: {} }, { node: { content: null } }, { node: { content: {} } }]) {
    assert.deepEqual(await createSource(config, { gql: fakeGql({ comments: data }).gql }).comments!('I1'), [], JSON.stringify(data));
  }
  await assert.rejects(createSource(config, { gql: fakeGql({}).gql }).comments!('I1'), /unexpected graphql call: comments/);
});

test('listItems keeps only the issues every rule passes, before the relations query: no alias is spent on the rest (#245)', async () => {
  const { gql, calls } = fakeGql({
    items: page([
      issue(1, { repository: 'acme/app', fields: { Priority: 'P0' } }),
      issue(2, { repository: 'acme/site', fields: { Priority: 'P0' } }),
      issue(3, { repository: 'ACME/app', fields: { Priority: 'P2' } }),
      issue(4, { repository: 'acme/app', labels: ['blocked'], fields: { Priority: 'P1' } }),
      issue(5, { repository: 'acme/app', fields: { Priority: 'P1' } }),
    ]),
    relations: {},
  });
  const rules: TaskFilter = [
    { field: 'repository', op: 'any', values: ['acme/app'] },
    { field: 'projectField', name: 'Priority', op: 'any', values: ['P0', 'P1'] },
    { field: 'label', op: 'none', values: ['blocked'] },
  ];
  const tasks = await createSource(filtered(rules), { gql }).listItems();
  assert.deepEqual(tasks.map((c) => c.item.id), ['1', '5']);
  const { query } = calls.find((c) => c.name === 'relations')!;
  assert.match(query, /i0: repository\(owner: "acme", name: "r"\) \{ issue\(number: 1\)/);
  assert.match(query, /i1: repository\(owner: "acme", name: "r"\) \{ issue\(number: 5\)/);
  assert.ok(!query.includes('i2:'), 'the filtered-out issues cost no relations lookup');
});

test('a blocked source rule is judged after the other rules, on the blockers the poll just read: none keeps the free tasks, any the blocked ones, an item a label rule drops costs no alias, and a task comes back once its blockers close (#441)', async () => {
  const nodes = [issue(1, { labels: ['hive'] }), issue(2, { labels: ['hive'] }), issue(3), { ...issue(4, { labels: ['hive'] }), fieldValueByName: { name: 'In review' } }];
  // the label rule keeps 1, 2 and 4, queried as i0, i1, i2; 1 and 4 are blocked, 4 outside a prompt-entry column
  const blockedThen = { i0: relations([[7, 'OPEN']]), i1: relations([]), i2: relations([[8, 'OPEN']]) };
  const closedNow = { i0: relations([[7, 'CLOSED']]), i1: relations([]), i2: relations([[8, 'OPEN']]) };
  const { gql, calls } = fakeGql({ items: [page(nodes), page(nodes)], relations: [blockedThen, closedNow] });
  const free = createSource(filtered([{ field: 'label', op: 'any', values: ['hive'] }, { field: 'blocked', op: 'none' }]), { gql });
  assert.deepEqual((await free.listItems()).map((c) => c.item.id), ['2']);
  const { query } = calls.find((c) => c.name === 'relations')!;
  assert.ok(!query.includes('issue(number: 3)'), 'the item the label rule dropped gets no alias');
  assert.deepEqual((await free.listItems()).map((c) => c.item.id), ['1', '2'], 'next poll: #7 closed, 1 is back');
  const onlyBlocked = fakeGql({ items: page(nodes), relations: blockedThen });
  const tasks = await createSource(filtered([{ field: 'label', op: 'any', values: ['hive'] }, { field: 'blocked', op: 'any' }]), { gql: onlyBlocked.gql }).listItems();
  assert.deepEqual(tasks.map((c) => [c.item.id, c.item.blockedBy]), [['1', ['7']], ['4', ['8']]]);
});

test('@me in an assignee rule costs one VIEWER call in resolveFields, kept for the adapter lifetime, and matches that login on every poll', async () => {
  const { gql, calls } = fakeGql({
    fields, viewer: { viewer: { login: 'Ana' } },
    items: [page([issue(1, { assignees: ['ana'] }), issue(2, { assignees: ['bia'] })]), page([issue(1, { assignees: ['ana'] })])],
    relations: {},
  });
  const source = createSource(filtered([{ field: 'assignee', op: 'any', values: ['@me'] }]), { gql });
  await source.resolveFields();
  assert.deepEqual(calls.map((c) => c.name), ['fields', 'viewer'], 'the Status field first: a source error is still named before @me');
  assert.deepEqual((await source.listItems()).map((c) => c.item.id), ['1']);
  await source.resolveFields();
  await source.listItems();
  assert.equal(calls.filter((c) => c.name === 'viewer').length, 1, 'resolved once, kept');
});

test('without @me in an assignee rule resolveFields never asks for the viewer, and a viewer with no login rejects naming @me', async () => {
  const plain = fakeGql({ fields }); // a viewer call would reject with "unexpected graphql call: viewer"
  const noMe: TaskFilter = [{ field: 'assignee', op: 'any', values: ['ana'] }, { field: 'label', op: 'any', values: ['@me'] }];
  await createSource(filtered(noMe), { gql: plain.gql }).resolveFields();
  assert.deepEqual(plain.calls.map((c) => c.name), ['fields'], '@me on a label rule is just a label');
  const nobody = fakeGql({ fields, viewer: { viewer: null } });
  await assert.rejects(
    createSource(filtered([{ field: 'assignee', op: 'none', values: ['@me'] }]), { gql: nobody.gql }).resolveFields(),
    { message: 'could not resolve "@me": the GitHub login has no user' },
  );
});

test('a source with no rule sets no workspaceHint and gives every task autoOnEntry from its default, on today\'s items query (#293, #688)', async () => {
  const { gql, calls } = fakeGql({ items: page([issue(1, { fields: { Repo: 'site' } })]), relations: {} });
  const [task] = await createSource(config, { gql }).listItems();
  assert.equal('workspaceHint' in task.item, false);
  assert.equal(task.item.autoOnEntry, true, 'FIXED: auto on');
  const manual = specOf({ source: { ...GITHUB_SOURCE, taskProps: { ...FIXED, defaults: { ...FIXED.defaults, auto: false } } } });
  const [off] = await createSource(manual, { gql: fakeGql({ items: page([issue(1)]), relations: {} }).gql }).listItems();
  assert.equal(off.item.autoOnEntry, false);
  const items = calls.find((c) => c.name === 'items')!;
  assert.deepEqual(items.variables, { login: 'acme', number: 6 });
  assert.equal(items.query, ITEMS);
});

test('rules ride the very same query (#245): workspaceHint comes only from a rule; autoOnEntry from the first matching rule that sets auto, else the default; '
  + 'a workspace-only rule never shadows an auto one (#293, #688)', async () => {
  const workspaces = ['api', 'site', 'web', 'ops'].map((name) => ({ name, path: `/${name}`, env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }));
  const rules: TaskRule[] = [
    { field: 'labels', op: 'iequals', value: 'backend', set: { workspace: 'api' } },
    { field: 'Repo', op: 'equals', value: 'site', set: { workspace: 'site', auto: false } },
    { field: 'title', op: 'icontains', value: '[web]', set: { workspace: 'web' } },
    { field: 'Area', op: 'contains', value: 'ops', set: { workspace: 'ops' } },
    { field: 'Repo', op: 'equals', value: 'api', set: { workspace: 'api' } },
  ];
  const dynamic = specOf({ workspaces, source: { ...GITHUB_SOURCE, taskProps: { defaults: { auto: true }, rules } } });
  const nodes = [
    issue(1, { labels: ['bug', 'Backend'] }),
    issue(2, { fields: { Repo: 'site' } }),
    { ...item(3), content: { ...item(3).content, title: '[Web] login' } },
    issue(4, { textFields: { Area: ' devops ' } }),
    issue(5, { labels: ['backend'], fields: { Repo: 'site' } }),
    issue(6),
  ];
  const { gql, calls } = fakeGql({ items: page(nodes), relations: {} });
  const tasks = await createSource(dynamic, { gql }).listItems();
  assert.deepEqual(tasks.map((c) => c.item.workspaceHint), ['api', 'site', 'web', 'ops', 'api', undefined], 'item 5 matches rules 1 and 2: rule 1 gives the workspace');
  assert.deepEqual(tasks.map((c) => c.item.autoOnEntry), [true, false, true, true, false, true], 'item 5 still takes auto from rule 2; item 6 matches nothing: the default');
  assert.equal('workspaceHint' in tasks[5].item, false, 'no match: no key');
  const items = calls.find((c) => c.name === 'items')!;
  assert.equal(items.query, ITEMS, 'the rule fields ride the task filter\'s own fieldValues fetch (#245): no per-field alias, no extra variable');
});

test('a listed issue task carries its facets for the columns\' view filter, read off the same items query (#374): Status and text fields left out, a bare issue with empty ones', async () => {
  const nodes = [
    issue(1, { assignees: ['ana'], labels: ['bug'], milestone: 'v1', repository: 'acme/r', fields: { Status: 'Ready', Priority: 'P1' }, textFields: { Area: 'ops' } }),
    item(2),
  ];
  const { gql, calls } = fakeGql({ items: page(nodes), relations: {} });
  const tasks = await createSource(config, { gql }).listItems();
  assert.deepEqual(tasks.map((c) => c.item.facets), [
    { assignees: ['ana'], labels: ['bug'], milestone: 'v1', repository: 'acme/r', fields: { Priority: 'P1' } },
    NO_FACETS,
  ]);
  assert.equal(calls.find((c) => c.name === 'items')?.query, ITEMS, 'no new query and no new cost');
});

test('namespaced lists <name>:<id> with the source set, qualifies the id with the prefix (else the name) only under qualifyId, and hands setColumn, apply and comments the adapter\'s own id (#180)', async () => {
  const calls: string[] = [];
  const adapter: Source = {
    resolveFields: async () => {}, settingsOptions: async () => [],
    listItems: async () => [{ item: { itemId: 'PVTI_1', id: '12', title: 'T', body: '', url: '' }, column: 'Ready' }],
    setColumn: async (itemId, column) => { calls.push(`${itemId}→${column}`); },
    apply: async (itemId, action) => { calls.push(`apply ${itemId} ${action.type}`); },
    comments: async (itemId) => { calls.push(`comments ${itemId}`); return []; },
  };
  const entry = (extra: { qualifyId?: boolean; prefix?: string } = {}): SourceConfig => ({ name: 'work', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: FIXED, ...EPICS, ...extra });
  const first = async (source: Source) => (await source.listItems())[0].item;
  assert.deepEqual(await first(namespaced(entry(), adapter)), { itemId: 'work:PVTI_1', id: '12', source: 'work', title: 'T', body: '', url: '' });
  assert.equal((await first(namespaced(entry({ qualifyId: true }), adapter))).id, 'work-12', 'no prefix: the name');
  assert.equal((await first(namespaced(entry({ qualifyId: true, prefix: 'W' }), adapter))).id, 'W-12');
  assert.equal((await first(namespaced(entry({ prefix: 'W' }), adapter))).id, '12', 'a prefix alone qualifies nothing');
  const source = namespaced(entry(), adapter);
  await source.setColumn('work:PVTI_1', 'Done');
  await source.comments?.('work:PVTI_1');
  await source.apply('work:PVTI_1', { type: 'archive' });
  assert.deepEqual(calls, ['PVTI_1→Done', 'comments PVTI_1', 'apply PVTI_1 archive']);
  const { comments: _comments, ...bare } = adapter;
  assert.equal(namespaced(entry(), bare).comments, undefined, 'a source without comments stays without');
  assert.deepEqual([itemSource('work:PVTI_1'), itemSource('local:3'), itemSource('PVTI_1')], ['work', 'local', undefined]);
});

test('namespaced prefixes parent, every children id and every closedChildren id with the source\'s name, as it does itemId (#28)', async () => {
  const adapter: Source = {
    resolveFields: async () => {}, settingsOptions: async () => [], setColumn: async () => {}, apply: async () => {},
    listItems: async () => [{ item: { itemId: 'PVTI_2', id: '2', title: 'T', body: '', url: '', parent: 'PVTI_1', children: ['PVTI_3', 'PVTI_4'], closedChildren: ['PVTI_4'] }, column: 'Ready' }],
  };
  const entry: SourceConfig = { name: 'work', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: FIXED, ...EPICS };
  const [{ item }] = await namespaced(entry, adapter).listItems();
  assert.deepEqual([item.parent, item.children, item.closedChildren], ['work:PVTI_1', ['work:PVTI_3', 'work:PVTI_4'], ['work:PVTI_4']]);
});

test('namespaced wraps project only when the adapter has one: its rows under <name>:<id>, the id still the issue number even under qualifyId (#756)', async () => {
  const view: ProjectView = {
    statuses: [{ name: 'Todo' }], fields: [], builtins: {}, truncated: false,
    items: [{ itemId: 'PVTI_1', id: '12', title: 'T', body: '', url: '', labels: [], assignees: [], fields: {}, pullRequests: [] }],
  };
  const bare: Source = { resolveFields: async () => {}, settingsOptions: async () => [], listItems: async () => [], setColumn: async () => {}, apply: async () => {} };
  const entry: SourceConfig = { name: 'work', qualifyId: true, prefix: 'W', type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: FIXED, ...EPICS };
  assert.equal(namespaced(entry, bare).project, undefined);
  assert.deepEqual(await namespaced(entry, { ...bare, project: async () => view }).project?.(), { ...view, items: [{ ...view.items[0], itemId: 'work:PVTI_1' }] });
});

test('namespaced wraps fieldsOf and setField only when the adapter has them: the adapter gets its own id, the answer comes back under the listed ids (#686)', async () => {
  const asked: string[] = [];
  const bare: Source = { resolveFields: async () => {}, settingsOptions: async () => [], listItems: async () => [], setColumn: async () => {}, apply: async () => {} };
  const entry: SourceConfig = { name: 'work', qualifyId: true, prefix: 'W', type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: FIXED, ...EPICS };
  const written: FieldWrite = {
    fields: [{ name: 'Priority', type: 'singleSelect', value: 'P0', options: ['P0'] }],
    row: { itemId: 'PVTI_1', id: '12', title: 'T', body: '', url: '', labels: [], assignees: [], fields: {}, pullRequests: [] },
    entry: { item: { itemId: 'PVTI_1', id: '12', title: 'T', body: '', url: '' }, column: 'Ready' },
  };
  assert.deepEqual([namespaced(entry, bare).fieldsOf, namespaced(entry, bare).setField], [undefined, undefined]);
  const wrapped = namespaced(entry, {
    ...bare,
    fieldsOf: async (itemId) => { asked.push(itemId); return written.fields; },
    setField: async (itemId, field, value) => { asked.push(`${itemId} ${field}=${String(value)}`); return written; },
  });
  assert.deepEqual(await wrapped.fieldsOf?.('work:PVTI_1'), written.fields);
  const answer = await wrapped.setField?.('work:PVTI_1', 'Priority', 'P0');
  assert.deepEqual(asked, ['PVTI_1', 'PVTI_1 Priority=P0']);
  assert.deepEqual([answer?.row.itemId, answer?.row.id], ['work:PVTI_1', '12']);
  assert.deepEqual(answer?.entry?.item, { itemId: 'work:PVTI_1', id: 'W-12', title: 'T', body: '', url: '', source: 'work' });
  const { entry: _entry, ...unlisted } = written;
  assert.equal((await namespaced(entry, { ...bare, setField: async () => unlisted }).setField?.('work:PVTI_1', 'Priority', 'P0'))?.entry, undefined);
});

test('namespaced shows a short blocker id like the item\'s own under qualifyId, keeps owner/repo#n, and hands relate the adapter\'s ids back (#56)', async () => {
  const blockers = { blockedBy: [{ id: '7', title: 'T7', state: 'open' as const }, { id: 'other/lib#3', title: 'T3', state: 'closed' as const }], blocking: [{ id: '5', title: 'T5', state: 'open' as const }] };
  const shown = { blockedBy: [{ ...blockers.blockedBy[0], id: 'W-7' }, blockers.blockedBy[1]], blocking: [{ ...blockers.blocking[0], id: 'W-5' }] };
  const listedItem = { itemId: 'PVTI_1', id: '12', title: 'T', body: '', url: '', blockers };
  const asked: string[] = [];
  const bare: Source = {
    resolveFields: async () => {}, settingsOptions: async () => [], setColumn: async () => {}, apply: async () => {},
    listItems: async () => [{ item: listedItem, column: 'Ready' }],
  };
  const adapter: Source = { ...bare, relate: async (itemId, change) => { asked.push(`${itemId} ${change.ref}`); return { blockers, entry: { item: listedItem, column: 'Ready' } }; } };
  const entry = (qualifyId: boolean): SourceConfig => ({ name: 'work', qualifyId, prefix: 'W', type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: FIXED, ...EPICS });
  const qualified = namespaced(entry(true), adapter);
  assert.deepEqual((await qualified.listItems())[0].item.blockers, shown);
  const answer = await qualified.relate?.('work:PVTI_1', { action: 'add', kind: 'blockedBy', ref: 'W-7' });
  assert.deepEqual([answer?.blockers, answer?.entry?.item.blockers, answer?.entry?.item.itemId], [shown, shown, 'work:PVTI_1']);
  await qualified.relate?.('work:PVTI_1', { action: 'add', kind: 'blockedBy', ref: 'other/lib#3' });
  assert.deepEqual(asked, ['PVTI_1 7', 'PVTI_1 other/lib#3'], 'the adapter gets its own ids');
  assert.deepEqual((await namespaced(entry(false), adapter).listItems())[0].item.blockers, blockers, 'unqualified: as the adapter reads them');
  assert.equal(namespaced(entry(true), bare).relate, undefined);
  const failing = namespaced(entry(true), { ...bare, relate: async () => { throw new RelationRereadError('timeout', blockers); } });
  assert.ok(failing.relate);
  await assert.rejects(failing.relate('work:PVTI_1', { action: 'add', kind: 'blockedBy', ref: '7' }), (err: unknown) => {
    assert.ok(err instanceof RelationRereadError);
    assert.deepEqual(err.blockers, shown, 'a failed re-read still answers shown ids');
    return true;
  });
});

test('namespaced hands findBlockers the adapter\'s id and shows a found short id like the item\'s own under qualifyId (#57)', async () => {
  const found = [{ id: '12', title: 'Pager', state: 'open' as const }, { id: 'other/lib#3', title: 'T3', state: 'closed' as const }];
  const asked: string[] = [];
  const bare: Source = { resolveFields: async () => {}, settingsOptions: async () => [], listItems: async () => [], setColumn: async () => {}, apply: async () => {} };
  const adapter: Source = { ...bare, findBlockers: async (itemId, text) => { asked.push(`${itemId} ${text}`); return found; } };
  const entry = (qualifyId: boolean): SourceConfig => ({ name: 'work', qualifyId, prefix: 'foo', type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: FIXED, ...EPICS });
  assert.deepEqual(await namespaced(entry(true), adapter).findBlockers?.('work:PVTI_1', 'pag'), [{ ...found[0], id: 'foo-12' }, found[1]]);
  assert.deepEqual(await namespaced(entry(false), adapter).findBlockers?.('work:PVTI_1', 'pag'), found, 'unqualified: as the adapter finds them');
  assert.deepEqual(asked, ['PVTI_1 pag', 'PVTI_1 pag'], 'the adapter gets its own id');
  assert.equal(namespaced(entry(true), bare).findBlockers, undefined);
});

test('createSources builds one namespaced source per entry in order; given the live sources it keeps each instance whose entry (its epics keys included), columns and auth did not change; resolveSources names the source that fails (#180)', async () => {
  const notes = { name: 'notes', qualifyId: false, ...GITHUB_SOURCE, number: 8, taskProps: FIXED };
  const configOf = (work: Record<string, unknown>) =>
    parseConfig(combConfig({ sources: [work, notes], stages: [{ name: 'dev', from: { work: ['Ready'], notes: ['todo'] } }] }));
  const built: string[] = [];
  const build = (spec: SourceSpec): Source => {
    built.push(spec.source.name);
    const fails = spec.source.name === 'notes';
    return { resolveFields: async () => { if (fails) throw new Error('no project'); }, listItems: async () => [], setColumn: async () => {}, apply: async () => {}, settingsOptions: async () => [] };
  };
  const first = configOf({ name: 'work', qualifyId: false, ...GITHUB_SOURCE, taskProps: FIXED });
  const live = createSources(first, build);
  assert.deepEqual([[...live.keys()], built], [['work', 'notes'], ['work', 'notes']]);
  const next = configOf({ name: 'work', qualifyId: false, ...GITHUB_SOURCE, taskProps: FIXED, number: 7 });
  const rebuilt = createSources(next, build, { config: first, sources: live });
  assert.deepEqual(built.slice(2), ['work'], 'only the changed entry is built again');
  assert.equal(rebuilt.get('notes'), live.get('notes'));
  assert.notEqual(rebuilt.get('work'), live.get('work'));
  const hiding = configOf({ name: 'work', qualifyId: false, ...GITHUB_SOURCE, taskProps: FIXED, number: 7, epics: 'hide' });
  createSources(hiding, build, { config: next, sources: rebuilt });
  assert.deepEqual(built.slice(3), ['work'], 'a change of the epics keys builds the source again (#30)');
  await assert.rejects(resolveSources(live), { message: 'source notes: no project' });
});

test('listFilterOptions reads every item page and the project\'s single-select fields: distinct values sorted case-insensitively, @me first, Status left out (#245)', async () => {
  const { gql, calls } = fakeGql({
    items: [
      page([issue(1, { assignees: ['bia', 'Ana'], labels: ['hive'], milestone: 'v2', repository: 'acme/site' }), item(2)], true, 'C1'),
      page([issue(3, { assignees: ['ana'], labels: ['Bug', 'hive'], milestone: 'v1', repository: 'acme/app' })]),
    ],
    selectFields: { repositoryOwner: { projectV2: { fields: { nodes: [{ name: 'Status', options: [{ name: 'Ready' }] }, {}, { name: 'Priority', options: [{ name: 'P0' }, { name: 'P1' }] }] } } } },
  });
  assert.deepEqual(await listFilterOptions('acme', 6, gql), {
    assignees: ['@me', 'Ana', 'bia'], labels: ['Bug', 'hive'], milestones: ['v1', 'v2'], repositories: ['acme/app', 'acme/site'],
    projectFields: [{ name: 'Priority', options: ['P0', 'P1'] }],
    linkedRepositories: [],
  });
  assert.deepEqual(calls.map((c) => c.name), ['items', 'items', 'selectFields'], 'the poll\'s own pages, then the fields');
  assert.deepEqual(calls[1].variables, { login: 'acme', number: 6, after: 'C1' });
  assert.deepEqual(calls[2].variables, { login: 'acme', number: 6 });
});

test('listFilterOptions resolves an @me owner through the viewer first, offers @me on an empty source, and names a missing project (#245)', async () => {
  const mine = fakeGql({ viewer: { viewer: { login: 'ana' } }, items: page([]), selectFields: { repositoryOwner: { projectV2: { fields: { nodes: [] } } } } });
  assert.deepEqual(await listFilterOptions('@me', 6, mine.gql), { assignees: ['@me'], labels: [], milestones: [], repositories: [], projectFields: [], linkedRepositories: [] });
  assert.deepEqual(mine.calls.map((c) => [c.name, c.variables?.login]), [['viewer', undefined], ['items', 'ana'], ['selectFields', 'ana']]);
  const gone = fakeGql({ items: { repositoryOwner: null } });
  await assert.rejects(listFilterOptions('acme', 9, gone.gql), { message: 'source not found: no GitHub Project 9 for "acme"' });
});

test('listItems reads the issue\'s createdAt into the item; an issue without one has none (#742)', async () => {
  const nodes = [{ ...item(1), content: { ...item(1).content, createdAt: '2026-09-01T10:00:00Z' } }, item(2)];
  const tasks = await createSource(config, { gql: fakeGql({ items: page(nodes), relations: {} }).gql }).listItems();
  assert.deepEqual(tasks.map((c) => c.item.createdAt), ['2026-09-01T10:00:00Z', undefined]);
});

test('namespaced maps stored as it maps listItems: the same prefixed ids, source, qualified id and tree names; no stored, none (#191)', async () => {
  const listed = [{ item: { itemId: 'PVTI_2', id: '2', title: 'T', body: '', url: '', parent: 'PVTI_1' }, column: 'Ready' }];
  const bare: Source = { resolveFields: async () => {}, settingsOptions: async () => [], setColumn: async () => {}, apply: async () => {}, listItems: async () => listed };
  const entry: SourceConfig = { name: 'work', qualifyId: true, prefix: 'W', type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: FIXED, ...EPICS };
  assert.equal(namespaced(entry, bare).stored, undefined);
  const wrapped = namespaced(entry, { ...bare, stored: async () => listed });
  const stored = await wrapped.stored?.();
  assert.deepEqual(stored, await wrapped.listItems());
  assert.deepEqual([stored?.[0].item.itemId, stored?.[0].item.id, stored?.[0].item.parent], ['work:PVTI_2', 'W-2', 'work:PVTI_1']);
});

// #291: a source whose resolveFields fails as `fail` says, every call recorded; gh's words when the network is down
const OFFLINE = 'gh api graphql: error connecting to api.github.com';
function resolving(fail: () => Error | undefined): { source: Source; calls: string[] } {
  const calls: string[] = [];
  const source: Source = {
    resolveFields: async () => {
      calls.push('resolve');
      const err = fail();
      if (err) throw err;
    },
    listItems: async () => {
      calls.push('list');
      return [];
    },
    setColumn: async () => {}, apply: async () => {}, settingsOptions: async () => [],
  };
  return { source, calls };
}

test('resolveSources with deferOffline keeps an offline source, wrapped: its listItems resolves first and retries on every call until a resolve succeeds, then only lists; a resolved source comes back as it is (#291)', async () => {
  let isOnline = false;
  const offline = resolving(() => (isOnline ? undefined : new Error(OFFLINE)));
  const fine = resolving(() => undefined);
  const { log, lines } = fakeLog();
  const sources = await resolveSources(new Map([['work', offline.source], ['notes', fine.source]]), { deferOffline: true, log });
  assert.deepEqual([...sources.keys()], ['work', 'notes']);
  assert.equal(sources.get('notes'), fine.source, 'a resolved source is not wrapped');
  const work = sources.get('work');
  assert.ok(work !== undefined && work !== offline.source);
  assert.equal(work.setColumn, offline.source.setColumn, 'every other method passes through');
  await assert.rejects(work.listItems(), { message: OFFLINE });
  isOnline = true;
  await work.listItems();
  await work.listItems();
  assert.deepEqual(offline.calls, ['resolve', 'resolve', 'resolve', 'list', 'list'], 'boot, the failed retry, the good one; then lists only');
  assert.deepEqual(lines, [`WARN source work: offline at boot, resolved on a later poll (${OFFLINE})`, 'INFO source work: resolved on a later poll']);
});

test('a deferred source resolved by a Settings save (its resolveFields, as createSources reuses it) does not resolve again on its next poll (#291)', async () => {
  let isOnline = false;
  const offline = resolving(() => (isOnline ? undefined : new Error(OFFLINE)));
  const work = (await resolveSources(new Map([['work', offline.source]]), { deferOffline: true })).get('work');
  assert.ok(work);
  isOnline = true;
  await resolveSources(new Map([['work', work]]));
  await work.listItems();
  assert.deepEqual(offline.calls, ['resolve', 'resolve', 'list']);
});

test('resolveSources rejects naming the source on a failure that is not the network, with deferOffline in a mixed map too; without the option an offline failure rejects as before and nothing is wrapped (#291)', async () => {
  const offline = resolving(() => new Error(OFFLINE));
  const gone = resolving(() => new Error('source not found: no GitHub Project 9 for "acme"'));
  await assert.rejects(resolveSources(new Map([['work', offline.source], ['notes', gone.source]]), { deferOffline: true }),
    { message: 'source notes: source not found: no GitHub Project 9 for "acme"' });
  await assert.rejects(resolveSources(new Map([['work', offline.source]])), { message: `source work: ${OFFLINE}` });
  const fine = resolving(() => undefined);
  assert.equal((await resolveSources(new Map([['notes', fine.source]]))).get('notes'), fine.source);
});
