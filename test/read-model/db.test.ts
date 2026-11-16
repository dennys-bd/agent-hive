import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadModel, READ_MODEL_FILE, type ReadModel } from '../../src/read-model/db.js';
import { readListing } from '../../src/read-model/items.js';
import { issueFromRest } from '../../src/read-model/normalize.js';
import { MIGRATIONS } from '../../src/read-model/schema.js';
import type { GhItemNode } from '../../src/sources/github-queries.js';
import { tempDir } from '../temp-dir.js';
import { CLOSING_PRS, COMMENT_ROW, commentRow, ISSUE_ROW, issueRow, OTHER_SOURCE, REPO, REPO_ROW, REST_ISSUE, SOURCE, T1, T2, T3 } from './fixtures.js';
import { assertMode } from '../posix-only.js';

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
  for (const file of [path, `${path}-wal`]) await assertMode(t, file, 0o600, file); // win32: no POSIX mode bits
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
  assert.deepEqual(db.issue(SOURCE, REPO, 12), { ...ISSUE_ROW, title: 'renamed', updatedAt: T2, pullRequests: [CLOSING_PRS[0]], parentNumber: null });
});

test('issues and issue answer assignees and closing PRs, leave PRs out, and never another source\'s rows (#178)', async () => {
  const db = await memory();
  db.upsertIssue(issueRow(1, T1, { state: 'open' }), 'sync');
  db.upsertIssue(issueRow(2, T3, { state: 'open' }), 'sync');
  db.upsertIssue(issueRow(3, T2, { state: 'open', kind: 'pr' }), 'sync');
  db.upsertIssue(issueRow(2, T3, { state: 'open', source: OTHER_SOURCE, title: 'theirs' }), 'sync');
  db.setClosingPrs(SOURCE, 'I_2', CLOSING_PRS);
  assert.deepEqual(db.issues(SOURCE, REPO, 'open'), [
    { ...issueRow(2, T3, { state: 'open' }), pullRequests: CLOSING_PRS, parentNumber: null },
    { ...issueRow(1, T1, { state: 'open' }), pullRequests: [], parentNumber: null },
  ]);
  assert.deepEqual(db.issue(SOURCE, REPO, 2)?.assignees, ['bia', 'caio']);
  assert.equal(db.issue(SOURCE, REPO, 3), undefined, 'a PR is no issue');
  assert.deepEqual(db.issue(OTHER_SOURCE, REPO, 2), { ...issueRow(2, T3, { state: 'open', source: OTHER_SOURCE, title: 'theirs' }), pullRequests: [], parentNumber: null });
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

test('the reconcile scope reads back as written, apart from the two sync scopes (#180)', async () => {
  const db = await memory();
  db.setScope(SOURCE, REPO, 'reconcile', { cursor: null, etag: null, syncedAt: T1 });
  assert.deepEqual(db.scope(SOURCE, REPO, 'reconcile'), { cursor: null, etag: null, syncedAt: T1 });
  assert.equal(db.scope(SOURCE, REPO, 'issues'), undefined);
});

test('a file at #180\'s schema version runs the repos and labels migration and keeps what it stored (#181)', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  // by hand: the model prepares every table's statements at open, so one opened at version 1 could not prepare the repos queries
  const raw = new DatabaseSync(path);
  raw.exec(`${MIGRATIONS[0]} PRAGMA user_version = 1;`);
  raw.prepare('INSERT INTO sync_scopes (source, repository, kind, cursor, etag, synced_at) VALUES (?, ?, ?, ?, ?, ?)').run(SOURCE, REPO, 'issues', T1, 'E', T2);
  raw.close();
  const { db, resync } = await openReadModel(path);
  t.after(() => db.close());
  assert.deepEqual([resync, peek(path, 'PRAGMA user_version')], [false, MIGRATIONS.length]);
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: null, etag: null, syncedAt: T2 }, 'migration 3 (#186) reads the issues again from the start');
  assert.equal(db.setRepo(REPO_ROW), true);
});

test('setRepo writes a changed row only, per source; setLabels replaces the set and says whether it changed (#181)', async () => {
  const db = await memory();
  assert.equal(db.repo(SOURCE, REPO), undefined);
  assert.equal(db.setRepo(REPO_ROW), true);
  assert.equal(db.setRepo(REPO_ROW), false, 'an identical row writes nothing');
  assert.equal(db.setRepo({ ...REPO_ROW, canPush: false, forkParent: 'up/hive' }), true);
  assert.deepEqual(db.repo(SOURCE, REPO), { ...REPO_ROW, canPush: false, forkParent: 'up/hive' });
  assert.equal(db.repo(OTHER_SOURCE, REPO), undefined);
  assert.equal(db.setLabels(SOURCE, REPO, ['docs', 'bug']), true);
  assert.equal(db.setLabels(SOURCE, REPO, ['bug', 'docs']), false, 'the same set in another order');
  assert.deepEqual(db.labels(SOURCE, REPO), ['bug', 'docs']);
  assert.equal(db.setLabels(SOURCE, REPO, ['bug']), true);
  assert.deepEqual([db.labels(SOURCE, REPO), db.labels(OTHER_SOURCE, REPO)], [['bug'], []]);
});

