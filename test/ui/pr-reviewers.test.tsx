import { expect, test } from 'vitest';
import { reviewersOf } from '@/lib/pr-reviewers';
import type { PrReviewEvent } from '../../src/types';
import { prData, thread } from './pr-harness';

const T1 = '2026-09-30T10:00:00.000Z';
const T2 = '2026-09-30T11:00:00.000Z';
const review = (author: string, kind: PrReviewEvent['kind'], at: string): PrReviewEvent => ({ id: `${author}@${at}`, author, at, kind, text: '' });

test('each reviewer\'s latest review gives the row, newest first: approved, a change request with no thread of theirs, commented (#66)', () => {
  const pr = prData({ threads: [], reviews: [review('caio', 'changes', T1), review('dan', 'commented', T1), review('caio', 'approved', T2), review('eva', 'changes', T2)] });
  expect(reviewersOf(pr)).toEqual([
    { login: 'caio', team: false, state: 'approved' }, { login: 'eva', team: false, state: 'changes' }, { login: 'dan', team: false, state: 'commented' },
  ]);
});

test('a change request reads resolved once every thread its author opened is resolved; one open thread keeps it changes; another person\'s thread does not count (#66)', () => {
  const reviews = [review('bia', 'changes', T1)];
  const bias = (resolved: boolean, id: string) => thread({ id, resolved }); // the harness thread's first comment is bia's
  const caios = thread({ id: 'T9', resolved: false, comments: [{ id: 'C9', author: 'caio', at: T1, text: 'x' }] });
  expect(reviewersOf(prData({ reviews, threads: [bias(true, 'T1'), bias(true, 'T2'), caios] }))[0].state).toBe('resolved');
  expect(reviewersOf(prData({ reviews, threads: [bias(true, 'T1'), bias(false, 'T2')] }))[0].state).toBe('changes');
  expect(reviewersOf(prData({ reviews, threads: [caios] }))[0].state).toBe('changes'); // none of hers: nothing to resolve
});

test('requests come first in GitHub\'s order; a pending request overrides an older review of the same person; a team request is its slug and hides no user (#66)', () => {
  const pr = prData({
    reviews: [review('ana', 'approved', T2), review('caio', 'changes', T1)],
    reviewRequests: [{ reviewer: 'caio', team: false, viewer: false }, { reviewer: 'ana', team: true, viewer: false }],
  });
  expect(reviewersOf(pr)).toEqual([
    { login: 'caio', team: false, state: 'requested' }, { login: 'ana', team: true, state: 'requested' }, { login: 'ana', team: false, state: 'approved' },
  ]);
});

test('no review and no request: no row (#66)', () => {
  expect(reviewersOf(prData())).toEqual([]);
});
