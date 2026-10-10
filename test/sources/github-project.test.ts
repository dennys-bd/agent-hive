import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/config.js';
import { createSource, sourceSpec } from '../../src/source.js';
import { PROJECT_ITEM_LIMIT } from '../../src/sources/github-project.js';
import { combConfig, fakeGql, FILTER } from '../fakes.js';

const GITHUB_SOURCE = { type: 'github', owner: 'acme', number: 6, filter: FILTER };
const specOf = (extra: Record<string, unknown> = {}) => { const config = parseConfig(combConfig({ source: GITHUB_SOURCE, ...extra })); return sourceSpec(config, config.comb.sources[0]); };
// The Status options: STAGES cites Ready, In progress and In review; Todo and Done are cited by no stage
const OPTIONS = [{ id: 'O_todo', name: 'Todo' }, { id: 'O_ready', name: 'Ready' }, { id: 'O_prog', name: 'In progress' }, { id: 'O_rev', name: 'In review' }, { id: 'O_done', name: 'Done' }];
const FIELDS = { repositoryOwner: { projectV2: { id: 'PVT_1', field: { id: 'F_status', options: OPTIONS } } } };
// Every field kind GitHub answers: the fixed columns' own (TITLE, LABELS), Status, the six the view renders, a parent issue, and a {} it cannot read
const PROJECT_FIELDS = [
  { name: 'Title', dataType: 'TITLE' }, { name: 'Status', dataType: 'SINGLE_SELECT' }, { name: 'Priority', dataType: 'SINGLE_SELECT' },
  { name: 'Notes', dataType: 'TEXT' }, { name: 'Estimate', dataType: 'NUMBER' }, { name: 'Target', dataType: 'DATE' },
  { name: 'Sprint', dataType: 'ITERATION' }, { name: 'Sub-issues progress', dataType: 'SUB_ISSUES_PROGRESS' }, { name: 'Labels', dataType: 'LABELS' },
  { name: 'Parent issue', dataType: 'PARENT_ISSUE' }, {},
];
const page = (nodes: unknown[], hasNextPage = false, endCursor = 'CUR') => ({
  rateLimit: { limit: 5000, remaining: 4000, resetAt: '2026-10-06T13:00:00.000Z' },
  repositoryOwner: { projectV2: { fields: { nodes: PROJECT_FIELDS }, items: { pageInfo: { hasNextPage, endCursor }, nodes } } },
});
const issue = (n: number, extra: Record<string, unknown> = {}, status = 'Todo') => ({
  id: `PVTI_${n}`, fieldValueByName: { name: status }, fieldValues: { nodes: [] },
  content: { __typename: 'Issue', number: n, title: `T${n}`, body: `b${n}`, url: `https://github.com/acme/r/issues/${n}`, ...extra },
});
const pr = (number: number, state: string, rollup?: string, merged = state === 'MERGED') =>
  ({ number, url: `https://github.com/acme/r/pull/${number}`, state, merged, statusCheckRollup: rollup === undefined ? null : { state: rollup } });

test('project maps a page to the native view: the Status options in order, the fields by kind minus the fixed columns, each value by its kind, the hint from a rule (#756)', async () => {
  const rule = { field: 'labels', op: 'icontains', value: 'bug', set: { workspace: 'hive' } };
  const spec = specOf({ epics: 'queue', source: { ...GITHUB_SOURCE, taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [rule] } } });
  const node = {
    ...issue(1, {
      labels: { nodes: [{ name: 'bug' }] }, assignees: { nodes: [{ login: 'ana' }] }, repository: { nameWithOwner: 'acme/r' }, milestone: { title: 'v1' },
      subIssuesSummary: { completed: 2, total: 3 },
    }),
    fieldValues: { nodes: [
      { name: 'Todo', field: { name: 'Status' } }, { name: 'P1', field: { name: 'Priority' } }, { text: 'see #2', field: { name: 'Notes' } },
      { number: 3, field: { name: 'Estimate' } }, { date: '2026-10-20', field: { name: 'Target' } }, { title: 'Sprint 4', field: { name: 'Sprint' } }, {},
    ] },
  };
  const { gql, calls } = fakeGql({ fields: FIELDS, projectItems: page([node]) });
  const source = createSource(spec, { gql });
  await source.resolveFields();
  const view = await source.project!();
  assert.deepEqual(view.statuses, OPTIONS.map(({ name }) => ({ name })), 'every option, cited or not; the stage is the route\'s to add');
  assert.deepEqual(view.fields, [
    { name: 'Priority', type: 'singleSelect' }, { name: 'Notes', type: 'text' }, { name: 'Estimate', type: 'number' }, { name: 'Target', type: 'date' },
    { name: 'Sprint', type: 'iteration' }, { name: 'Sub-issues progress', type: 'progress' }, { name: 'Parent issue', type: 'parentIssue' },
  ]);
  assert.deepEqual(view.items, [{
    itemId: 'PVTI_1', id: '1', title: 'T1', body: 'b1', url: 'https://github.com/acme/r/issues/1', status: 'Todo', labels: ['bug'], assignees: ['ana'],
    repository: 'acme/r', workspaceHint: 'hive', pullRequests: [],
    fields: { Priority: 'P1', Notes: 'see #2', Estimate: 3, Target: '2026-10-20', Sprint: 'Sprint 4', 'Sub-issues progress': '2/3' },
  }]);
  assert.equal(view.truncated, false);
  assert.deepEqual(calls.at(-1)?.variables, { login: 'acme', number: 6 });
});

