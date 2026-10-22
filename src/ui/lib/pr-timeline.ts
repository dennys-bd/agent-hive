// The PR page's timeline (#758): its reviews, its review threads and its general comments as one list, oldest first.
import type { PrIssueComment, PrReviewEvent, PrThread } from '../../types';
import type { PrView } from './pr-view.js';

/** One item of the timeline (#758). */
export type TimelineItem =
  | { kind: 'review'; at: string; review: PrReviewEvent }
  | { kind: 'thread'; at: string; thread: PrThread }
  | { kind: 'comment'; at: string; comment: PrIssueComment };

/** Oldest first (#758): a review at its submission, a thread at its first comment, a general comment at its creation. A comment review with
 * no body only carries its line comments, which show as their threads: left out. */
export function timelineItems(pr: Pick<PrView, 'reviews' | 'threads' | 'comments'>): TimelineItem[] {
  const reviews = pr.reviews.filter((r) => r.kind !== 'commented' || r.text !== '').map((review): TimelineItem => ({ kind: 'review', at: review.at, review }));
  const threads = pr.threads.flatMap((thread): TimelineItem[] => (thread.comments[0] === undefined ? [] : [{ kind: 'thread', at: thread.comments[0].at, thread }]));
  const comments = pr.comments.map((comment): TimelineItem => ({ kind: 'comment', at: comment.at, comment }));
  return [...reviews, ...threads, ...comments].sort((a, b) => a.at.localeCompare(b.at)); // GitHub's ISO strings sort as the instants
}
