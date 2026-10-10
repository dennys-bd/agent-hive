import { AGENTS } from './agents.js';
import { SESSION_ID_CHARS } from './tasks.js';
import { NEW_SESSION, type ReviewAnchor, type ReviewMessage, type ReviewThread } from './types.js';

// What a session receives (#591): one builder for a comment sent now and for a batch, so both carry the anchor and the way back.

export const CHIP_ID_CHARS = 4;
// The icon's room in a chip's text: an em space, one font size wide, which the field's backdrop draws the agent's icon over
const ICON_ROOM = ' ';

/** What a chip reads after its agent's mark: four characters of the id, or the new-session label. */
export const chipId = (id: string, newLabel: string): string => (id === NEW_SESSION ? newLabel : id.slice(0, CHIP_ID_CHARS));

/** A chip as the text holds it: @, the icon's room, ·, what chipId reads. Stored, a new session's reads "new" in every language; the field
 * shows its own label. */
export const chipText = (id: string, newLabel: string = NEW_SESSION): string => `@${ICON_ROOM}·${chipId(id, newLabel)}`;

// ponytail: every session is claude's; name the session's own agent once #101 brings a second one
const AGENT = AGENTS.claude.label.toLowerCase();

/** A mentioned session as the agent reads it: @claude and the id's first 8 characters. */
export const mentionName = (id: string): string => `@${AGENT} ${id === NEW_SESSION ? 'new session' : id.slice(0, SESSION_ID_CHARS)}`;

/** The text with each of its mentions' chips written as the session's name, where it was. */
export const withMentionNames = (text: string, mentions: readonly string[] = []): string =>
  mentions.reduce((rest, id) => rest.split(chipText(id)).join(mentionName(id)), text);

// A fence longer than any backtick run of the excerpt, so the excerpt never closes it
function fenceFor(lines: string[]): string {
  const longest = Math.max(0, ...lines.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length)));
  return '`'.repeat(Math.max(3, longest + 1));
}

const linesOf = (anchor: ReviewAnchor): string => (anchor.start === anchor.end ? `line ${anchor.start}` : `lines ${anchor.start}–${anchor.end}`);

export type Outgoing = Pick<ReviewMessage, 'text' | 'mentions'>;

// Who else the message names, before the excerpt: each recipient reads which mention is itself. None without a mention
function mentionsLine(mentions: readonly string[] = [], recipient: string): string[] {
  if (mentions.length === 0) return [];
  return [`Mentions: ${mentions.map((id) => `${mentionName(id)}${id === recipient ? ' (you)' : ''}`).join(', ')}`];
}

const isFrom = (message: ReviewMessage, session: string): boolean => message.author !== 'user' && message.author.session === session;

/** What `recipient` (a session id, or NEW_SESSION) has not received of the thread before `messageId`, in order: every message after the
 * last one a delivery carried to it (all of them for a session joining now), less its own replies, what was sent to it, and what a failed
 * delivery still owes it, which goes by its own reenviar. A retry of an older message owes nothing past it. */
export function missed(thread: ReviewThread, messageId: string, recipient: string): ReviewMessage[] {
  const at = thread.messages.findIndex((m) => m.id === messageId);
  const last = thread.messages.findIndex((m) => m.id === thread.received?.[recipient]);
  return thread.messages.slice(last + 1, Math.max(at, 0))
    .filter((m) => !isFrom(m, recipient) && !m.to?.includes(recipient) && !m.pending?.includes(recipient));
}

// The missed messages before the new one, each under its author and time, so the session reads the thread in order
function catchUp(earlier: readonly ReviewMessage[]): string[] {
  if (earlier.length === 0) return [];
  const lines = earlier.flatMap((m) => [`[${m.author === 'user' ? 'user' : mentionName(m.author.session)}, ${m.at}]`, withMentionNames(m.text, m.mentions)]);
  return ['Earlier in this conversation, not sent to you yet:', ...lines, 'New message:'];
}

/** The text `recipient` (a session id, or NEW_SESSION) receives: `earlier`, what missed answers for it, before the message. */
export function commentText(anchor: ReviewAnchor, threadId: string, message: Outgoing, recipient: string, earlier: readonly ReviewMessage[] = []): string {
  const fence = fenceFor(anchor.excerpt);
  return [
    `Review comment on ${anchor.path}, ${linesOf(anchor)} (conversation ${threadId}):`, ...mentionsLine(message.mentions, recipient),
    fence, ...anchor.excerpt, fence, ...catchUp(earlier), withMentionNames(message.text, message.mentions),
    `Answer with the hive_reply tool, thread "${threadId}".`,
  ].join('\n');
}

export interface BatchItem extends Outgoing { anchor: ReviewAnchor; threadId: string }

export const batchText = (items: BatchItem[], recipient: string): string =>
  items.map((item) => commentText(item.anchor, item.threadId, item, recipient)).join('\n\n');
