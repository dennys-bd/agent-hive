import { useState } from 'react';
import { toast } from 'sonner';
import type { ReviewFile } from '../../types';
import { submitReview } from '@/components/review-actions';
import { sessionName } from '@/components/review-context';
import { useReview } from '@/hooks/use-review';
import { t } from '@/i18n';
import { activityKey, type TaskActivity } from '@/lib/activities';
import { type DesignComment, fileComments, type Recipient, recipientOf } from '@/lib/design-comments';
import { EMPTY_REVIEW, type ReviewSession, reviewSessions } from '@/lib/review-view';
import { useFocusedSession } from '@/lib/session-focus';

/** What a task's design pane knows of its file's comments (#113). */
export interface DesignCommentsModel {
  taskId: string; activity: TaskActivity; review: ReviewFile; sessions: ReviewSession[];
  open: DesignComment[]; resolved: DesignComment[];
  drafts: number; isSending: boolean; sendAll(): void;
  recipient: Recipient; pick(session: string): void; refresh(): void;
}

/** A design file's comments in a task's review (#113), read as the diff pane reads it (#591): on mount, on each review event, after each
 *  action. The recipient is the user's pick for the mounted pane, else the activity's last session in focus, else a new session. */
export function useDesignComments(activity: TaskActivity, path: string): DesignCommentsModel {
  const taskId = activity.task.item.itemId;
  const { review = EMPTY_REVIEW, refresh } = useReview(taskId);
  const sessions = reviewSessions(activity);
  const focused = useFocusedSession(activityKey(activity));
  const [picked, setPicked] = useState<string>();
  const recipient = recipientOf(focused, picked, sessions);
  const comments = fileComments(review, path);
  const drafts = comments.open.filter((c) => c.kind === 'draft').length;
  const [isSending, setSending] = useState(false);
  // ⌘⇧↵ and the footer (#113): this file's drafts, all to the recipient, in one message; one submit at a time, as the server's own guard. A
  // session that failed, or got the batch unsaved, is named in a toast and its drafts stay. ponytail: the diff pane holds an unsaved
  // session out of the next submit; here a resend pastes that batch again, hold it the same way if it bites
  const sendAll = (): void => {
    if (isSending || drafts === 0) return;
    setSending(true);
    void submitReview(taskId, [], { kind: 'design', path, to: recipient.session }).then((answer) => {
      for (const s of answer?.failed ?? []) toast.error(t('review.notDeliveredTo', { session: sessionName(s, sessions) }));
      for (const s of answer?.unsaved ?? []) toast.error(t('review.notSavedTo', { session: sessionName(s, sessions) }));
    }).finally(() => { setSending(false); refresh(); });
  };
  return { taskId, activity, review, sessions, ...comments, drafts, recipient, pick: setPicked, isSending, sendAll, refresh };
}
