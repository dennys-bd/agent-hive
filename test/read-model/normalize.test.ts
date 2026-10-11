import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiRepository, commentFromGql, commentFromRest, issueFromGql, issueFromRest } from '../../src/read-model/normalize.js';
import { COMMENT_ROW, GQL_COMMENT, GQL_ISSUE, ISSUE_ROW, REPO, REST_COMMENT, REST_ISSUE, SOURCE } from './fixtures.js';

test('the REST and the GraphQL normalizer map one issue to the same row (#765)', () => {
  assert.deepEqual(issueFromRest(SOURCE, REPO, REST_ISSUE), ISSUE_ROW);
  assert.deepEqual(issueFromGql(SOURCE, REPO, GQL_ISSUE), ISSUE_ROW);
});

test('a REST issue with pull_request is a pr row; a null body is empty and a null user is no author (#765)', () => {
  const row = issueFromRest(SOURCE, REPO, { ...REST_ISSUE, pull_request: { url: 'https://api.github.com/repos/acme/hive/pulls/12' }, body: null, user: null });
  assert.deepEqual([row.kind, row.body, row.author], ['pr', '', null]);
});

test('the REST and the GraphQL normalizer map one comment to the same row; a REST comment whose issue is not stored is undefined (#765)', () => {
  assert.deepEqual(commentFromRest(SOURCE, REPO, REST_COMMENT, (n) => (n === 12 ? 'I_12' : undefined)), COMMENT_ROW);
  assert.deepEqual(commentFromGql(SOURCE, REPO, 'I_12', GQL_COMMENT), COMMENT_ROW);
  assert.equal(commentFromRest(SOURCE, REPO, REST_COMMENT, () => undefined), undefined);
});

test('malformed wire input throws instead of storing half a row (#765)', () => {
  assert.throws(() => issueFromRest(SOURCE, REPO, null), { message: 'read model: unexpected issue' });
  assert.throws(() => issueFromRest(SOURCE, REPO, { ...REST_ISSUE, state: 'merged' }), { message: 'read model: unexpected state' });
  assert.throws(() => issueFromRest(SOURCE, REPO, { ...REST_ISSUE, number: '12' }), { message: 'read model: unexpected number' });
  assert.throws(() => issueFromGql(SOURCE, REPO, { ...GQL_ISSUE, labels: null }), { message: 'read model: unexpected labels' });
  assert.throws(() => commentFromRest(SOURCE, REPO, { ...REST_COMMENT, issue_url: 'nope' }, () => 'I_12'), { message: 'read model: unexpected issue_url' });
  assert.throws(() => commentFromGql(SOURCE, REPO, 'I_12', { ...GQL_COMMENT, body: 3 }), { message: 'read model: unexpected body' });
});

test('apiRepository reads owner/name off a REST link (#765)', () => {
  assert.equal(apiRepository('https://api.github.com/repos/acme/hive'), 'acme/hive');
  assert.equal(apiRepository('https://api.github.com/repos/acme/hive/issues/12'), 'acme/hive');
  assert.throws(() => apiRepository('https://github.com/acme/hive'), { message: 'read model: unexpected repository link' });
});
