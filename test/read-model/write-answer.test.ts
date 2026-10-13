import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReadModel, type SyncKind } from '../../src/read-model/db.js';
import { applyWriteAnswer, type WriteAnswerDeps } from '../../src/read-model/write-answer.js';
import { COMMENT_ROW, ISSUE_ROW, REPO, SOURCE, T1, T2 } from './fixtures.js';

const WINDOW_MS = 30_000; // #178's written_at window
const WRITTEN = { ...ISSUE_ROW, title: 'written', updatedAt: T2 };

// A model in memory on a clock the test moves, and every notify it was asked
async function model(clock: { now: number }): Promise<{ deps: WriteAnswerDeps; notified: [string, SyncKind[]][] }> {
  const { db } = await openReadModel(':memory:', { now: () => clock.now });
  const notified: [string, SyncKind[]][] = [];
  return { deps: { db, notify: (repository, kinds) => { notified.push([repository, kinds]); } }, notified };
}

test('an issue and a comment upsert with origin write and notify both kinds; an identical or empty answer writes and notifies nothing (#183)', async () => {
  const { deps, notified } = await model({ now: 1_000 });
  const answer = { issues: [WRITTEN], comments: [COMMENT_ROW] };
  assert.deepEqual(applyWriteAnswer(deps, REPO, answer), ['issues', 'comments']);
  assert.deepEqual(applyWriteAnswer(deps, REPO, answer), []);
  assert.deepEqual(applyWriteAnswer(deps, REPO, {}), []);
  assert.deepEqual(notified, [[REPO, ['issues', 'comments']]]);
  assert.deepEqual([deps.db.issue(SOURCE, REPO, 12)?.title, deps.db.comments(SOURCE, 'I_12')], ['written', [COMMENT_ROW]]);
});

test('a sync page read before the write, with an older or tied updated_at, does not undo it inside the window; past it a tie does (#183)', async () => {
  const clock = { now: 1_000 };
  const { deps } = await model(clock);
  applyWriteAnswer(deps, REPO, { issues: [WRITTEN] });
  clock.now += WINDOW_MS - 1;
  assert.equal(deps.db.upsertIssue({ ...ISSUE_ROW, title: 'older', updatedAt: T1 }, 'sync'), false);
  assert.equal(deps.db.upsertIssue({ ...ISSUE_ROW, title: 'tied', updatedAt: T2 }, 'sync'), false);
  assert.equal(deps.db.issue(SOURCE, REPO, 12)?.title, 'written');
  clock.now += 1;
  assert.equal(deps.db.upsertIssue({ ...ISSUE_ROW, title: 'tied', updatedAt: T2 }, 'sync'), true, 'past the window the sync is the truth again');
});

test('a row the model refuses rolls the whole answer back and notifies nothing (#183)', async () => {
  const { deps, notified } = await model({ now: 1_000 });
  const broken = { ...COMMENT_ROW, body: null as unknown as string }; // comments.body is NOT NULL
  assert.throws(() => applyWriteAnswer(deps, REPO, { issues: [WRITTEN], comments: [broken] }));
  assert.deepEqual([deps.db.issue(SOURCE, REPO, 12), notified], [undefined, []]);
});
