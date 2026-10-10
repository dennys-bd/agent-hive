import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comment, editIssue, IssueChanged, readIssue, readIssues, readLabels, readSummaries, REPO_ISSUE_LIMIT, setLabels, UnknownLabel } from '../../src/repos/github-repos.js';
import { ADD_COMMENT, ADD_LABELS, ISSUE_STATE, REMOVE_LABELS, REPO_LABELS, UPDATE_ISSUE } from '../../src/repos/github-repo-queries.js';
import { fakeGqlJson } from '../fakes.js';

const RATE = { limit: 5000, remaining: 4000, resetAt: '2026-10-06T13:00:00Z' };
const summary = (url: string, pushedAt: string, issue?: string, pr?: string) => ({
  url, pushedAt, isFork: false, parent: null, viewerPermission: 'WRITE', hasIssuesEnabled: true, pullRequests: { totalCount: 2 }, open: { totalCount: 5 }, closed: { totalCount: 7 },
  lastIssue: { nodes: issue === undefined ? [] : [{ updatedAt: issue }] }, lastPr: { nodes: pr === undefined ? [] : [{ updatedAt: pr }] },
});

test('readSummaries asks one alias per repository, owner and name as variables, and maps the counts and the latest activity (#757)', async () => {
  const { gql, calls } = fakeGqlJson(() => ({
    rateLimit: RATE,
    r0: summary('https://github.com/acme/hive', '2026-10-01T10:00:00Z', '2026-10-05T09:00:00Z', '2026-10-03T00:00:00Z'),
    r1: summary('https://github.com/acme/site', '2026-10-06T08:00:00Z'),
  }));
  const read = await readSummaries(gql, [{ repository: 'acme/hive', workspace: 'hive' }, { repository: 'acme/site', workspace: 'site' }]);
  assert.deepEqual(calls[0].variables, { o0: 'acme', n0: 'hive', o1: 'acme', n1: 'site' });
  assert.match(calls[0].query, /r1: repository\(owner: \$o1, name: \$n1\)/);
  assert.match(calls[0].query, /rateLimit \{ limit remaining resetAt \}/);
  assert.deepEqual(read, [
    { repository: 'acme/hive', url: 'https://github.com/acme/hive', workspace: 'hive', openPrs: 2, openIssues: 5, closedIssues: 7, canPush: true, issuesEnabled: true, lastActivity: '2026-10-05T09:00:00Z' },
    { repository: 'acme/site', url: 'https://github.com/acme/site', workspace: 'site', openPrs: 2, openIssues: 5, closedIssues: 7, canPush: true, issuesEnabled: true, lastActivity: '2026-10-06T08:00:00Z' },
  ]);
  assert.deepEqual(await readSummaries(gql, []), []);
  assert.equal(calls.length, 1, 'no repository: no call');
});

test('readSummaries asks if each repository is a fork and of what, the login\'s permission and whether issues are on, and keeps the ref\'s role and target (#854)', async () => {
  const { gql, calls } = fakeGqlJson(() => ({
    rateLimit: RATE,
    r0: { ...summary('https://github.com/ex/excalidraw', '2026-10-01T10:00:00Z'), viewerPermission: 'READ' },
    r1: { ...summary('https://github.com/me/excalidraw', '2026-10-02T10:00:00Z'), isFork: true, parent: { nameWithOwner: 'ex/excalidraw' }, viewerPermission: 'ADMIN', hasIssuesEnabled: false },
  }));
  const read = await readSummaries(gql, [
    { repository: 'ex/excalidraw', workspace: 'ex', role: 'original', pr: 'original', pair: 'me/excalidraw' },
    { repository: 'me/excalidraw', workspace: 'ex', role: 'fork', pr: 'original', pair: 'ex/excalidraw' },
  ]);
  assert.match(calls[0].query, /isFork parent \{ nameWithOwner \} viewerPermission hasIssuesEnabled/);
  assert.deepEqual(read.map((r) => [r.repository, r.role, r.pr, r.fork, r.canPush, r.issuesEnabled]), [
    ['ex/excalidraw', 'original', 'original', undefined, false, true],
    ['me/excalidraw', 'fork', 'original', { parent: 'ex/excalidraw' }, true, false],
  ]);
  // #886: each row names the other of its pair, what the sidebar pairs by; GitHub's parent name may differ after a rename
  assert.deepEqual(read.map((r) => r.pair), ['me/excalidraw', 'ex/excalidraw']);
});

