import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import {
  addPrDraft, clearSubmitted, createPrReviewStore, droppedPrReviews, dropStalePrMarks, EMPTY_PR_REVIEW, markPrReviewed, prReviewPath, removePrDraft, updatePrDraft,
} from '../src/pr-review-store.js';
import type { Task, PrDraft, PrReviewFile } from '../src/types.js';
import { tempDir } from './temp-dir.js';
import { withKeptRecord } from './fixtures/work.js';

const PR = 'https://github.com/acme/app/pull/7';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const frozen = (file: PrReviewFile): PrReviewFile => JSON.parse(JSON.stringify(file), (_k, v: unknown) => (typeof v === 'object' && v !== null ? Object.freeze(v) : v)) as PrReviewFile;
const draft = (id: string, text = 'look'): PrDraft => ({ id, anchor: { path: 'a.ts', side: 'new', start: 1, end: 1, excerpt: ['x'] }, text });

test('the PR store reads a missing file as empty, writes atomically under pr-reviews/ keyed by the link, queues two edits and removes it (#592)', async (t) => {
  const home = await tempDir(t, 'pr-reviews-');
  const store = createPrReviewStore(home);
  assert.deepEqual(await store.read(PR), EMPTY_PR_REVIEW);
  await Promise.all([store.update(PR, (f) => addPrDraft(f, draft('D1'))), store.update(PR, (f) => addPrDraft(f, draft('D2')))]);
  assert.deepEqual((await store.read(PR)).drafts.map((d) => d.id), ['D1', 'D2']);
  const path = prReviewPath(home, PR);
  assert.ok(path.endsWith(`pr-reviews/${encodeURIComponent(PR)}.json`));
  assert.deepEqual(await readdir(dirname(path)), [`${encodeURIComponent(PR)}.json`], 'no temp file left');
  await store.remove(PR);
  assert.deepEqual(await store.read(PR), EMPTY_PR_REVIEW);
});

test('drafts are added, edited and removed; a submit clears the drafts it sent, keeping one added meanwhile; a #592 file reads without its general comment (#592, #758)', async (t) => {
  const two = addPrDraft(addPrDraft(frozen(EMPTY_PR_REVIEW), draft('D1')), draft('D2'));
  assert.deepEqual(updatePrDraft(frozen(two), 'D1', 'again').drafts.map((d) => d.text), ['again', 'look']);
  assert.deepEqual(removePrDraft(frozen(two), 'D1').drafts.map((d) => d.id), ['D2']);
  const later = addPrDraft(two, draft('D3'));
  assert.deepEqual(clearSubmitted(frozen(later), ['D1', 'D2']), { reviewed: [], drafts: [draft('D3')] });
  const home = await tempDir(t, 'pr-reviews-');
  await mkdir(dirname(prReviewPath(home, PR)), { recursive: true });
  await writeFile(prReviewPath(home, PR), JSON.stringify({ reviewed: [], drafts: [draft('D1')], body: 'overall' }));
  assert.deepEqual(await createPrReviewStore(home).read(PR), { reviewed: [], drafts: [draft('D1')] });
});

test('marks are per path with the hash; a mark whose file changed or left the diff drops, the same file back when none goes (#592)', () => {
  const marked = markPrReviewed(markPrReviewed(frozen(EMPTY_PR_REVIEW), { path: 'a.ts', hash: H1 }, true), { path: 'b.ts', hash: H1 }, true);
  assert.deepEqual(markPrReviewed(frozen(marked), { path: 'a.ts', hash: H2 }, true).reviewed, [{ path: 'b.ts', hash: H1 }, { path: 'a.ts', hash: H2 }]);
  assert.deepEqual(markPrReviewed(frozen(marked), { path: 'a.ts', hash: H1 }, false).reviewed, [{ path: 'b.ts', hash: H1 }]);
  const dropped = dropStalePrMarks(frozen(marked), [{ path: 'a.ts', hash: H1 }, { path: 'c.ts', hash: H2 }]);
  assert.deepEqual(dropped.reviewed, [{ path: 'a.ts', hash: H1 }]);
  assert.equal(dropStalePrMarks(dropped, [{ path: 'a.ts', hash: H1 }]), dropped);
});

test('droppedPrReviews names the PRs of the tasks a reduction dropped, not one another task still holds, and none on a stage change (#592)', () => {
  const task = (n: number): Task => ({ item: { itemId: `local:${n}`, id: `${n}`, title: '', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true });
  const prsOf = (urls: string[]) => ({ prs: urls.map((url) => ({ url, state: 'open' as const })) });
  const shared = 'https://github.com/acme/app/pull/9';
  const held = withKeptRecord({ ...initialState(0), tasks: [task(1), task(2)] }, 'local:2', 'r2', prsOf([shared])); // #629: the PRs are the records'
  const prev = withKeptRecord(held, 'local:1', 'r1', prsOf([PR, shared]));
  const next = { ...prev, tasks: [task(2)], activityRecords: prev.activityRecords.filter((r) => r.id !== 'r1') };
  assert.deepEqual(droppedPrReviews(prev, next, { type: 'closeTask', taskId: 'local:1' }), [PR]);
  assert.deepEqual(droppedPrReviews(prev, next, { type: 'setStages', stages: [], transitions: [] }), []);
});
