import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadModel, READ_MODEL_FILE, type ReadModel } from '../../src/read-model/db.js';
import type { PullFlags } from '../../src/read-model/rows.js';
import { MIGRATIONS } from '../../src/read-model/schema.js';
import { tempDir } from '../temp-dir.js';
import { HEAD, issueRow, OTHER_SOURCE, prIssueRow, pullKey, REPO, SOURCE, T1, T2, T3 } from './fixtures.js';

const memory = async (): Promise<ReadModel> => (await openReadModel(':memory:')).db;
const flags = (n: number, draft: boolean, mergedAt: string | null): PullFlags => ({ ...pullKey(n), draft, mergedAt });
const LINK = 'https://github.com/acme/hive/pull/';

test('migration 3 on a version-2 file creates pulls and clears the issues scopes\' cursor and ETag, keeping synced_at (#186)', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  // by hand: the model prepares the pulls statements at open, so one opened at version 2 could not
  const raw = new DatabaseSync(path);
  raw.exec(`${MIGRATIONS[0]} ${MIGRATIONS[1]} PRAGMA user_version = 2;`);
  const scope = raw.prepare('INSERT INTO sync_scopes (source, repository, kind, cursor, etag, synced_at) VALUES (?, ?, ?, ?, ?, ?)');
  scope.run(SOURCE, REPO, 'issues', T1, 'EI', T2);
  scope.run(SOURCE, REPO, 'comments', T1, 'EC', T2);
  raw.close();
  const { db, resync } = await openReadModel(path);
  t.after(() => db.close());
  assert.equal(resync, false);
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: null, etag: null, syncedAt: T2 });
  assert.deepEqual(db.scope(SOURCE, REPO, 'comments'), { cursor: T1, etag: 'EC', syncedAt: T2 });
  assert.equal(db.setPullFlags(flags(7, false, null)), true);
});

test('the list joins pulls to the PR rows: open, merged and closed by merged_at, newest first, capped by limit; a PR with no pulls row lists with the defaults; another source sees none (#186)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(7, T2), 'sync');
  db.upsertIssue(prIssueRow(8, T3), 'sync'); // no pulls row yet
  db.upsertIssue(prIssueRow(5, T1, { state: 'closed', closedAt: T1 }), 'sync');
  db.upsertIssue(prIssueRow(4, T1, { state: 'closed', closedAt: T1 }), 'sync'); // closed with no pulls row: closed, never merged
  db.upsertIssue(issueRow(1, T3, { state: 'open' }), 'sync'); // an issue is never a PR row
  db.setPullFlags(flags(7, true, null));
  db.setPullFlags(flags(5, false, T1));
  assert.deepEqual(db.prs(SOURCE, REPO, 'open'), [
    { url: `${LINK}8`, number: 8, title: 'T8', state: 'open', isDraft: false, mergeState: 'unknown', updatedAt: T3 },
    { url: `${LINK}7`, number: 7, title: 'T7', state: 'open', isDraft: true, mergeState: 'unknown', updatedAt: T2 },
  ]);
  assert.deepEqual(db.prs(SOURCE, REPO, 'merged').map((r) => [r.number, r.state]), [[5, 'merged']]);
  assert.deepEqual(db.prs(SOURCE, REPO, 'closed').map((r) => [r.number, r.state]), [[4, 'closed']]);
  assert.deepEqual(db.prCounts(SOURCE, REPO), { open: 2, merged: 1, closed: 1 });
  assert.deepEqual(db.prs(SOURCE, REPO, 'open', { limit: 1 }).map((r) => r.number), [8]);
  assert.deepEqual([db.prs(OTHER_SOURCE, REPO, 'open'), db.prCounts(OTHER_SOURCE, REPO)], [[], { open: 0, merged: 0, closed: 0 }]);
});

test('each pulls writer sets only its own columns and writes only on a change; pullsToRead follows updated_at past read_at (#186)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(7, T2), 'sync');
  assert.deepEqual(db.pullsToRead(SOURCE, REPO), [{ nodeId: 'PR_7', number: 7, isOpen: true, updatedAt: T2 }], 'never read');
  assert.deepEqual([db.setPullFlags(flags(7, false, null)), db.setPullFlags(flags(7, false, null))], [true, false]);
  const poll = { headSha: HEAD, mergeState: 'clean', checks: 'failure' } as const;
  assert.deepEqual([db.setPullPoll(pullKey(7), poll), db.setPullPoll(pullKey(7), poll)], [true, false]);
  assert.equal(db.setPullRead(pullKey(7), { decision: 'approved', readAt: T2 }), true);
  const [read] = db.prs(SOURCE, REPO, 'open');
  assert.deepEqual([read?.checks, read?.mergeState, read?.decision], ['failure', 'clean', 'approved'], 'the decision alone leaves the poll\'s columns');
  assert.deepEqual(db.pullsToRead(SOURCE, REPO), [], 'read at its updated_at');
  db.upsertIssue(prIssueRow(7, T3, { state: 'closed', closedAt: T3 }), 'sync');
  assert.deepEqual(db.pullsToRead(SOURCE, REPO), [{ nodeId: 'PR_7', number: 7, isOpen: false, updatedAt: T3 }]);
  assert.equal(db.setPullRead(pullKey(7), { decision: null, readAt: T3, settled: { mergeState: 'unknown', checks: null } }), true);
  const [settled] = db.prs(SOURCE, REPO, 'closed');
  assert.deepEqual([settled?.checks, settled?.mergeState, settled?.decision], [undefined, 'unknown', undefined]);
  assert.deepEqual(db.openPulls(SOURCE, REPO), []);
});

test('openPulls lists the open PRs with what the poll stored; an author filter keeps one login\'s PRs in every read (#186)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(7, T1), 'sync'); // bia's
  db.upsertIssue(prIssueRow(9, T1, { author: 'caio' }), 'sync');
  db.setPullPoll(pullKey(7), { headSha: HEAD, mergeState: 'behind', checks: null });
  assert.deepEqual(db.openPulls(SOURCE, REPO), [
    { nodeId: 'PR_7', number: 7, headSha: HEAD, mergeState: 'behind' }, { nodeId: 'PR_9', number: 9, headSha: null, mergeState: 'unknown' },
  ]);
  assert.deepEqual(db.openPulls(SOURCE, REPO, 'bia').map((pr) => pr.number), [7]);
  assert.deepEqual(db.pullsToRead(SOURCE, REPO, 'bia').map((pr) => pr.number), [7]);
  assert.deepEqual(db.prs(SOURCE, REPO, 'open', { author: 'bia' }).map((r) => r.number), [7]);
  assert.deepEqual(db.prCounts(SOURCE, REPO, 'bia'), { open: 1, merged: 0, closed: 0 });
});

test('removeScopes drops one PR\'s poll scopes only; removeIssue drops its pulls row (#186)', async () => {
  const db = await memory();
  for (const kind of ['pull/7/pr', 'pull/7/runs', 'pull/70/pr'] as const) db.setScope(SOURCE, REPO, kind, { cursor: null, etag: 'E', syncedAt: T1 });
  db.removeScopes(SOURCE, REPO, 'pull/7/');
  assert.deepEqual([db.scope(SOURCE, REPO, 'pull/7/pr'), db.scope(SOURCE, REPO, 'pull/7/runs'), db.scope(SOURCE, REPO, 'pull/70/pr')?.etag], [undefined, undefined, 'E']);
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  db.setPullFlags(flags(7, true, null));
  db.removeIssue(SOURCE, 'PR_7');
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  assert.equal(db.prs(SOURCE, REPO, 'open')[0]?.isDraft, false, 'the old flags left with the row');
});
