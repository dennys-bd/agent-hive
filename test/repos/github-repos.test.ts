import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comment, editIssue, IssueChanged, setLabels, UnknownLabel } from '../../src/repos/github-repos.js';
import { ADD_COMMENT, ADD_LABELS, ISSUE_STATE, REMOVE_LABELS, REPO_LABELS, UPDATE_ISSUE } from '../../src/repos/github-repo-queries.js';
import { fakeGqlJson } from '../fakes.js';

const RATE = { limit: 5000, remaining: 4000, resetAt: '2026-10-06T13:00:00Z' };
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

test('setLabels adds and removes by id, skips an empty list, and refuses an unknown name before any write (#757)', async () => {
  const { gql, calls } = writer();
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
