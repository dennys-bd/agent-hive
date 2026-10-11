// The this PR block's review rows (#66): one per person, from what PrData already holds. Pure. ponytail: the reviews are the timeline's last
// 100, so on a very long PR an old reviewer may be missing; read more of the timeline if that ever shows
import type { PrData, PrReviewEvent } from '../../types.js';

export type ReviewerState = 'approved' | 'changes' | 'resolved' | 'commented' | 'requested';
export interface Reviewer { login: string; team: boolean; state: ReviewerState }

// A person's newest submitted review; GitHub writes every time in one ISO format, so the text order is the time order
const latestOf = (reviews: PrReviewEvent[]): PrReviewEvent => reviews.reduce((kept, review) => (review.at >= kept.at ? review : kept));

// A change request reads resolved once every review thread its author opened (the thread's first comment is theirs) is resolved; with no
// thread of theirs there is nothing to resolve
function changesOf(pr: PrData, login: string): 'changes' | 'resolved' {
  const own = pr.threads.filter((thread) => thread.comments[0]?.author === login);
  return own.length > 0 && own.every((thread) => thread.resolved) ? 'resolved' : 'changes';
}

/** Who reviews the PR (#66): every pending request first, in GitHub's order, a team by its slug; then each other person by their latest
 * submitted review, newest first. A person both requested and reviewed shows the request: GitHub asks them again. A team request hides no
 * user, since GitHub does not say who is in the team. */
export function reviewersOf(pr: PrData): Reviewer[] {
  const requests = pr.reviewRequests.map((request): Reviewer => ({ login: request.reviewer, team: request.team, state: 'requested' }));
  const isRequested = (login: string): boolean => pr.reviewRequests.some((request) => !request.team && request.reviewer === login);
  const authors = [...new Set(pr.reviews.map((review) => review.author))].filter((login) => !isRequested(login));
  const reviewed = authors.map((login) => latestOf(pr.reviews.filter((review) => review.author === login)))
    .sort((a, b) => b.at.localeCompare(a.at)) // a new array: pr.reviews keeps its order
    .map((review): Reviewer => ({ login: review.author, team: false, state: review.kind === 'changes' ? changesOf(pr, review.author) : review.kind }));
  return [...requests, ...reviewed];
}
