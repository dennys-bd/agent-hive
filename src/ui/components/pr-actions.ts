// The PR routes as the PR's views call them (#592, #758), by the PR's link: act's toast on a refusal, except enviar revisão and the merge,
// whose refusal the view shows itself, so they reject with GitHub's message.
import type { LineAnchor, MergeMethod, PrReviewEventInput } from '../../types';
import { act } from '@/components/actions';
import { prPath } from '@/hooks/use-pr';
import { sendJson } from '../lib/api.js';

type Anchor = LineAnchor & { excerpt: string[] };
const segment = (value: string): string => encodeURIComponent(value);

export const prMark = (url: string, body: { path: string; hash: string; reviewed: boolean }): Promise<unknown> => act(prPath(url, '/reviewed'), body);
export const prAddDraft = (url: string, body: { anchor: Anchor; text: string }): Promise<unknown> => act(prPath(url, '/drafts'), body);
export const prEditDraft = (url: string, draft: string, text: string): Promise<unknown> => act(prPath(url, `/drafts/${segment(draft)}`), { text }, 'PUT');
export const prDropDraft = (url: string, draft: string): Promise<unknown> => act(prPath(url, `/drafts/${segment(draft)}`), undefined, 'DELETE');
/** enviar (#592): `{ ok: true }` once GitHub took it, undefined after act's toast. */
export const prComment = (url: string, body: { head: string; anchor: Anchor; text: string }): Promise<{ ok: true } | undefined> =>
  act<{ ok: true }>(prPath(url, '/comment'), body);
export const prReply = (url: string, thread: string, text: string): Promise<unknown> => act(prPath(url, `/threads/${segment(thread)}/reply`), { text });
export const prResolve = (url: string, thread: string, resolved: boolean): Promise<unknown> =>
  act(prPath(url, `/threads/${segment(thread)}/resolve`), { resolved });
/** send review (#592, #758): rejects with GitHub's message, which the view shows. */
export const prSubmit = (url: string, body: { head: string; event: PrReviewEventInput; body: string }): Promise<unknown> => sendJson('POST', prPath(url, '/review'), body);
/** The merge (#592): rejects with GitHub's message, which the view shows. */
export const prMerge = (url: string, body: { method: MergeMethod; head: string }): Promise<unknown> => sendJson('POST', prPath(url, '/merge'), body);