test('counts counts issue and PR rows by state and kind with the newest updated_at of either; issues stops at its limit (#181)', async () => {
  const db = await memory();
  assert.deepEqual(db.counts(SOURCE, REPO), { openIssues: 0, closedIssues: 0, openPrs: 0 });
  db.upsertIssue(issueRow(1, T1, { state: 'open' }), 'sync');
  db.upsertIssue(issueRow(2, T2, { state: 'open' }), 'sync');
  db.upsertIssue(issueRow(3, T1), 'sync');
  db.upsertIssue(issueRow(4, T3, { kind: 'pr', state: 'open' }), 'sync');
  db.upsertIssue(issueRow(5, T1, { kind: 'pr' }), 'sync'); // a closed PR counts nowhere
  db.upsertIssue(issueRow(6, T3, { state: 'open', source: OTHER_SOURCE }), 'sync');
  assert.deepEqual(db.counts(SOURCE, REPO), { openIssues: 2, closedIssues: 1, openPrs: 1, lastUpdatedAt: T3 });
  assert.deepEqual(db.issues(SOURCE, REPO, 'open', 1).map((i) => i.number), [2]);
  assert.equal(db.issues(SOURCE, REPO, 'open').length, 2, 'no limit: every row');
});

test('migration 6 drops the #190 items and listings: a model at version 5 opens with none stored, so the next poll reads in full (#282)', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  const raw = new DatabaseSync(path);
  raw.exec(`${MIGRATIONS.slice(0, 5).join(' ')} PRAGMA user_version = 5;`);
  raw.prepare('INSERT INTO project_items (source, node_id, project, updated_at, node) VALUES (?, ?, ?, ?, ?)').run('s', 'PVTI_1', 'acme/6', 'T', '{}');
  raw.prepare('INSERT INTO project_listings (source, scope, position, node_id) VALUES (?, ?, ?, ?)').run('s', 'acme/6', 0, 'PVTI_1');
  raw.close();
  const { db, resync } = await openReadModel(path);
  t.after(() => db.close());
  assert.deepEqual([resync, db.items.listing('s', 'acme/6'), db.githubItemRows('s', ['PVTI_1']), db.items.fields('s', 'acme/6')], [false, [], [], []]);
});

// #833: rows as #282's tables held them, one of every shape the copy maps
function seedProjectTables(raw: DatabaseSync): void {
  const insert = (table: string, rows: Record<string, string | number | null>[]): void => {
    for (const row of rows) {
      const columns = Object.keys(row);
      raw.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row));
    }
  };
  const issue = (n: number) => ({
    source: SOURCE, node_id: `I_${n}`, repository: 'acme/r', number: n, kind: 'issue', state: 'open', title: `T${n}`, body: '', labels: '[]',
    assignees: '[]', created_at: T1, updated_at: T1, comments: 0, url: `https://github.com/acme/r/issues/${n}`,
  });
  insert('issues', [issue(1), issue(2)]);
  const item = (n: number, project: string, contentType: string | null, issueNodeId: string | null, blockingRead: number | null) => ({
    source: SOURCE, node_id: `PVTI_${n}`, project, content_type: contentType, issue_node_id: issueNodeId, blocking_read: blockingRead, values_sig: `sig${n}`, updated_at: T1,
  });
  insert('project_items', [
    item(1, 'acme/6', 'Issue', 'I_1', 1), item(2, 'acme/6', 'Issue', 'I_2', 0), item(3, 'acme/6', 'Issue', 'I_3', null), // I_3: no issues row
    item(6, 'acme/6', 'DraftIssue', null, null), item(9, 'acme/7', 'Issue', 'I_1', null), // I_1 is an item of two Projects
  ]);
  insert('project_listings', ['PVTI_2', 'PVTI_1', 'PVTI_6', 'PVTI_3'].map((node_id, position) => ({ source: SOURCE, project: 'acme/6', position, node_id })));
  insert('project_listings', [{ source: SOURCE, project: 'acme/7', position: 0, node_id: 'PVTI_9' }]);
  const value = (field: string, kind: string, v: string) => ({ source: SOURCE, item_node_id: 'PVTI_1', field, kind, value: v });
  insert('item_field_values', [value('Status', 'name', 'Ready'), value('Area', 'text', 'api'), value('Estimate', 'number', '3.5'), value('Due', 'date', '2026-10-20'), value('Sprint', 'title', 'Sprint 1')]);
  const field = (position: number, name: string, dataType: string, options: string | null) => ({ source: SOURCE, project: 'acme/6', position, name, data_type: dataType, options });
  insert('project_fields', [field(0, 'Status', 'SINGLE_SELECT', '["Ready"]'), field(1, 'Sprint', 'ITERATION', '["Sprint 1"]'), field(2, 'Notes', 'TEXT', null)]);
  const relation = (kind: string, position: number, n: number, nodeId: string | null = null) =>
    ({ source: SOURCE, issue_node_id: 'I_1', kind, position, node_id: nodeId, number: n, title: `T${n}`, state: 'OPEN', repository: 'acme/r' });
  insert('issue_relations', [relation('blockedBy', 0, 7), relation('subIssue', 1, 4, 'I_4'), relation('blocking', 0, 5)]);
}

