// The design pane's comments (#113): a design file's drafts and conversations as its panel lists them, each in one of the handoff's five
// states derived from #111's stored fields, and the session enviar sends them to. Pure.
import { sameState, type TweakSchema } from '../../design-tweaks.js';
import { type DesignAnchor, type DesignTarget, type DesignTweakValue, type DesignViewport, isDesignAnchor, NEW_SESSION, type ReviewFile, type ReviewMessage, type ReviewThread, type ThreadAnchor, type UnpinnedDesignAnchor } from '../../types.js';
import { t } from '../i18n.js';

export type CommentState = 'draft' | 'agent' | 'replied' | 'agentDone' | 'resolved';

/** One item of the panel (#113): messages holds every message of a thread, its first one included; a draft has none. session: the thread's
 *  reply target, what com o agente names. isConfirmed: resolved with the agent's mark kept, resolvido pelo agente · você confirmou. */
export interface DesignComment {
  kind: 'draft' | 'thread'; id: string; anchor: DesignAnchor; text: string; at?: string; messages: ReviewMessage[];
  state: CommentState; session?: string; isConfirmed: boolean;
}

/** HH:MM in the viewer's locale, 24 h as the handoff writes it (#109, #113). */
export const clockOf = (at: Date): string => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** A design's own theme (#109): the frame's, apart from the Hive's. */
export type DesignTheme = UnpinnedDesignAnchor['theme'];

/** The pane's state a comment is made on (#241): what its pin needs to be drawn, and what choosing it reopens. */
export interface DesignState { viewport: DesignViewport; theme: DesignTheme; schema: TweakSchema; tweaks: Readonly<Record<string, DesignTweakValue>> }

/** True when `anchor` was made on `state` (#241): its viewport, theme and tweaks; a tweak the block no longer has is ignored. */
export const isOnState = (anchor: UnpinnedDesignAnchor, state: DesignState): boolean =>
  anchor.viewport === state.viewport && anchor.theme === state.theme && sameState(state.schema, anchor.tweaks, state.tweaks);

/** A comment's target as the panel and the composer head it (#113, #114): an element's selector, or an area's size. */
export const targetOf = (anchor: DesignTarget): string =>
  (anchor.kind === 'element' ? anchor.selector : t('design.area', { w: Math.round(anchor.rect.width), h: Math.round(anchor.rect.height) }));

/** The pin the server gives the file's next comment (review-store.ts's nextPin, which the UI cannot import): the highest of its drafts and
 *  threads, plus one. The composer's pin shows it before the server answers. */
export const nextPin = ({ open, resolved }: { open: readonly DesignComment[]; resolved: readonly DesignComment[] }): number =>
  Math.max(0, ...[...open, ...resolved].map((c) => c.anchor.pin)) + 1;

const onPath = (path: string) => <T extends { anchor: ThreadAnchor }>(item: T): item is T & { anchor: DesignAnchor } =>
  isDesignAnchor(item.anchor) && item.anchor.path === path;

// The server's replyTarget (review-store.ts, which the UI cannot import: it reads node:path): the last session that replied, else the first
// one the conversation reached
function replyTargetOf(thread: ReviewThread): string | undefined {
  const author = thread.messages.filter((m) => m.author !== 'user').at(-1)?.author;
  return author !== undefined && author !== 'user' ? author.session : thread.participants[0];
}

/** A conversation's state (#113): resolved; else the agent's proposal; else replied when a session wrote last; else with the agent. */
export function threadState(thread: ReviewThread): Exclude<CommentState, 'draft'> {
  if (thread.resolved) return 'resolved';
  if (thread.agentResolved) return 'agentDone';
  const last = thread.messages.at(-1);
  return last !== undefined && last.author !== 'user' ? 'replied' : 'agent';
}

// A first delivery that failed has no participant yet: the session it still owes names it
const threadItem = (thread: ReviewThread & { anchor: DesignAnchor }): DesignComment => ({
  kind: 'thread', id: thread.id, anchor: thread.anchor, text: thread.messages[0]?.text ?? '', at: thread.messages[0]?.at, messages: thread.messages,
  state: threadState(thread), session: replyTargetOf(thread) ?? thread.messages[0]?.pending?.[0], isConfirmed: thread.resolved === true && thread.agentResolved !== undefined,
});

const byPin = (a: DesignComment, b: DesignComment): number => a.anchor.pin - b.anchor.pin;

/** A design file's comments (#113): open, its drafts and the conversations not resolved; resolved, the rest; each by pin, the numbers the
 *  user sees. */
export function fileComments(review: ReviewFile, path: string): { open: DesignComment[]; resolved: DesignComment[] } {
  const drafts = review.drafts.filter(onPath(path)).map((d): DesignComment => ({ kind: 'draft', id: d.id, anchor: d.anchor, text: d.text, at: undefined, messages: [], state: 'draft', isConfirmed: false }));
  const threads = review.threads.filter(onPath(path)).map(threadItem);
  return { open: [...drafts, ...threads.filter((c) => c.state !== 'resolved')].sort(byPin), resolved: threads.filter((c) => c.state === 'resolved').sort(byPin) };
}

/** Where enviar sends (#113): how tells the footer's line, the session in focus, the user's pick, or a new session. */
export interface Recipient { session: string; how: 'focus' | 'picked' | 'new' }

/** The user's pick while it is one of the activity's sessions or a new one; else the activity's last session in focus while it is one of
 *  them; else a new session (#113, #345). */
export function recipientOf(focused: string | undefined, picked: string | undefined, sessions: readonly { id: string }[]): Recipient {
  const isTasks = (id: string | undefined): id is string => id !== undefined && sessions.some((s) => s.id === id);
  if (picked === NEW_SESSION || isTasks(picked)) return { session: picked, how: 'picked' };
  if (isTasks(focused)) return { session: focused, how: 'focus' };
  return { session: NEW_SESSION, how: 'new' };
}
