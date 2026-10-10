import { join } from 'node:path';
import { createJsonStore, type JsonStore } from './json-store.js';
import { chipText } from './review-message.js';
import type { DiffScope, FileDiff, HiveEvent, ReviewDraft, ReviewedMark, ReviewFile, ReviewMessage, ReviewThread, State } from './types.js';

// A task's review (#591): one JSON file per task under <home>/reviews/, outside State, so the reducer gains no rule and state.json does not
// grow. The edits are pure and answer a new file; the store queues each task's reads-for-write and writes them atomically.

const DIR = 'reviews';
export const EMPTY_REVIEW: ReviewFile = { reviewed: [], drafts: [], threads: [] };

/** The file of a task (#591): its item id encoded, so a `/` or a `:` never leaves the directory. */
export const reviewPath = (home: string, itemId: string): string => join(home, DIR, `${encodeURIComponent(itemId)}.json`);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// ponytail: a shallow check, the Hive is the file's only writer; a deep one if a hand edit ever breaks a pane
function parseReviewFile(raw: unknown): ReviewFile {
  if (!isObject(raw) || !Array.isArray(raw.reviewed) || !Array.isArray(raw.drafts) || !Array.isArray(raw.threads)) throw new Error('not a review file');
  return raw as unknown as ReviewFile;
}

export type ReviewStore = JsonStore<ReviewFile>;

/** `isLive`: whether the task is still in the State. An edit landing after its task left (a delivery settling, a late diff) writes nothing,
 * so it never brings back the file its removal took. */
export function createReviewStore(home: string, isLive: (itemId: string) => boolean): ReviewStore {
  return createJsonStore({ pathOf: (itemId) => reviewPath(home, itemId), empty: EMPTY_REVIEW, parse: parseReviewFile, isLive });
}

/** The tasks whose review file goes with a reduction (#591): every one it dropped from the State, but none a stage change dropped: that one
 * is a stopped source task whose stage vanished, and the next poll brings it back. */
export function droppedReviews(prev: State, next: State, event: HiveEvent): string[] {
  if (event.type === 'setStages') return [];
  const kept = new Set(next.tasks.map((c) => c.item.itemId));
  return prev.tasks.map((c) => c.item.itemId).filter((id) => !kept.has(id));
}

const sameFile = (a: Pick<ReviewedMark, 'scope' | 'path'>, b: Pick<ReviewedMark, 'scope' | 'path'>): boolean => a.scope === b.scope && a.path === b.path;

/** A file marked reviewed in its scope with its hash now, or unmarked (#591). */
export function markReviewed(file: ReviewFile, mark: ReviewedMark, reviewed: boolean): ReviewFile {
  const rest = file.reviewed.filter((m) => !sameFile(m, mark));
  return { ...file, reviewed: reviewed ? [...rest, mark] : rest };
}

/** The scope's marks whose file changed since, or left the diff, dropped (#591), so a mark never comes back when a file returns to its old
 * state. `file` itself when none goes. */
export function dropStaleMarks(file: ReviewFile, scope: DiffScope, files: Pick<FileDiff, 'path' | 'hash'>[]): ReviewFile {
  const hashes = new Map(files.map((f) => [f.path, f.hash]));
  const kept = file.reviewed.filter((m) => m.scope !== scope || hashes.get(m.path) === m.hash);
  return kept.length === file.reviewed.length ? file : { ...file, reviewed: kept };
}

export const startThread = (file: ReviewFile, thread: ReviewThread): ReviewFile => ({ ...file, threads: [...file.threads, thread] });

const withThread = (file: ReviewFile, id: string, change: (thread: ReviewThread) => ReviewThread): ReviewFile =>
  ({ ...file, threads: file.threads.map((thread) => (thread.id === id ? change(thread) : thread)) });

/** A message at the end of a conversation (#591); a new message reopens a resolved one. */
export const appendMessage = (file: ReviewFile, threadId: string, message: ReviewMessage): ReviewFile =>
  withThread(file, threadId, ({ resolved: _was, ...thread }) => ({ ...thread, messages: [...thread.messages, message] }));

/** What a delivery did (#591): per recipient asked (a session id or NEW_SESSION), the session it reached, or its failure. */
export interface Outcome { delivered: { asked: string; session: string }[]; failed: string[] }

