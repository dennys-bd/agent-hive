import { useState } from 'react';
import type { ReviewFile } from '../../types';
import { useReview } from '@/hooks/use-review';
import { activityKey, type TaskActivity } from '@/lib/activities';
import { type DesignComment, fileComments, type Recipient, recipientOf } from '@/lib/design-comments';
import { EMPTY_REVIEW, type ReviewSession, reviewSessions } from '@/lib/review-view';
import { useFocusedSession } from '@/lib/session-focus';

/** What a task's design pane knows of its file's comments (#113). */
export interface DesignCommentsModel {
  taskId: string; activity: TaskActivity; review: ReviewFile; sessions: ReviewSession[];
  open: DesignComment[]; resolved: DesignComment[];
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
  return { taskId, activity, review, sessions, ...fileComments(review, path), recipient, pick: setPicked, refresh };
}