test('the #833 migration moves a file\'s Project rows onto the source-agnostic tables and drops the five old ones; the listing reads back as before', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  const raw = new DatabaseSync(path);
  raw.exec(`${MIGRATIONS.slice(0, -1).join(' ')} PRAGMA user_version = ${MIGRATIONS.length - 1};`);
  seedProjectTables(raw);
  raw.close();
  const { db, resync } = await openReadModel(path);
  t.after(() => db.close());
  assert.deepEqual([resync, peek(path, 'PRAGMA user_version')], [false, MIGRATIONS.length]);
  const six = readListing(db, { source: SOURCE, project: 'acme/6' });
  assert.deepEqual(six.nodes.map((n) => n.id), ['PVTI_2', 'PVTI_1', 'PVTI_6', 'PVTI_3'], 'the listing in its stored order');
  assert.deepEqual(six.nodes[1]?.fieldValues?.nodes, [
    { text: 'api', field: { name: 'Area' } }, { date: '2026-10-20', field: { name: 'Due' } }, { number: 3.5, field: { name: 'Estimate' } },
    { title: 'Sprint 1', field: { name: 'Sprint' } }, { name: 'Ready', field: { name: 'Status' } },
  ], 'every value kind back under its own key');
  const blocker = (n: number) => ({ number: n, title: `T${n}`, state: 'OPEN', repository: { nameWithOwner: 'acme/r' } });
  const relationsOf = (node: GhItemNode | undefined): unknown[] => [node?.content?.blockedBy?.nodes, node?.content?.subIssues?.nodes];
  const own = [[blocker(7)], [{ id: 'I_4', ...blocker(4) }]];
  assert.deepEqual(relationsOf(six.nodes[1]), own, 'blockedBy and the sub-issue');
  assert.deepEqual(six.nodes.slice(2).map((n) => n.content), [{ __typename: 'DraftIssue' }, null], 'a draft keeps its type; an issue item with no issues row has no content');
  assert.deepEqual([six.relations.get('PVTI_1'), six.relations.get('PVTI_2'), six.relations.get('PVTI_6')], [{ blocking: { nodes: [blocker(5)] } }, null, undefined], 'blocking_read 1, 0 and NULL');
  const seven = readListing(db, { source: SOURCE, project: 'acme/7' });
  assert.deepEqual([relationsOf(seven.nodes[0]), seven.relations.get('PVTI_9')], [own, undefined], 'the issue\'s relations copied for its item in the other Project too');
  assert.deepEqual(db.items.items(SOURCE, ['PVTI_1', 'PVTI_3', 'PVTI_6']).map((r) => [r.item.key, r.item.contentId, r.item.data]), [
    ['acme/r#1', 'I_1', { contentType: 'Issue' }], ['PVTI_3', 'I_3', { contentType: 'Issue' }], ['PVTI_6', null, { contentType: 'DraftIssue' }],
  ]);
  assert.deepEqual(db.items.items(SOURCE, ['PVTI_1'])[0]?.values.map((v) => v.kind), ['text', 'date', 'number', 'iteration', 'option']);
  assert.deepEqual(db.items.fields(SOURCE, 'acme/6'), [
    { name: 'Status', kind: 'SINGLE_SELECT', options: ['Ready'] }, { name: 'Sprint', kind: 'ITERATION', options: ['Sprint 1'] }, { name: 'Notes', kind: 'TEXT', options: null },
  ]);
  const gone = "('project_items', 'project_listings', 'item_field_values', 'project_fields', 'issue_relations', 'project_items_by_project', 'item_field_values_by_value')";
  assert.equal(peek(path, `SELECT COUNT(*) FROM sqlite_master WHERE name IN ${gone}`), 0, 'the five tables and their indexes are gone');
});