function settled(message: ReviewMessage, outcome: Outcome): ReviewMessage {
  const { failed: _failed, pending: _pending, ...rest } = message;
  const to = [...(message.to ?? []), ...outcome.delivered.map((d) => d.session)];
  return { ...rest, to, ...(outcome.failed.length > 0 ? { failed: true as const, pending: outcome.failed } : {}) };
}

// Each reached session marked as having received the message, unless a later one reached it first (a retry of an older message)
function received(thread: ReviewThread, messageId: string, sessions: string[]): ReviewThread['received'] {
  const indexOf = (id: string | undefined): number => thread.messages.findIndex((m) => m.id === id);
  const later = sessions.filter((s) => indexOf(thread.received?.[s]) < indexOf(messageId));
  return later.length === 0 ? thread.received : { ...thread.received, ...Object.fromEntries(later.map((s) => [s, messageId])) };
}

/** A delivery's outcome written down (#591): who it reached joins the participants and has received it; what failed stays pending for
 * reenviar, marked as received by no one. */
export function settleMessage(file: ReviewFile, threadId: string, messageId: string, outcome: Outcome): ReviewFile {
  const sessions = [...new Set(outcome.delivered.map((d) => d.session))];
  return withThread(file, threadId, (thread) => {
    const marks = received(thread, messageId, sessions);
    return {
      ...thread,
      participants: [...thread.participants, ...sessions.filter((s) => !thread.participants.includes(s))],
      messages: thread.messages.map((m) => (m.id === messageId ? settled(m, outcome) : m)),
      ...(marks === undefined ? {} : { received: marks }),
    };
  });
}

export const resolve = (file: ReviewFile, threadId: string, resolved: boolean): ReviewFile =>
  withThread(file, threadId, ({ resolved: _was, ...thread }) => (resolved ? { ...thread, resolved: true } : thread));

/** Where a reply with no mention goes (#591): the last session that replied, else the one the conversation was first delivered to. */
export function replyTarget(thread: ReviewThread): string | undefined {
  const author = thread.messages.filter((m) => m.author !== 'user').at(-1)?.author;
  if (author !== undefined && author !== 'user') return author.session;
  return thread.participants[0];
}

export const addDraft = (file: ReviewFile, draft: ReviewDraft): ReviewFile => ({ ...file, drafts: [...file.drafts, draft] });
export const updateDraft = (file: ReviewFile, id: string, change: Pick<ReviewDraft, 'text' | 'session'>): ReviewFile =>
  ({ ...file, drafts: file.drafts.map((d) => (d.id === id ? { ...d, ...change } : d)) });
export const removeDraft = (file: ReviewFile, id: string): ReviewFile => ({ ...file, drafts: file.drafts.filter((d) => d.id !== id) });

/** sessão padrão (#591): a session of the task or NEW_SESSION; undefined falls back to the most recent session. */
export function setDefaultSession(file: ReviewFile, session: string | undefined): ReviewFile {
  const { defaultSession: _was, ...rest } = file;
  return session === undefined ? rest : { ...rest, defaultSession: session };
}

/** A draft delivered in a batch, with the ids its conversation takes (#591). */
export interface Converted { draft: ReviewDraft; threadId: string; messageId: string }

/** A draft's chip (#591): a draft goes to one session, so its only possible chip is that session's. */
export const draftMentions = (draft: ReviewDraft): Pick<ReviewMessage, 'mentions'> => (draft.text.includes(chipText(draft.session)) ? { mentions: [draft.session] } : {});

/** A session's delivered drafts turned into conversations with it (#591), only once the batch reached it. */
export function convertDrafts(file: ReviewFile, converted: Converted[], session: string, at: string): ReviewFile {
  const ids = new Set(converted.map(({ draft }) => draft.id));
  const threads = converted.map(({ draft, threadId, messageId }): ReviewThread => ({
    id: threadId, anchor: draft.anchor, participants: [session], received: { [session]: messageId }, messages: [{ id: messageId, author: 'user', at, text: draft.text, to: [session], ...draftMentions(draft) }],
  }));
  return { ...file, drafts: file.drafts.filter((d) => !ids.has(d.id)), threads: [...file.threads, ...threads] };
}
