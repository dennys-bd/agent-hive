import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { openReadModel, READ_MODEL_FILE } from '../../src/read-model/db.js';
import { tempDir } from '../temp-dir.js';
import { COMMENT_ROW, commentRow, ISSUE_ROW, issueRow, OTHER_SOURCE, REPO, SOURCE, T1, T2, T3 } from './fixtures.js';

test('an upsert keeps the stored row when the incoming updated_at is older, and replaces it when equal or newer (#765)', () => {
  const db = openReadModel(':memory:');
  assert.equal(db.upsertIssue(issueRow(12, T2, { title: 'second' })), true);
  assert.equal(db.upsertIssue(issueRow(12, T1, { title: 'older' })), false);
  assert.equal(db.issue(SOURCE, REPO, 12)?.title, 'second');
  assert.equal(db.upsertIssue(issueRow(12, T2, { title: 'same instant' })), true);
  assert.equal(db.upsertIssue(issueRow(12, T3, { title: 'newer' })), true);
  assert.deepEqual(db.issue(SOURCE, REPO, 12), issueRow(12, T3, { title: 'newer' }));
  assert.equal(db.upsertComment(commentRow('C1', 'I_12', T2)), true);
  assert.equal(db.upsertComment({ ...commentRow('C1', 'I_12', T1), body: 'older' }), false);
  assert.equal(db.upsertComment({ ...commentRow('C1', 'I_12', T2), body: 'same instant' }), true);
  assert.deepEqual(db.comments(SOURCE, 'I_12').map((c) => c.body), ['same instant']);
});

test('two sources with the same node_id keep two rows, and each view answers only its own (#765)', () => {
  const db = openReadModel(':memory:');
  db.upsertIssue(issueRow(12, T1, { title: 'mine' }));
  db.upsertIssue(issueRow(12, T1, { source: OTHER_SOURCE, title: 'theirs' }));
  db.upsertComment({ ...COMMENT_ROW, nodeId: 'C' });
  db.upsertComment({ ...COMMENT_ROW, nodeId: 'C', source: OTHER_SOURCE, body: 'theirs' });
  assert.deepEqual(db.issues(SOURCE, REPO, 'closed').map((r) => r.title), ['mine']);
  assert.deepEqual(db.issues(OTHER_SOURCE, REPO, 'closed').map((r) => r.title), ['theirs']);
  assert.equal(db.issue(OTHER_SOURCE, REPO, 12)?.title, 'theirs');
  assert.deepEqual(db.comments(SOURCE, 'I_12').map((c) => c.body), ['c']);
  assert.deepEqual(db.comments(OTHER_SOURCE, 'I_12').map((c) => c.body), ['theirs']);
  assert.deepEqual(db.nodeIds(OTHER_SOURCE, REPO, 'issues'), ['I_12']);
});

test('the list answers one state\'s issues, newest update first and without PRs; nodeIdOf resolves a PR too; removeIssue takes its comments (#765)', () => {
  const db = openReadModel(':memory:');
  db.upsertIssue(issueRow(1, T1, { state: 'open' }));
  db.upsertIssue(issueRow(2, T3, { state: 'open' }));
  db.upsertIssue(issueRow(3, T2, { state: 'open', kind: 'pr' }));
  db.upsertIssue(issueRow(4, T2));
  db.upsertComment(commentRow('C2', 'I_2', T2));
  db.upsertComment(commentRow('C1', 'I_2', T1));
  assert.deepEqual(db.issues(SOURCE, REPO, 'open').map((r) => r.number), [2, 1]);
  assert.equal(db.issue(SOURCE, REPO, 3), undefined, 'a PR is no issue page');
  assert.equal(db.nodeIdOf(SOURCE, REPO, 3), 'I_3');
  assert.deepEqual(db.comments(SOURCE, 'I_2').map((c) => c.nodeId), ['C1', 'C2'], 'oldest first');
  db.removeIssue(SOURCE, 'I_2');
  assert.deepEqual([db.issue(SOURCE, REPO, 2), db.comments(SOURCE, 'I_2')], [undefined, []]);
  db.removeComment(SOURCE, 'none');
});

test('a cursor reads back as written; a transaction that throws writes nothing (#765)', () => {
  const db = openReadModel(':memory:');
  assert.equal(db.cursor('s|acme/hive|issues'), undefined);
  db.setCursor('s|acme/hive|issues', { cursor: T1, etag: 'W/"e"', syncedAt: T2 });
  db.setCursor('s|acme/hive|issues', { cursor: T2, etag: null, syncedAt: T3 });
  assert.deepEqual(db.cursor('s|acme/hive|issues'), { cursor: T2, etag: null, syncedAt: T3 });
  assert.throws(() => db.transaction(() => { db.upsertIssue(ISSUE_ROW); throw new Error('boom'); }), { message: 'boom' });
  assert.equal(db.issue(SOURCE, REPO, 12), undefined);
  assert.equal(db.transaction(() => db.upsertIssue(ISSUE_ROW)), true);
});

test('on disk the file is owner-only and in WAL mode (#765)', async (t) => {
  const home = await tempDir(t, 'read-model-');
  const path = join(home, READ_MODEL_FILE);
  const db = openReadModel(path);
  t.after(() => db.close());
  db.upsertIssue(ISSUE_ROW);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(existsSync(`${path}-wal`), true);
  assert.equal((await stat(`${path}-wal`)).mode & 0o777, 0o600);
});
