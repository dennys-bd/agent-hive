import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReadModel, type ReadModel } from '../../src/read-model/db.js';
import type { PullChangesRow } from '../../src/read-model/rows.js';
import { HEAD, prIssueRow, REPO, SOURCE, T1, T2, T3 } from './fixtures.js';

const memory = async (): Promise<ReadModel> => (await openReadModel(':memory:')).db;
const ROW: PullChangesRow = { head: HEAD, diff: 'diff --git a/a.txt b/a.txt\n', threads: [], truncated: false, requestTimes: [] };

test('setPrChanges stores an open PR\'s diff and details; the same row again writes nothing; a new head replaces it (#497)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  assert.equal(db.setPrChanges(SOURCE, REPO, 7, ROW), true);
  assert.deepEqual(db.prChanges(SOURCE, REPO, 7), ROW);
  assert.equal(db.setPrChanges(SOURCE, REPO, 7, { ...ROW }), false, 'same head, diff and details: no write');
  const moved: PullChangesRow = { ...ROW, head: 'b'.repeat(40), behindBy: 2, requestTimes: [{ reviewer: 'ana', team: false, at: T2 }] };
  assert.equal(db.setPrChanges(SOURCE, REPO, 7, moved), true);
  assert.deepEqual(db.prChanges(SOURCE, REPO, 7), moved);
  db.upsertIssue(prIssueRow(7, T2, { title: 'Renamed' }), 'sync');
  assert.deepEqual(db.prChanges(SOURCE, REPO, 7), moved, 'an open PR\'s other change keeps the row');
  assert.equal(db.prChanges(SOURCE, REPO, 8), undefined);
});

test('a PR that is not open, or not stored, gets no row (#497)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(7, T1, { state: 'closed', closedAt: T1 }), 'sync');
  assert.equal(db.setPrChanges(SOURCE, REPO, 7, ROW), false);
  assert.equal(db.setPrChanges(SOURCE, REPO, 9, ROW), false, 'no issues row');
  assert.deepEqual([db.prChanges(SOURCE, REPO, 7), db.prChanges(SOURCE, REPO, 9)], [undefined, undefined]);
});

test('the row goes when its PR closes or merges, or when its issues row is removed (#497)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  db.setPrChanges(SOURCE, REPO, 7, ROW);
  db.upsertIssue(prIssueRow(7, T3, { state: 'closed', closedAt: T3 }), 'sync'); // a merge closes the issues row too
  assert.equal(db.prChanges(SOURCE, REPO, 7), undefined);
  db.upsertIssue(prIssueRow(8, T1), 'sync');
  db.setPrChanges(SOURCE, REPO, 8, ROW);
  db.removeIssue(SOURCE, 'PR_8');
  assert.equal(db.prChanges(SOURCE, REPO, 8), undefined);
});