test('project keeps the issues only, marks the ones the filter or epics: ignore keeps from the Hive, reads no relations, and an issue in an uncited column is not out (#756)', async () => {
  const hive = { labels: { nodes: [{ name: 'hive' }] } };
  const nodes = [
    issue(1, hive, 'Ready'),
    issue(2, { labels: { nodes: [] } }), // the label rule keeps it out
    issue(3, { ...hive, subIssuesSummary: { completed: 0, total: 2 } }), // an epic under the default epics: ignore
    issue(4, hive, 'Done'), // passes the filter, in a column no stage cites
    { id: 'PVTI_D', fieldValueByName: { name: 'Todo' }, content: { __typename: 'DraftIssue', title: 'draft' } },
    { id: 'PVTI_P', fieldValueByName: { name: 'Todo' }, content: { __typename: 'PullRequest', number: 9, url: 'https://github.com/acme/r/pull/9' } },
  ];
  // the blocked rule is not judged here: fakeGql rejects the relations query, so a call would fail the read
  const filter = [{ field: 'label', op: 'any', values: ['hive'] }, { field: 'blocked', op: 'none' }];
  const source = createSource(specOf({ source: { ...GITHUB_SOURCE, filter } }), { gql: fakeGql({ fields: FIELDS, projectItems: page(nodes) }).gql });
  await source.resolveFields();
  const { items } = await source.project!();
  assert.deepEqual(items.map((i) => [i.itemId, i.out]), [['PVTI_1', undefined], ['PVTI_2', 'filter'], ['PVTI_3', 'epic'], ['PVTI_4', undefined]]);
});

test('project reads the PRs that close an issue: merged first, OPEN open, else closed; the checks rollup as a signal, none when absent or unknown (#756)', async () => {
  const prs = { nodes: [pr(7, 'OPEN', 'SUCCESS'), pr(8, 'MERGED', 'FAILURE'), pr(9, 'CLOSED', 'PENDING'), pr(10, 'OPEN'), pr(11, 'OPEN', 'ERROR'), pr(12, 'OPEN', 'NEUTRAL')] };
  const source = createSource(specOf(), { gql: fakeGql({ fields: FIELDS, projectItems: page([issue(1, { closedByPullRequestsReferences: prs })]) }).gql });
  await source.resolveFields();
  const [item] = (await source.project!()).items;
  const url = (n: number) => `https://github.com/acme/r/pull/${n}`;
  assert.deepEqual(item.pullRequests, [
    { number: 7, url: url(7), state: 'open', checks: 'green' }, { number: 8, url: url(8), state: 'merged', checks: 'red' },
    { number: 9, url: url(9), state: 'closed', checks: 'yellow' }, { number: 10, url: url(10), state: 'open' },
    { number: 11, url: url(11), state: 'open', checks: 'red' }, { number: 12, url: url(12), state: 'open' },
  ]);
});

test('project pages by cursor up to PROJECT_ITEM_LIMIT, ten pages, and says truncated when items are left; a last page says not (#756)', async () => {
  const pages = Array.from({ length: PROJECT_ITEM_LIMIT / 100 }, (_, k) => page([issue(k + 1)], true, `C${k + 1}`));
  const { gql, calls } = fakeGql({ fields: FIELDS, projectItems: pages });
  const source = createSource(specOf(), { gql });
  await source.resolveFields();
  const view = await source.project!();
  const reads = calls.filter((c) => c.name === 'projectItems');
  assert.equal(reads.length, 10);
  assert.deepEqual(reads[1].variables, { login: 'acme', number: 6, after: 'C1' });
  assert.deepEqual([view.items.length, view.truncated], [10, true]);
  const short = createSource(specOf(), { gql: fakeGql({ fields: FIELDS, projectItems: [page([issue(1)], true, 'C1'), page([issue(2)])] }).gql });
  await short.resolveFields();
  assert.equal((await short.project!()).truncated, false);
});

