import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadModel, READ_MODEL_FILE, type ReadModel } from '../../src/read-model/db.js';
import { repoFromRest } from '../../src/read-model/normalize.js';
import { MIGRATIONS } from '../../src/read-model/schema.js';
import { tempDir } from '../temp-dir.js';
import { REPO, REPO_ROW, REST_REPO, SOURCE, T1, T2 } from './fixtures.js';

const memory = async (): Promise<ReadModel> => (await openReadModel(':memory:')).db;

test('migration 4 on a version-3 file adds the review and check tables, the page columns and methods, and refills the PR scopes, read_at and the repo ETag (#187)', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  // by hand: the model prepares the new statements at open, so one opened at version 3 could not
  const raw = new DatabaseSync(path);
  raw.exec(`${MIGRATIONS.slice(0, 3).join(' ')} PRAGMA user_version = 3;`);
  const scope = raw.prepare('INSERT INTO sync_scopes (source, repository, kind, cursor, etag, synced_at) VALUES (?, ?, ?, ?, ?, ?)');
  scope.run(SOURCE, REPO, 'pull/7/runs', 'success', 'ER', T2);
  scope.run(SOURCE, REPO, 'repo', null, 'ERP', T2);
  scope.run(SOURCE, REPO, 'issues', T1, 'EI', T2);
  raw.prepare('INSERT INTO pulls (source, node_id, repository, number, read_at) VALUES (?, ?, ?, ?, ?)').run(SOURCE, 'PR_7', REPO, 7, T1);
  raw.close();
  const { db, resync } = await openReadModel(path);
  assert.equal(resync, false);
  assert.deepEqual(db.scope(SOURCE, REPO, 'pull/7/runs'), { cursor: null, etag: null, syncedAt: T2 });
  assert.deepEqual(db.scope(SOURCE, REPO, 'repo'), { cursor: null, etag: null, syncedAt: T2 });
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: T1, etag: 'EI', syncedAt: T2 }, 'the issues scopes keep their place');
  db.close();
  const after = new DatabaseSync(path);
  t.after(() => after.close());
  const pull = after.prepare('SELECT read_at, head_ref, head_owner, commits, requested, closes, awaiting FROM pulls').get();
  assert.deepEqual({ ...pull }, { read_at: null, head_ref: '', head_owner: '', commits: 0, requested: '[]', closes: '[]', awaiting: '[]' });
  const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pull\\_%' ESCAPE '\\' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ['pull_checks', 'pull_reviews']);
});

test('the repos row carries the merge methods the repository allows; a flag GitHub answers null or omits is not allowed (#187)', async () => {
  const db = await memory();
  assert.deepEqual(repoFromRest(SOURCE, REPO, REST_REPO).methods, ['merge', 'squash']);
  assert.deepEqual(repoFromRest(SOURCE, REPO, { ...REST_REPO, allow_merge_commit: null, allow_rebase_merge: true }).methods, ['squash', 'rebase']);
  const { allow_merge_commit: _merge, allow_squash_merge: _squash, allow_rebase_merge: _rebase, ...bare } = REST_REPO;
  assert.deepEqual(repoFromRest(SOURCE, REPO, bare).methods, []);
  assert.deepEqual([db.setRepo(REPO_ROW), db.setRepo(REPO_ROW), db.setRepo({ ...REPO_ROW, methods: ['rebase'] })], [true, false, true]);
  assert.deepEqual(db.repo(SOURCE, REPO)?.methods, ['rebase']);
});
