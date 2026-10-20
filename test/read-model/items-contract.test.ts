import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/config.js';
import { openReadModel, type ReadModel } from '../../src/read-model/db.js';
import { readListing, storeListing, type ItemStore, type ListingKey } from '../../src/read-model/items.js';
import { createSource, sourceSpec } from '../../src/source.js';
import { projectFields, projectItem, type ProjectRead } from '../../src/sources/github-project.js';
import type { GhBlockerRef, GhItemNode, GhProjectField, GhPullRequest, RelationsData } from '../../src/sources/github-queries.js';
import type { SourceItem } from '../../src/types.js';
import { combConfig, FIXED, fakeGql } from '../fakes.js';
import { itemNode, SOURCE, T1, T2 } from './fixtures.js';

// #190, #282: the read model's contract. Every consumer of a stored item answers over it what it answers over the wire's node: listed() (the
// poll's steps), projectItem() (the native view's row) and, once the repository's options are stored, itemFields() (the editors)
const PROJECT = 'acme/6';
const KEY: ListingKey = { source: SOURCE, project: PROJECT, scope: PROJECT };
type Content = NonNullable<GhItemNode['content']>;
const ref = (number: number, state: string, repo = 'acme/r'): GhBlockerRef => ({ number, title: `T${number}`, state, repository: { nameWithOwner: repo } });
const sub = (number: number, state: 'OPEN' | 'CLOSED') => ({ id: `I_${number}`, number, title: `T${number}`, state, repository: { nameWithOwner: 'acme/r' } });
const pr = (number: number, state: string, rollup?: string, isDraft = false): GhPullRequest =>
  ({ number, url: `https://github.com/acme/r/pull/${number}`, state, merged: state === 'MERGED', isDraft, statusCheckRollup: rollup === undefined ? null : { state: rollup } });
const hive = (n: number, status: string, content: Partial<Content> = {}, extra: Partial<GhItemNode> = {}): GhItemNode =>
  itemNode(n, status, T1, { labels: { nodes: [{ name: 'hive' }] }, ...content }, extra);
// Every kind of set value: single-select, text, number, date, iteration
const EVERY_VALUE = { nodes: [
  { name: 'Ready', field: { name: 'Status' } }, { name: 'P1', field: { name: 'Priority' } }, { text: 'api', field: { name: 'Area' } },
  { number: 3.5, field: { name: 'Estimate' } }, { date: '2026-10-20', field: { name: 'Due' } }, { title: 'Sprint 1', field: { name: 'Sprint' } },
] };
// The Project's fields as the items read answers them: every kind the view renders, the fixed columns' and one it cannot read
const RAW_FIELDS: GhProjectField[] = [
  { name: 'Title', dataType: 'TITLE' }, { name: 'Assignees', dataType: 'ASSIGNEES' },
  { name: 'Status', dataType: 'SINGLE_SELECT', options: [{ name: 'Ready' }, { name: 'In progress' }, { name: 'Done' }] },
  { name: 'Labels', dataType: 'LABELS' }, { name: 'Priority', dataType: 'SINGLE_SELECT', options: [{ name: 'P0' }, { name: 'P1' }] },
  { name: 'Area', dataType: 'TEXT' }, { name: 'Estimate', dataType: 'NUMBER' }, { name: 'Due', dataType: 'DATE' },
  { name: 'Sprint', dataType: 'ITERATION', configuration: { iterations: [{ title: 'Sprint 1' }, { title: 'Sprint 2' }] } },
  { name: 'Milestone', dataType: 'MILESTONE' }, { name: 'Repository', dataType: 'REPOSITORY' }, { name: 'Parent issue', dataType: 'PARENT_ISSUE' },
  { name: 'Type', dataType: 'ISSUE_TYPE' }, { name: 'Sub-issues progress', dataType: 'SUB_ISSUES_PROGRESS' }, {},
];
// Lists in name order and closing PRs in number order: the order the read model keeps them in (#282)
const WIRE: GhItemNode[] = [
  hive(1, 'Ready', { subIssuesSummary: { total: 2, completed: 1 }, subIssues: { nodes: [sub(2, 'OPEN'), sub(3, 'CLOSED')] } }), // an epic
  hive(2, 'Ready', {
    assignees: { nodes: [{ login: 'ana' }, { login: 'bia' }] }, labels: { nodes: [{ name: 'bug' }, { name: 'hive' }] }, milestone: { title: 'v1' },
    closedByPullRequestsReferences: { nodes: [pr(30, 'MERGED', 'SUCCESS'), pr(31, 'OPEN', 'FAILURE'), pr(32, 'OPEN', 'PENDING', true), pr(33, 'CLOSED')] },
  }, { fieldValues: EVERY_VALUE }),
  hive(3, 'Done', { state: 'CLOSED', closedAt: T2, parent: { number: 1, title: 'T1' }, issueType: { name: 'Bug' } }), // the epic's closed child
  itemNode(4, 'In progress', T1, { labels: { nodes: [{ name: 'docs' }] } }), // the filter drops it
  hive(5, 'In progress', { blockedBy: { nodes: [ref(2, 'OPEN'), ref(9, 'CLOSED', 'other/lib')] } }), // blocked by #2
  { id: 'PVTI_6', updatedAt: T1, fieldValueByName: { name: 'Ready' }, fieldValues: { nodes: [{ name: 'Ready', field: { name: 'Status' } }] }, content: { __typename: 'DraftIssue' } },
  { id: 'PVTI_7', updatedAt: T1, fieldValueByName: { name: 'Ready' }, fieldValues: { nodes: [{ name: 'Ready', field: { name: 'Status' } }] }, content: { __typename: 'PullRequest' } },
  { id: 'PVTI_8', updatedAt: T1, fieldValueByName: null, fieldValues: { nodes: [] }, content: null },
  hive(10, 'Ready'), // its issue is gone by the time the relations are asked
];
// The relations query's answers for the kept tasks #1, #2, #5 and #10 (i0 to i3), consistent with what each node carries: the contract holds
// whichever of the two the poll reads blockedBy and the sub-issues from (#282 moves them onto the node)
const both = (blockedBy: GhBlockerRef[], blocking: GhBlockerRef[], subIssues: { number: number; state: string }[] = []) =>
  ({ issue: { blockedBy: { nodes: blockedBy }, blocking: { nodes: blocking }, subIssues: { nodes: subIssues } } });
