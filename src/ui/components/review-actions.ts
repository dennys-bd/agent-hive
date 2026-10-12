// The review routes as the pane calls them (#591): act's toast on a refusal.
import type { DiffScope, ReviewAnchor, ThreadAnchor, UnpinnedDesignAnchor } from '../../types';
import { act } from '@/components/actions';

export const reviewRoute = (taskId: string, rest = ''): string => `/tasks/${encodeURIComponent(taskId)}/review${rest}`;

export const markFile = (taskId: string, body: { scope: DiffScope; path: string; hash: string; reviewed: boolean }): Promise<unknown> =>
  act(reviewRoute(taskId, '/reviewed'), body);

// A design comment's anchor goes unpinned: the server gives it its pin (#111, #114)
export const sendComment = (taskId: string, body: { anchor: ThreadAnchor | UnpinnedDesignAnchor; text: string; to?: string[]; mentions?: string[] }): Promise<{ failed: string[] } | undefined> =>
  act<{ failed: string[] }>(reviewRoute(taskId, '/threads'), body);

export const segment = (value: string): string => encodeURIComponent(value);
export const replyTo = (taskId: string, thread: string, body: { text: string; mentions?: string[] }): Promise<unknown> =>
  act(reviewRoute(taskId, `/threads/${segment(thread)}/messages`), body);
export const retryMessage = (taskId: string, thread: string, message: string): Promise<unknown> =>
  act(reviewRoute(taskId, `/threads/${segment(thread)}/messages/${segment(message)}/retry`));
export const resolveThread = (taskId: string, thread: string, resolved: boolean): Promise<unknown> =>
  act(reviewRoute(taskId, `/threads/${segment(thread)}/resolve`), { resolved });

export const saveDraft = (taskId: string, body: { anchor: ReviewAnchor | UnpinnedDesignAnchor; text: string; session: string }): Promise<unknown> => act(reviewRoute(taskId, '/drafts'), body);
export const editDraft = (taskId: string, draft: string, body: { text: string; session: string }): Promise<unknown> =>
  act(reviewRoute(taskId, `/drafts/${segment(draft)}`), body, 'PUT');
export const dropDraft = (taskId: string, draft: string): Promise<unknown> => act(reviewRoute(taskId, `/drafts/${segment(draft)}`), undefined, 'DELETE');
export const chooseDefaultSession = (taskId: string, session: string): Promise<unknown> => act(reviewRoute(taskId, '/default-session'), { session }, 'PUT');
/** What a submit sends beyond skip (#111, #113): kind's drafts, path's design file only, every one to `to`. Absent: the line drafts, each
 *  to its own session. */
export interface SubmitPick { kind?: 'lines' | 'design'; path?: string; to?: string }
export const submitReview = (taskId: string, skip: string[], pick: SubmitPick = {}): Promise<{ failed: string[]; unsaved?: string[] } | undefined> =>
  act<{ failed: string[]; unsaved?: string[] }>(reviewRoute(taskId, '/submit'), { skip, ...pick });
