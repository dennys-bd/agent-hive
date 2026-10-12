import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closingPrsFromGql, commentFromGql, commentFromRest, issueFromGql, issueFromRest, WireError } from '../../src/read-model/normalize.js';
import { sourceOf } from '../../src/read-model/rows.js';
import { repoIssue } from '../../src/repos/github-repos.js';
import { COMMENT_ROW, GQL_CLOSING_PRS, GQL_COMMENT, GQL_ISSUE, ISSUE_ROW, REPO, REST_COMMENT, REST_ISSUE, SOURCE, T1 } from './fixtures.js';

test('the REST and the GraphQL normalizer map one issue to the same row, assignees included (#178)', () => {
  assert.deepEqual(issueFromRest(SOURCE, REPO, REST_ISSUE), ISSUE_ROW);
  assert.deepEqual(issueFromGql(SOURCE, REPO, GQL_ISSUE), ISSUE_ROW);
});

test('a REST issue with pull_request is a pr row; a null body is empty; a deleted account is a null author (#178)', () => {
  const row = issueFromRest(SOURCE, REPO, { ...REST_ISSUE, pull_request: { url: 'https://api.github.com/repos/acme/hive/pulls/12' }, body: null, user: null });
  assert.deepEqual([row.kind, row.body, row.author], ['pr', '', null]);
  assert.equal(issueFromGql(SOURCE, REPO, { ...GQL_ISSUE, author: null }).author, null);
  assert.equal(commentFromGql(SOURCE, REPO, 'I_12', { ...GQL_COMMENT, author: null }).author, null);
});

test('the REST and the GraphQL normalizer map one comment to the same row, url included; a REST comment whose issue is not stored is undefined (#178)', () => {
  assert.deepEqual(commentFromRest(SOURCE, REPO, REST_COMMENT, (n) => (n === 12 ? 'I_12' : undefined)), COMMENT_ROW);
  assert.deepEqual(commentFromGql(SOURCE, REPO, 'I_12', GQL_COMMENT), COMMENT_ROW);
  assert.equal(commentFromRest(SOURCE, REPO, REST_COMMENT, () => undefined), undefined);
});

test('closingPrsFromGql gives the ProjectPrs the repository views give for the same nodes (#178)', () => {
  const views = repoIssue({ number: 12, title: 'T12', url: 'https://github.com/acme/hive/issues/12', updatedAt: T1, closedByPullRequestsReferences: { nodes: GQL_CLOSING_PRS } });
  assert.deepEqual(closingPrsFromGql(GQL_ISSUE), views.pullRequests);
});

test('malformed wire input throws WireError instead of storing half a row (#178)', () => {
  assert.throws(() => issueFromRest(SOURCE, REPO, null), WireError);
  assert.throws(() => issueFromRest(SOURCE, REPO, { ...REST_ISSUE, state: 'merged' }), { message: 'read model: unexpected state' });
  assert.throws(() => issueFromRest(SOURCE, REPO, { ...REST_ISSUE, number: '12' }), { message: 'read model: unexpected number' });
  assert.throws(() => issueFromRest(SOURCE, REPO, { ...REST_ISSUE, assignees: [{ id: 7 }] }), { message: 'read model: unexpected login' });
  assert.throws(() => issueFromGql(SOURCE, REPO, { ...GQL_ISSUE, labels: null }), { message: 'read model: unexpected labels' });
  assert.throws(() => commentFromRest(SOURCE, REPO, { ...REST_COMMENT, issue_url: 'nope' }, () => 'I_12'), { message: 'read model: unexpected issue_url' });
  assert.throws(() => commentFromRest(SOURCE, REPO, { ...REST_COMMENT, html_url: null }, () => 'I_12'), { message: 'read model: unexpected html_url' });
  assert.throws(() => commentFromGql(SOURCE, REPO, 'I_12', { ...GQL_COMMENT, body: 3 }), { message: 'read model: unexpected body' });
  assert.throws(() => closingPrsFromGql({ closedByPullRequestsReferences: { nodes: [{ number: 30 }] } }), { message: 'read model: unexpected url' });
  assert.throws(() => closingPrsFromGql({ closedByPullRequestsReferences: null }), WireError);
});

test('sourceOf names a login on a host (#178)', () => {
  assert.equal(sourceOf('github.com', 'octo'), 'github:github.com:octo');
});