const RELATIONS: RelationsData = {
  i0: both([], [], [{ number: 2, state: 'OPEN' }, { number: 3, state: 'CLOSED' }]),
  i1: both([], [ref(5, 'OPEN')]),
  i2: both([ref(2, 'OPEN'), ref(9, 'CLOSED', 'other/lib')], []),
  i3: { issue: null },
};
const FILTER = [{ field: 'label', op: 'any', values: ['hive'] }];
const READ: ProjectRead = { login: 'acme', number: 6, notFound: 'gone', filter: [{ field: 'label', op: 'any', values: ['hive'] }], me: undefined, epics: 'show', taskProps: FIXED };
const config = parseConfig(combConfig({ source: { type: 'github', owner: 'acme', number: 6, epics: 'show', filter: FILTER } }));
const SPEC = sourceSpec(config, config.comb.sources[0]);
const page = (nodes: GhItemNode[]): unknown => ({ rateLimit: null, repositoryOwner: { projectV2: { fields: { nodes: RAW_FIELDS }, items: { pageInfo: { hasNextPage: false }, nodes } } } });
const listedOver = (nodes: GhItemNode[]): Promise<SourceItem[]> => createSource(SPEC, { gql: fakeGql({ items: page(nodes), relations: RELATIONS }).gql }).listItems();
const memoryModel = async (): Promise<ReadModel> => (await openReadModel(':memory:', { now: () => 1_000 })).db;

// The one place that knows how the nodes are stored and read back: everything below it is the contract
async function storedAndRebuilt(nodes: GhItemNode[]): Promise<GhItemNode[]> {
  const db = await memoryModel();
  storeListing(db, KEY, nodes, new Map());
  return readListing(db, KEY).nodes;
}

test('the contract (#190, #282): listed over the wire nodes deep-equals listed over the same nodes stored and rebuilt', async () => {
  const wire = await listedOver(WIRE);
  assert.deepEqual(wire.map((task) => task.item.id), ['1', '2', '5', '10'], 'the epic, its open child, the blocked task and the one whose issue is gone');
  assert.deepEqual(await listedOver(await storedAndRebuilt(WIRE)), wire);
});

test('the contract (#282): projectItem over every wire node deep-equals projectItem over it stored and rebuilt, drafts, PR items and content-less items included', async () => {
  const fields = projectFields(RAW_FIELDS);
  const rebuilt = await storedAndRebuilt(WIRE);
  assert.equal(rebuilt.length, WIRE.length);
  assert.deepEqual(rebuilt.map((node) => projectItem(node, fields, READ)), WIRE.map((node) => projectItem(node, fields, READ)));
  assert.deepEqual(WIRE.map((node) => projectItem(node, fields, READ) === undefined), [false, false, false, false, false, true, true, true, false], 'the fixtures reach every branch');
});

test('the contract through the adapter (#190): with a store, a full poll and a probe-only one list what the wire path lists', async () => {
  const db = await memoryModel();
  const items: ItemStore = { db, source: async () => SOURCE, notify: () => undefined };
  const probe = { rateLimit: null, repositoryOwner: { projectV2: { updatedAt: T1 } } };
  const { gql, calls } = fakeGql({ probe, items: page(WIRE), relations: RELATIONS });
  const stored = createSource(SPEC, { gql, items });
  const wire = await listedOver(WIRE);
  assert.deepEqual(await stored.listItems(), wire);
  assert.deepEqual(await stored.listItems(), wire, 'read back with the stored relations');
  assert.deepEqual(calls.map((c) => c.name), ['probe', 'items', 'relations', 'probe']);
});