const issueNode = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n, title: `T${n}`, url: `https://github.com/acme/hive/issues/${n}`, updatedAt: '2026-10-05T09:00:00Z',
  labels: { nodes: [{ name: 'bug' }] }, assignees: { nodes: [{ login: 'ana' }] }, closedByPullRequestsReferences: { nodes: [] }, ...extra,
});
const issuesPage = (nodes: unknown[], hasNextPage = false, endCursor = 'C') =>
  ({ rateLimit: RATE, repository: { issues: { totalCount: 1234, pageInfo: { hasNextPage, endCursor }, nodes } } });
const prUrl = (n: number) => `https://github.com/acme/hive/pull/${n}`;

test('readIssues maps a page: labels, assignees, the closing PRs with a draft marked, GitHub\'s total (#757)', async () => {
  const prs = { nodes: [
    { number: 7, url: prUrl(7), state: 'OPEN', merged: false, isDraft: true, statusCheckRollup: null },
    { number: 8, url: prUrl(8), state: 'MERGED', merged: true, isDraft: false, statusCheckRollup: { state: 'SUCCESS' } },
  ] };
  const { gql, calls } = fakeGqlJson(() => issuesPage([issueNode(12, { closedByPullRequestsReferences: prs })]));
  const read = await readIssues(gql, 'acme/hive', 'closed');
  assert.deepEqual(calls[0].variables, { owner: 'acme', name: 'hive', states: ['CLOSED'] });
  assert.deepEqual(read, {
    state: 'closed', total: 1234, truncated: false,
    issues: [{
      number: 12, title: 'T12', url: 'https://github.com/acme/hive/issues/12', updatedAt: '2026-10-05T09:00:00Z', labels: ['bug'], assignees: ['ana'],
      pullRequests: [{ number: 7, url: prUrl(7), state: 'open', draft: true }, { number: 8, url: prUrl(8), state: 'merged', checks: 'green' }],
    }],
  });
});

test('readIssues pages by cursor up to REPO_ISSUE_LIMIT and says truncated when issues are left; a missing repository names itself (#757)', async () => {
  const pages = Array.from({ length: REPO_ISSUE_LIMIT / 100 }, (_, k) => issuesPage([issueNode(k + 1)], true, `C${k + 1}`));
  const { gql, calls } = fakeGqlJson(() => pages.shift());
  const read = await readIssues(gql, 'acme/hive', 'open');
  assert.equal(calls.length, 10);
  assert.deepEqual(calls[1].variables, { owner: 'acme', name: 'hive', states: ['OPEN'], after: 'C1' });
  assert.deepEqual([read.issues.length, read.truncated], [10, true]);
  await assert.rejects(readIssues(fakeGqlJson(() => ({ rateLimit: RATE, repository: null })).gql, 'acme/hive', 'open'), { message: 'repository not found: acme/hive' });
});

const pageNode = {
  ...issueNode(12), body: 'b', createdAt: '2026-10-01T09:00:00Z', author: { login: 'bia' },
  comments: { totalCount: 120, nodes: [{ author: null, createdAt: '2026-10-02T09:00:00Z', body: 'c', url: 'https://github.com/acme/hive/issues/12#issuecomment-1' }] },
};

