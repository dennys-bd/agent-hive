// What a review pane draws, whoever is on the other side (#592): the diff pane's sessions (#591) or GitHub. Pure: each pane's conversations
// normalized to one shape the shared components read.
import type { FileDiff, LineAnchor, PrThread, ReviewAnchor, ReviewThread } from '../../types.js';
import { isOutdated, type ReviewSession, replyingSessions } from './review-view.js';

/** A comment's anchor in either pane (#592): lines on one side, and their text. */
export type SurfaceAnchor = LineAnchor & { excerpt: string[] };
/** Who wrote a message (#592): the user, a session of the task (#591), or a GitHub login. */
export type SurfaceAuthor = { kind: 'you' } | { kind: 'session'; session: string } | { kind: 'login'; login: string };
export interface SurfaceMessage { id: string; author: SurfaceAuthor; at: string; text: string; mentions?: string[]; failed?: true }
/** A conversation as the shared components draw it (#592). fileLevel: a GitHub file thread, no line; more: GitHub holds more comments;
 * participants and replying: the diff pane's only. */
export interface SurfaceConversation {
  id: string; anchor: LineAnchor; outdated: boolean; resolved: boolean; messages: SurfaceMessage[];
  fileLevel?: true; more?: true; participants?: string[]; replying?: string[];
}
/** A comment added to a review (#592); session: the diff pane's only. */
export interface SurfaceDraft { id: string; anchor: SurfaceAnchor; text: string; session?: string }

/** A task's conversation as the diff pane shows it (#591): outdated when its lines no longer read as its excerpt. */
export function sessionConversation(thread: ReviewThread & { anchor: ReviewAnchor }, file: FileDiff, sessions: ReviewSession[]): SurfaceConversation {
  return {
    id: thread.id, anchor: thread.anchor, outdated: isOutdated(file, thread.anchor), resolved: thread.resolved === true,
    participants: thread.participants, replying: replyingSessions(thread, sessions),
    messages: thread.messages.map((m): SurfaceMessage => ({
      id: m.id, at: m.at, text: m.text, author: m.author === 'user' ? { kind: 'you' } : { kind: 'session', session: m.author.session },
      ...(m.mentions === undefined ? {} : { mentions: m.mentions }), ...(m.failed ? { failed: true } : {}),
    })),
  };
}

/** A GitHub review thread as the PR page shows it (#592): the viewer's own comments read você. */
export function prConversation(thread: PrThread, viewer: string): SurfaceConversation {
  return {
    id: thread.id, anchor: thread.anchor, outdated: thread.outdated, resolved: thread.resolved,
    ...(thread.subject === 'file' ? { fileLevel: true as const } : {}), ...(thread.more ? { more: true as const } : {}),
    messages: thread.comments.map((c): SurfaceMessage => ({
      id: c.id, at: c.at, text: c.text, author: c.author === viewer ? { kind: 'you' } : { kind: 'login', login: c.author },
    })),
  };
}
