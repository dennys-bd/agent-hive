import { useState } from 'react';
import { isDesignAnchor, type ReviewDraft, type ReviewFile } from '../../types';
import { submitReview } from '@/components/review-actions';

/** What the review's footer shows and does (#591). */
export interface ReviewSubmit { failed: string[]; unsaved: string[]; canSubmit: boolean; submit(): void }

const draftsOf = (drafts: ReviewDraft[], session: string): string => JSON.stringify(drafts.filter((d) => d.session === session));

/** enviar revisão for a pane (#591): one submit at a time, since a second would paste the same drafts again. A session whose batch arrived
 * but was not saved keeps its drafts, which would paste it again: they stay out of the next submit until they change. */
export function useReviewSubmit(taskId: string, review: ReviewFile | undefined, reread: () => void): ReviewSubmit {
  const [failed, setFailed] = useState<string[]>([]);
  const [held, setHeld] = useState<{ session: string; drafts: string }[]>([]);
  const [isSubmitting, setSubmitting] = useState(false);
  // Line drafts only (#111): a design draft is sent from the design pane, and a submit without kind sends none of them
  const drafts = (review?.drafts ?? []).filter((d) => !isDesignAnchor(d.anchor));
  const unsaved = held.filter((h) => draftsOf(drafts, h.session) === h.drafts).map((h) => h.session);
  const canSubmit = !isSubmitting && drafts.some((d) => !unsaved.includes(d.session));
  const submit = (): void => {
    if (!canSubmit) return;
    setSubmitting(true);
    void submitReview(taskId, unsaved).then((answer) => {
      setFailed(answer?.failed ?? []);
      setHeld([...held.filter((h) => unsaved.includes(h.session)), ...(answer?.unsaved ?? []).map((session) => ({ session, drafts: draftsOf(drafts, session) }))]);
      reread();
    }).finally(() => setSubmitting(false));
  };
  return { failed, unsaved, canSubmit, submit };
}
