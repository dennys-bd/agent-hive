import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReadModel, type SyncKind } from '../../src/read-model/db.js';
import { applyWriteAnswer, type WriteAnswerDeps } from '../../src/read-model/write-answer.js';
import { syncScope } from '../../src/read-model/sync.js';
import { COMMENT_ROW, fakeRest, ISSUE_ROW, NOW, ok, REPO, restPr, SOURCE, T1, T2 } from './fixtures.js';

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

const PR_ROW = { ...ISSUE_ROW, nodeId: 'PR_7', number: 7, kind: 'pr' as const, state: 'open' as const, closedAt: null, updatedAt: T1 };
const MERGED = { ...PR_ROW, state: 'closed' as const, closedAt: T2, updatedAt: T2 };
const KEY = { source: SOURCE, nodeId: 'PR_7', repository: REPO, number: 7 };
const REVIEW = { source: SOURCE, nodeId: 'PRR_1', pullNodeId: 'PR_7', repository: REPO, author: 'caio', state: 'APPROVED' as const, body: '', submittedAt: T2 };

test('a review answer and a merge answer upsert their rows with origin write and notify pulls beside issues (#187)', async () => {
  const { deps, notified } = await model({ now: 1_000 });
  deps.db.upsertIssue(PR_ROW, 'sync');
  assert.deepEqual(applyWriteAnswer(deps, REPO, { issues: [{ ...PR_ROW, updatedAt: T2 }], reviews: [REVIEW] }), ['issues', 'pulls']);
  assert.deepEqual(applyWriteAnswer(deps, REPO, { issues: [MERGED], pullFlags: [{ ...KEY, draft: false, mergedAt: T2 }] }), ['issues', 'pulls']);
  const page = deps.db.prPage(SOURCE, REPO, 7);
  assert.deepEqual([page?.reviews.map((r) => r.nodeId), page?.issue.state, page?.pull?.mergedAt], [['PRR_1'], 'closed', T2]);
  assert.deepEqual(notified.map(([, kinds]) => kinds), [['issues', 'pulls'], ['issues', 'pulls']]);
});

test('a sync page read before the merge, with a tied updated_at inside the window, sets back neither the row nor merged_at; past the window it does (#187)', async () => {
  const clock = { now: 1_000 };
  const { deps } = await model(clock);
  applyWriteAnswer(deps, REPO, { issues: [MERGED], pullFlags: [{ ...KEY, draft: false, mergedAt: T2 }] });
  clock.now += WINDOW_MS - 1;
  const before = restPr(7, T2); // open, merged_at null: read before the merge, in the merge's own second
  const page = (): Promise<{ kinds: SyncKind[] }> => syncScope({ db: deps.db, rest: fakeRest([ok([before])]).rest, source: SOURCE, now: NOW }, REPO, 'issues');
  assert.deepEqual((await page()).kinds, []);
  const kept = deps.db.prPage(SOURCE, REPO, 7);
  assert.deepEqual([kept?.issue.state, kept?.pull?.mergedAt], ['closed', T2]);
  clock.now += 1;
  deps.db.setScope(SOURCE, REPO, 'issues', { cursor: null, etag: null, syncedAt: null });
  assert.deepEqual((await page()).kinds, ['issues', 'pulls'], 'past the window the sync is the truth again, flags with it');
});

test('a PR item whose row is already stored identical still writes its flags: the refill of an unchanged row (#187)', async () => {
  const { deps } = await model({ now: 1_000 });
  const item = restPr(5, T1, T1);
  const sync = { db: deps.db, rest: fakeRest([ok([item])]).rest, source: SOURCE, now: NOW };
  await syncScope(sync, REPO, 'issues');
  deps.db.removeIssue(SOURCE, 'PR_5'); // the flags go with the row; the row comes back identical below
  await syncScope({ ...sync, rest: fakeRest([ok([item])]).rest }, REPO, 'issues');
  deps.db.setScope(SOURCE, REPO, 'issues', { cursor: null, etag: null, syncedAt: null });
  deps.db.setPullFlags({ source: SOURCE, nodeId: 'PR_5', repository: REPO, number: 5, draft: true, mergedAt: null }); // drifted
  assert.deepEqual((await syncScope({ ...sync, rest: fakeRest([ok([item])]).rest }, REPO, 'issues')).kinds, ['pulls']);
  assert.equal(deps.db.prPage(SOURCE, REPO, 5)?.pull?.mergedAt, T1);
});

test('a write answer whose PR row the replace rule refuses does not write its flags: a stored newer merge keeps merged_at (#187)', async () => {
  const { deps, notified } = await model({ now: 1_000 });
  deps.db.upsertIssue(MERGED, 'sync');
  deps.db.setPullFlags({ ...KEY, draft: false, mergedAt: T2 });
  const older = { ...PR_ROW, updatedAt: T1 };
  assert.deepEqual(applyWriteAnswer(deps, REPO, { issues: [older], pullFlags: [{ ...KEY, draft: false, mergedAt: null }] }), []);
  assert.equal(deps.db.prPage(SOURCE, REPO, 7)?.pull?.mergedAt, T2);
  assert.deepEqual(notified, []);
});
