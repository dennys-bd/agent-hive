// The review routes as the panes call them (#591): a task's review or a workspace's local one (#345), by its key; act's toast on a refusal.
import type { DiffScope, ReviewAnchor, ThreadAnchor, UnpinnedDesignAnchor } from '../../types';
import { act } from '@/components/actions';
import type { ReviewKey } from '@/lib/review-events';

export const reviewRoute = (key: ReviewKey, rest = ''): string => `${key}/review${rest}`;

export const markFile = (key: ReviewKey, body: { scope: DiffScope; path: string; hash: string; reviewed: boolean }): Promise<unknown> =>
  act(reviewRoute(key, '/reviewed'), body);

// A design comment's anchor goes unpinned: the server gives it its pin (#111, #114)
export const sendComment = (key: ReviewKey, body: { anchor: ThreadAnchor | UnpinnedDesignAnchor; text: string; to?: string[]; mentions?: string[] }): Promise<{ failed: string[] } | undefined> =>
  act<{ failed: string[] }>(reviewRoute(key, '/threads'), body);

export const segment = (value: string): string => encodeURIComponent(value);
export const replyTo = (key: ReviewKey, thread: string, body: { text: string; mentions?: string[] }): Promise<unknown> =>
  act(reviewRoute(key, `/threads/${segment(thread)}/messages`), body);
export const retryMessage = (key: ReviewKey, thread: string, message: string): Promise<unknown> =>
  act(reviewRoute(key, `/threads/${segment(thread)}/messages/${segment(message)}/retry`));
export const resolveThread = (key: ReviewKey, thread: string, resolved: boolean): Promise<unknown> =>
  act(reviewRoute(key, `/threads/${segment(thread)}/resolve`), { resolved });

export const saveDraft = (key: ReviewKey, body: { anchor: ReviewAnchor | UnpinnedDesignAnchor; text: string; session: string }): Promise<unknown> => act(reviewRoute(key, '/drafts'), body);
export const editDraft = (key: ReviewKey, draft: string, body: { text: string; session: string }): Promise<unknown> =>
  act(reviewRoute(key, `/drafts/${segment(draft)}`), body, 'PUT');
export const dropDraft = (key: ReviewKey, draft: string): Promise<unknown> => act(reviewRoute(key, `/drafts/${segment(draft)}`), undefined, 'DELETE');
export const chooseDefaultSession = (key: ReviewKey, session: string): Promise<unknown> => act(reviewRoute(key, '/default-session'), { session }, 'PUT');
/** What a submit sends beyond skip (#111, #113): kind's drafts, path's design file only, every one to `to`. Absent: the line drafts, each
 *  to its own session. */
export interface SubmitPick { kind?: 'lines' | 'design'; path?: string; to?: string }
export const submitReview = (key: ReviewKey, skip: string[], pick: SubmitPick = {}): Promise<{ failed: string[]; unsaved?: string[] } | undefined> =>
  act<{ failed: string[]; unsaved?: string[] }>(reviewRoute(key, '/submit'), { skip, ...pick });
