import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadModel, READ_MODEL_FILE, type ReadModel } from '../../src/read-model/db.js';
import { issueFromRest } from '../../src/read-model/normalize.js';
import { MIGRATIONS } from '../../src/read-model/schema.js';
import { tempDir } from '../temp-dir.js';
import { CLOSING_PRS, COMMENT_ROW, commentRow, ISSUE_ROW, issueRow, OTHER_SOURCE, REPO, REST_ISSUE, SOURCE, T1, T2, T3 } from './fixtures.js';

const STALE = 'stale side file';
const memory = async (now: () => number = () => 0): Promise<ReadModel> => (await openReadModel(':memory:', { now })).db;
// The first value of a query's first row, read through a connection of the test's own
function peek(path: string, sql: string): unknown {
  const raw = new DatabaseSync(path);
  try {
    return Object.values(raw.prepare(sql).get() ?? {})[0];
  } finally {
    raw.close();
  }
}
const isStale = (file: string): boolean => existsSync(file) && readFileSync(file, 'latin1').startsWith(STALE);

test('a missing file is created owner-only at the latest schema version, and resync is false (#178)', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  const { db, resync } = await openReadModel(path);
  t.after(() => db.close());
  db.upsertIssue(ISSUE_ROW, 'sync');
  assert.equal(resync, false);
  assert.equal(peek(path, 'PRAGMA user_version'), MIGRATIONS.length);
  for (const file of [path, `${path}-wal`]) assert.equal((await stat(file)).mode & 0o777, 0o600, file);
});

test('a file at an older version runs only the missing migrations and keeps what it stored (#178)', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE kept (x INTEGER); INSERT INTO kept VALUES (1)');
  raw.close();
  const first = await openReadModel(path);
  first.db.upsertIssue(ISSUE_ROW, 'sync');
  first.db.close();
  assert.deepEqual([first.resync, peek(path, 'PRAGMA user_version'), peek(path, 'SELECT count(*) FROM kept')], [false, MIGRATIONS.length, 1]);
  const second = await openReadModel(path, { migrations: [...MIGRATIONS, 'CREATE TABLE extra (x INTEGER)'] });
  t.after(() => second.db.close());
  assert.equal(second.resync, false);
  assert.equal(second.db.issue(SOURCE, REPO, 12)?.title, 'T12');
  assert.equal(peek(path, 'PRAGMA user_version'), MIGRATIONS.length + 1);
});

