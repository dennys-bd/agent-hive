import { createContext, useContext } from 'react';
import { SESSION_ID_CHARS } from '../../tasks';
import { agentName } from '../../agents';
import { type AgentId, type DiffScope, type LineAnchor, NEW_SESSION, type ReviewFile } from '../../types';
import { DefaultAgentContext } from '@/components/NewRunButton';
import type { CommentTarget } from '@/components/review-surface';
import { t } from '@/i18n';
import type { ReviewKey } from '@/lib/review-events';
import type { ReviewSession } from '@/lib/review-view';

/** What a diff pane's review components share (#591), and the design panel's (#113). reviewKey: the review its actions go to (#345). */
export interface ReviewPane {
  reviewKey: ReviewKey; scope: DiffScope; task: string; review: ReviewFile; sessions: ReviewSession[]; defaultSession: string;
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
export const BOX = 'my-1 max-w-[620px] rounded-lg border bg-card p-2 font-sans text-[13px] leading-[19px]';

export const lineLabel = (anchor: Pick<LineAnchor, 'start' | 'end'>): string =>
  (anchor.start === anchor.end ? t('review.line', { n: anchor.start }) : t('review.lines', { start: anchor.start, end: anchor.end }));

/** The agent session `id` of the pane's task ran (#925): its record's; a new session, or one outside a diff pane, the default agent's. */
export function useSessionAgent(id: string): AgentId {
  const pane = useContext(ReviewContext);
  const fallback = useContext(DefaultAgentContext);
  return pane?.sessions.find((s) => s.id === id)?.agent ?? fallback;
}

/** A session as plain text (#591): its agent and the id's first 8 characters, where no icon can sit (an alert's sentence, a filter's
 * haystack); SessionLabel is the same name with the agent's icon. A session the list does not hold has no agent to name (#925). */
export function sessionName(id: string, sessions: readonly Pick<ReviewSession, 'id' | 'agent'>[]): string {
  if (id === NEW_SESSION) return t('review.newSession');
  const agent = sessions.find((s) => s.id === id)?.agent;
  const short = id.slice(0, SESSION_ID_CHARS);
  return agent === undefined ? short : `${agentName(agent)} ${short}`;
}