test('readIssue maps the page: body, author, the comments with a gone author as ghost, GitHub\'s comment count; a missing issue names itself (#757)', async () => {
  const { gql, calls } = fakeGqlJson(() => ({ rateLimit: RATE, repository: { issue: pageNode } }));
  const page = await readIssue(gql, 'acme/hive', 12);
  assert.deepEqual(calls[0].variables, { owner: 'acme', name: 'hive', number: 12 });
  assert.deepEqual(page, {
    number: 12, title: 'T12', url: 'https://github.com/acme/hive/issues/12', updatedAt: '2026-10-05T09:00:00Z', labels: ['bug'], assignees: ['ana'], pullRequests: [],
    repository: 'acme/hive', body: 'b', author: 'bia', createdAt: '2026-10-01T09:00:00Z', commentCount: 120,
    comments: [{ author: 'ghost', createdAt: '2026-10-02T09:00:00Z', body: 'c', url: 'https://github.com/acme/hive/issues/12#issuecomment-1' }],
  });
  const gone = fakeGqlJson(() => ({ rateLimit: RATE, repository: { issue: null } }));
  await assert.rejects(readIssue(gone.gql, 'acme/hive', 9), { message: 'issue not found: acme/hive#9' });
});

const U1 = '2026-10-05T09:00:00Z';
const STATE12 = { rateLimit: RATE, repository: { issue: { id: 'I_12', updatedAt: U1 } } };

test('editIssue throws IssueChanged and writes nothing when GitHub\'s updatedAt differs; otherwise updateIssue gets the id and only the fields sent (#757)', async () => {
  const { gql, calls } = fakeGqlJson((query) => (query === ISSUE_STATE ? STATE12 : { updateIssue: { issue: { id: 'I_12' } } }));
  await assert.rejects(editIssue(gql, 'acme/hive', 12, { title: 'New' }, '2026-01-01T00:00:00Z'), IssueChanged);
  assert.equal(calls.some((c) => c.query === UPDATE_ISSUE), false);
  await editIssue(gql, 'acme/hive', 12, { body: 'b2' }, U1);
  assert.deepEqual(calls.filter((c) => c.query === ISSUE_STATE).at(-1)?.variables, { owner: 'acme', name: 'hive', number: 12 });
  assert.deepEqual(calls.filter((c) => c.query === UPDATE_ISSUE).map((c) => c.variables), [{ id: 'I_12', body: 'b2' }]);
});

const LABELS = { rateLimit: RATE, repository: { labels: { nodes: [{ id: 'L_bug', name: 'bug' }, { id: 'L_docs', name: 'docs' }] } } };
const writer = () => fakeGqlJson((query) => {
  if (query === REPO_LABELS) return LABELS;
  return query === ISSUE_STATE ? STATE12 : {};
});

test('readLabels names the labels; setLabels adds and removes by id, skips an empty list, and refuses an unknown name before any write (#757)', async () => {
  const { gql, calls } = writer();
  assert.deepEqual(await readLabels(gql, 'acme/hive'), ['bug', 'docs']);
  await setLabels(gql, 'acme/hive', 12, ['docs'], ['bug']);
  const writes = calls.filter((c) => c.query === ADD_LABELS || c.query === REMOVE_LABELS).map((c) => [c.query === ADD_LABELS ? 'add' : 'remove', c.variables]);
  assert.deepEqual(writes, [['add', { id: 'I_12', labels: ['L_docs'] }], ['remove', { id: 'I_12', labels: ['L_bug'] }]]);
  const only = writer();
  await setLabels(only.gql, 'acme/hive', 12, ['docs'], []);
  assert.equal(only.calls.some((c) => c.query === REMOVE_LABELS), false);
  const unknown = writer();
  await assert.rejects(setLabels(unknown.gql, 'acme/hive', 12, ['wontfix'], []), UnknownLabel);
  assert.equal(unknown.calls.some((c) => c.query === ADD_LABELS || c.query === ISSUE_STATE), false);
});

test('comment posts the body to the issue\'s id (#757)', async () => {
  const { gql, calls } = writer();
  await comment(gql, 'acme/hive', 12, 'Looks good');
  assert.deepEqual(calls.filter((c) => c.query === ADD_COMMENT).map((c) => c.variables), [{ id: 'I_12', body: 'Looks good' }]);
});
