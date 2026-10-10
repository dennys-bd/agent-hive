import { createContext, useContext } from 'react';
import { SESSION_ID_CHARS } from '../../tasks';
import { type DiffScope, type LineAnchor, NEW_SESSION, type ReviewFile } from '../../types';
import { agentName, RUN_AGENT } from '@/components/NewRunButton';
import type { CommentTarget } from '@/components/review-surface';
import { t } from '@/i18n';
import type { ReviewSession } from '@/lib/review-view';

/** What a diff pane's review components share (#591). */
export interface ReviewPane {
  taskId: string; scope: DiffScope; task: string; review: ReviewFile; sessions: ReviewSession[]; defaultSession: string;
  refresh(): void; edit(target: CommentTarget): void;
  isSending: boolean; track<T>(request: Promise<T>): Promise<T>; // the pane's sends in flight (a comment, a reply, a reenviar)
}

export const ReviewContext = createContext<ReviewPane | undefined>(undefined);

export function useReviewPane(): ReviewPane {
  const pane = useContext(ReviewContext);
  if (pane === undefined) throw new Error('useReviewPane outside a diff pane');
  return pane;
}

/** A comment box and a conversation's task (#591): on task, border, radius-lg. */
export const BOX = 'my-1 max-w-[640px] rounded-lg border bg-card p-2 font-sans text-[13px] leading-[19px]';

export const lineLabel = (anchor: Pick<LineAnchor, 'start' | 'end'>): string =>
  (anchor.start === anchor.end ? t('review.line', { n: anchor.start }) : t('review.lines', { start: anchor.start, end: anchor.end }));

/** A session as plain text (#591): the agent and the id's first 8 characters, where no icon can sit (an alert's sentence, a filter's
 * haystack); SessionLabel is the same name with the agent's icon. */
export const sessionName = (id: string): string =>
  (id === NEW_SESSION ? t('review.newSession') : `${agentName(RUN_AGENT)} ${id.slice(0, SESSION_ID_CHARS)}`);
