import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrRows, parseSearchRows, prsQuery, SEARCH_PRS_QUERY, searchVariables } from '../src/pr-list.js';

const AT = '2026-10-07T10:00:00Z';
const LINK = 'https://github.com/acme/app/pull/';
const node = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  url: `${LINK}${n}`, number: n, title: `PR ${n}`, state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: AT, reviewDecision: 'APPROVED',
  headCommit: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...extra,
});
const answer = (nodes: unknown[], total = nodes.length) =>
  ({ repository: { viewerPermission: 'WRITE', open: { totalCount: 5 }, merged: { totalCount: 12 }, closed: { totalCount: 3 }, rows: { totalCount: total, nodes } } });

test('parsePrRows reads each row, its checks and its decision only when GitHub has them, and the three counts; an unreadable row is skipped and named (#758)', () => {
  const skipped: string[] = [];
  const draft = node(8, { isDraft: true, reviewDecision: null, mergeStateStatus: 'DRAFT', headCommit: { nodes: [{ commit: { statusCheckRollup: null } }] } });
  assert.deepEqual(parsePrRows(answer([node(7), draft, { number: 'x' }]), (reason) => skipped.push(reason)), {
    counts: { open: 5, merged: 12, closed: 3 }, truncated: false, canPush: true,
    rows: [
      { url: `${LINK}7`, number: 7, title: 'PR 7', state: 'open', isDraft: false, mergeState: 'clean', updatedAt: AT, checks: 'success', decision: 'approved' },
      { url: `${LINK}8`, number: 8, title: 'PR 8', state: 'open', isDraft: true, mergeState: 'draft', updatedAt: AT },
    ],
  });
  assert.deepEqual(skipped, ['unreadable PR row']);
  assert.equal(parsePrRows(answer([node(7)], 140)).truncated, true, 'GitHub holds more than the rows read');
  assert.throws(() => parsePrRows({ repository: null }), /repository not found/);
});

test('prsQuery asks the state as an enum literal and owner and name as variables, never in its text (#758)', () => {
  assert.match(prsQuery('merged'), /rows: pullRequests\(first: 100, states: \[MERGED\], orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/);
  assert.match(prsQuery('open'), /repository\(owner: \$owner, name: \$name\)/);
  assert.match(prsQuery('open'), /open: pullRequests\(states: \[OPEN\]\) \{ totalCount \} merged: pullRequests\(states: \[MERGED\]\)/);
  assert.ok(!prsQuery('closed').includes('acme'));
});

test('prsQuery asks the login\'s permission: none or READ is no push rights (#854)', () => {
  assert.match(prsQuery('open'), /repository\(owner: \$owner, name: \$name\) \{ viewerPermission /);
  assert.equal(parsePrRows({ repository: { ...answer([]).repository, viewerPermission: 'READ' } }).canPush, false);
  assert.equal(parsePrRows({ repository: { ...answer([]).repository, viewerPermission: undefined } }).canPush, false);
});

test('an original\'s list reads GitHub search for the PRs the user\'s fork opened: the state and the author as variables, the counts from issueCount, and the push rights (#854)', () => {
  const q = (state: string) => `repo:ex/excalidraw is:pr author:@me ${state} sort:updated-desc`;
  assert.deepEqual(searchVariables('ex/excalidraw', 'merged'), {
    owner: 'ex', name: 'excalidraw', open: q('is:open'), merged: q('is:merged'), closed: q('is:closed is:unmerged'), rows: q('is:merged'),
  });
  assert.match(SEARCH_PRS_QUERY, /rows: search\(query: \$rows, type: ISSUE, first: 100\) \{ issueCount nodes \{ \.\.\. on PullRequest \{/);
  assert.ok(!SEARCH_PRS_QUERY.includes('excalidraw') && !SEARCH_PRS_QUERY.includes('author:'), 'every value a variable');
  const data = { repository: { viewerPermission: 'READ' }, open: { issueCount: 2 }, merged: { issueCount: 5 }, closed: { issueCount: 1 }, rows: { issueCount: 3, nodes: [node(7), node(8)] } };
  const read = parseSearchRows(data);
  assert.deepEqual([read.counts, read.truncated, read.canPush, read.rows.map((r) => r.number)], [{ open: 2, merged: 5, closed: 1 }, true, false, [7, 8]]);
  assert.throws(() => parseSearchRows({ repository: null }), /repository not found/);
});

test('a row whose head has no check run and a workflow awaiting approval reads awaiting (#854)', () => {
  const awaitingNode = node(9, { headCommit: { nodes: [{ commit: { statusCheckRollup: null, checkSuites: { nodes: [{ conclusion: 'ACTION_REQUIRED', app: { slug: 'github-actions' }, workflowRun: { workflow: { name: 'CI' } } }] } } }] } });
  assert.equal(parsePrRows(answer([awaitingNode])).rows[0].checks, 'awaiting');
  assert.match(prsQuery('open'), /commit \{ checkSuites\(first: 50\)/);
});