test('project before resolveFields rejects, and a project gone since names it (#756)', async () => {
  await assert.rejects(createSource(specOf(), { gql: fakeGql({}).gql }).project!(), /not resolved/);
  const source = createSource(specOf(), { gql: fakeGql({ fields: FIELDS, projectItems: { repositoryOwner: null } }).gql });
  await source.resolveFields();
  await assert.rejects(source.project!(), { message: 'source not found: no GitHub Project 6 for "acme"' });
});

test('project reads each single-select field\'s options and each iteration field\'s iterations in project order, and where Status, Labels and Assignees sit among the shown fields (#756)', async () => {
  const fields = [
    { name: 'Title', dataType: 'TITLE' }, { name: 'Assignees', dataType: 'ASSIGNEES' },
    { name: 'Priority', dataType: 'SINGLE_SELECT', options: [{ name: 'P0' }, { name: 'P1' }] },
    { name: 'Status', dataType: 'SINGLE_SELECT', options: OPTIONS.map(({ name }) => ({ name })) },
    { name: 'Sprint', dataType: 'ITERATION', configuration: { iterations: [{ title: 'Sprint 4' }, { title: 'Sprint 5' }] } },
    { name: 'Labels', dataType: 'LABELS' }, { name: 'Notes', dataType: 'TEXT' },
  ];
  const read = { ...page([]), repositoryOwner: { projectV2: { fields: { nodes: fields }, items: { pageInfo: { hasNextPage: false }, nodes: [] } } } };
  const source = createSource(specOf(), { gql: fakeGql({ fields: FIELDS, projectItems: read }).gql });
  await source.resolveFields();
  const view = await source.project!();
  assert.deepEqual(view.fields, [
    { name: 'Priority', type: 'singleSelect', options: ['P0', 'P1'] }, { name: 'Sprint', type: 'iteration', options: ['Sprint 4', 'Sprint 5'] },
    { name: 'Notes', type: 'text' },
  ]);
  // each built-in sits before the shown field at its index: Assignees before Priority, Status before Sprint, Labels before Notes
  assert.deepEqual(view.builtins, { assignees: 0, status: 1, labels: 2 });
});

test('project lists every other field as a column, by its kind or as other: milestone, repository, parent issue and issue type from the issue, an unknown kind\'s answered value as text, reviewers none; and reads the issue\'s dates (#756)', async () => {
  const fields = [
    { name: 'Title', dataType: 'TITLE' }, { name: 'Assignees', dataType: 'ASSIGNEES' }, { name: 'Linked pull requests', dataType: 'LINKED_PULL_REQUESTS' },
    { name: 'Milestone', dataType: 'MILESTONE' }, { name: 'Repository', dataType: 'REPOSITORY' }, { name: 'Reviewers', dataType: 'REVIEWERS' },
    { name: 'Parent issue', dataType: 'PARENT_ISSUE' }, { name: 'Type', dataType: 'ISSUE_TYPE' }, { name: 'Tracks', dataType: 'TRACKS' },
    { name: 'Mystery', dataType: 'SOMETHING_NEW' },
  ];
  const node = {
    ...issue(1, {
      milestone: { title: 'v1' }, repository: { nameWithOwner: 'acme/r' }, parent: { number: 2, title: 'Epic' }, issueType: { name: 'Bug' },
      createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-05T10:00:00Z', closedAt: null,
    }),
    fieldValues: { nodes: [{ text: 'odd', field: { name: 'Mystery' } }] },
  };
  const closed = issue(2, { closedAt: '2026-10-04T10:00:00Z' });
  const read = { ...page([]), repositoryOwner: { projectV2: { fields: { nodes: fields }, items: { pageInfo: { hasNextPage: false }, nodes: [node, closed] } } } };
  const source = createSource(specOf(), { gql: fakeGql({ fields: FIELDS, projectItems: read }).gql });
  await source.resolveFields();
  const view = await source.project!();
  assert.deepEqual(view.fields, [
    { name: 'Milestone', type: 'milestone' }, { name: 'Repository', type: 'repository' }, { name: 'Reviewers', type: 'other' },
    { name: 'Parent issue', type: 'parentIssue' }, { name: 'Type', type: 'issueType' }, { name: 'Tracks', type: 'other' }, { name: 'Mystery', type: 'other' },
  ]);
  assert.deepEqual(view.builtins, { assignees: 0 });
  const [one, two] = view.items;
  assert.deepEqual(one.fields, { Milestone: 'v1', Repository: 'acme/r', 'Parent issue': '#2 Epic', Type: 'Bug', Mystery: 'odd' });
  assert.deepEqual([one.createdAt, one.updatedAt, one.closedAt], ['2026-10-01T10:00:00Z', '2026-10-05T10:00:00Z', undefined]);
  assert.equal(two.closedAt, '2026-10-04T10:00:00Z');
});