test('a file of random bytes, or one newer than the code, is deleted with its -wal and -shm and reopened empty (#178)', async (t) => {
  const home = await tempDir(t, 'read-model-');
  const junk = join(home, 'junk.sqlite');
  await writeFile(junk, randomBytes(4096));
  const newer = join(home, 'newer.sqlite');
  const raw = new DatabaseSync(newer);
  raw.exec(`CREATE TABLE issues (x INTEGER); PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  raw.close();
  for (const path of [junk, newer]) {
    for (const side of ['-wal', '-shm']) await writeFile(`${path}${side}`, STALE);
    const { db, resync } = await openReadModel(path);
    t.after(() => db.close());
    assert.equal(resync, true, path);
    assert.deepEqual(db.issues(SOURCE, REPO, 'closed'), []);
    assert.equal(peek(path, 'PRAGMA user_version'), MIGRATIONS.length);
    for (const side of ['-wal', '-shm']) assert.equal(isStale(`${path}${side}`), false, `${path}${side}`);
  }
});

test('a second failure to open throws, keeping both causes (#178)', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  await assert.rejects(openReadModel(path, { migrations: ['NOT SQL'] }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /cannot open/);
    const { first, second } = err.cause as { first: Error; second: Error };
    assert.match(first.message, /syntax error/);
    assert.match(second.message, /syntax error/);
    return true;
  });
});

test('an upsert with an older updated_at returns false and changes nothing, from either origin (#178)', async () => {
  const db = await memory();
  db.upsertIssue(issueRow(12, T2, { title: 'newer' }), 'sync');
  db.upsertComment({ ...commentRow('C1', 'I_12', T2), body: 'newer' }, 'sync');
  for (const origin of ['sync', 'write'] as const) {
    assert.equal(db.upsertIssue(issueRow(12, T1, { title: 'older' }), origin), false);
    assert.equal(db.upsertComment({ ...commentRow('C1', 'I_12', T1), body: 'older' }, origin), false);
  }
  assert.equal(db.issue(SOURCE, REPO, 12)?.title, 'newer');
  assert.deepEqual(db.comments(SOURCE, 'I_12').map((c) => c.body), ['newer']);
});

test('an identical row writes nothing, even when its written_at differs (#178)', async () => {
  let clock = 0;
  const db = await memory(() => clock);
  assert.equal(db.upsertIssue(ISSUE_ROW, 'write'), true);
  assert.equal(db.upsertComment(COMMENT_ROW, 'sync'), true);
  clock += 31_000;
  assert.equal(db.upsertIssue(ISSUE_ROW, 'sync'), false);
  assert.equal(db.upsertIssue(ISSUE_ROW, 'write'), false);
  assert.equal(db.upsertComment(COMMENT_ROW, 'write'), false);
});

test('on a tie a write wins, and a sync page wins unless the row was written less than 30 s before (#178)', async () => {
  let clock = 1_000_000;
  const db = await memory(() => clock);
  db.upsertIssue(issueRow(12, T1, { title: 'synced' }), 'sync');
  assert.equal(db.upsertIssue(issueRow(12, T1, { title: 'sync tie' }), 'sync'), true, 'a sync tie replaces a synced row');
  assert.equal(db.upsertIssue(issueRow(12, T1, { title: 'written' }), 'write'), true, 'a write tie replaces a synced row');
  clock += 10_000;
  assert.equal(db.upsertIssue(issueRow(12, T1, { title: 'page read before the write' }), 'sync'), false);
  clock += 21_000;
  assert.equal(db.upsertIssue(issueRow(12, T1, { title: 'settled' }), 'sync'), true);
  assert.equal(db.issue(SOURCE, REPO, 12)?.title, 'settled');
  db.upsertComment({ ...COMMENT_ROW, body: 'written' }, 'write');
  clock += 10_000;
  assert.equal(db.upsertComment({ ...COMMENT_ROW, body: 'stale' }, 'sync'), false);
  clock += 21_000;
  assert.equal(db.upsertComment({ ...COMMENT_ROW, body: 'settled' }, 'sync'), true);
});

test('nodeIdOf resolves an issue\'s and a PR\'s number; nodeIds lists one table of one repository and source (#178)', async () => {
  const db = await memory();
  db.upsertIssue(issueRow(1, T1), 'sync');
  db.upsertIssue(issueRow(3, T1, { kind: 'pr' }), 'sync');
  db.upsertIssue(issueRow(4, T1, { repository: 'acme/other' }), 'sync');
  db.upsertIssue(issueRow(5, T1, { source: OTHER_SOURCE }), 'sync');
  db.upsertComment(commentRow('C1', 'I_1'), 'sync');
  assert.deepEqual([db.nodeIdOf(SOURCE, REPO, 1), db.nodeIdOf(SOURCE, REPO, 3), db.nodeIdOf(SOURCE, REPO, 4)], ['I_1', 'I_3', undefined]);
  assert.deepEqual(db.nodeIds(SOURCE, REPO, 'issues').sort(), ['I_1', 'I_3']);
  assert.deepEqual(db.nodeIds(SOURCE, REPO, 'comments'), ['C1']);
  assert.deepEqual(db.nodeIds(OTHER_SOURCE, REPO, 'issues'), ['I_5']);
});

test('setClosingPrs replaces the set, and a later REST upsert of the issue leaves the links in place (#178)', async () => {
  const db = await memory();
  db.upsertIssue(ISSUE_ROW, 'sync');
  db.setClosingPrs(SOURCE, 'I_12', [CLOSING_PRS[1], CLOSING_PRS[0]]);
  assert.deepEqual(db.issue(SOURCE, REPO, 12)?.pullRequests, CLOSING_PRS, 'by number');
  db.setClosingPrs(SOURCE, 'I_12', [CLOSING_PRS[0]]);
  assert.equal(db.upsertIssue(issueFromRest(SOURCE, REPO, { ...REST_ISSUE, title: 'renamed', updated_at: T2 }), 'sync'), true);
  assert.deepEqual(db.issue(SOURCE, REPO, 12), { ...ISSUE_ROW, title: 'renamed', updatedAt: T2, pullRequests: [CLOSING_PRS[0]] });
});

test('issues and issue answer assignees and closing PRs, leave PRs out, and never another source\'s rows (#178)', async () => {
  const db = await memory();
  db.upsertIssue(issueRow(1, T1, { state: 'open' }), 'sync');
  db.upsertIssue(issueRow(2, T3, { state: 'open' }), 'sync');
  db.upsertIssue(issueRow(3, T2, { state: 'open', kind: 'pr' }), 'sync');
  db.upsertIssue(issueRow(2, T3, { state: 'open', source: OTHER_SOURCE, title: 'theirs' }), 'sync');
  db.setClosingPrs(SOURCE, 'I_2', CLOSING_PRS);
  assert.deepEqual(db.issues(SOURCE, REPO, 'open'), [
    { ...issueRow(2, T3, { state: 'open' }), pullRequests: CLOSING_PRS },
    { ...issueRow(1, T1, { state: 'open' }), pullRequests: [] },
  ]);
  assert.deepEqual(db.issue(SOURCE, REPO, 2)?.assignees, ['bia', 'caio']);
  assert.equal(db.issue(SOURCE, REPO, 3), undefined, 'a PR is no issue');
  assert.deepEqual(db.issue(OTHER_SOURCE, REPO, 2), { ...issueRow(2, T3, { state: 'open', source: OTHER_SOURCE, title: 'theirs' }), pullRequests: [] });
  assert.deepEqual(db.issues(OTHER_SOURCE, REPO, 'open').map((i) => i.title), ['theirs']);
});

test('removeIssue removes its comments and links; comments read oldest first (#178)', async () => {
  const db = await memory();
  db.upsertIssue(ISSUE_ROW, 'sync');
  db.upsertComment(commentRow('C2', 'I_12', T2), 'sync');
  db.upsertComment(commentRow('C1', 'I_12', T1), 'sync');
  db.setClosingPrs(SOURCE, 'I_12', CLOSING_PRS);
  assert.deepEqual(db.comments(SOURCE, 'I_12').map((c) => c.nodeId), ['C1', 'C2']);
  db.removeIssue(SOURCE, 'I_12');
  assert.deepEqual([db.issue(SOURCE, REPO, 12), db.comments(SOURCE, 'I_12')], [undefined, []]);
  db.upsertIssue(ISSUE_ROW, 'sync');
  assert.deepEqual(db.issue(SOURCE, REPO, 12)?.pullRequests, [], 'the links went with it');
});

test('a scope reads back as written, per source; a transaction that throws writes nothing (#178)', async () => {
  const db = await memory();
  assert.equal(db.scope(SOURCE, REPO, 'issues'), undefined);
  db.setScope(SOURCE, REPO, 'issues', { cursor: T1, etag: 'W/"e"', syncedAt: null });
  db.setScope(SOURCE, REPO, 'issues', { cursor: T2, etag: null, syncedAt: T3 });
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: T2, etag: null, syncedAt: T3 });
  assert.equal(db.scope(OTHER_SOURCE, REPO, 'issues'), undefined);
  assert.throws(() => db.transaction(() => {
    db.upsertIssue(ISSUE_ROW, 'sync');
    throw new Error('boom');
  }), { message: 'boom' });
  assert.equal(db.issue(SOURCE, REPO, 12), undefined);
});
