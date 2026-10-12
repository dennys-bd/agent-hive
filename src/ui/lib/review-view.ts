// The review as the diff pane reads it (#591). Pure.
import { type AgentId, type Session, type DiffLine, type DiffScope, type FileDiff, isDesignAnchor, type LineAnchor, NEW_SESSION, type ReviewAnchor, type ReviewFile, type ReviewThread, type Status, type ThreadAnchor } from '../../types.js';

export const EMPTY_REVIEW: ReviewFile = { reviewed: [], drafts: [], threads: [] };

/** A route's answer checked at the boundary (#591): anything else keeps the pane on its last file. */
export const isReviewFile = (value: unknown): value is ReviewFile =>
  typeof value === 'object' && value !== null && ['reviewed', 'drafts', 'threads'].every((key) => Array.isArray((value as Record<string, unknown>)[key]));

/** Reviewed in this scope with this very diff (#591): a mark with another hash is stale and reads unreviewed. */
export const isReviewedIn = (review: ReviewFile | undefined, scope: DiffScope, file: FileDiff): boolean =>
  review?.reviewed.some((m) => m.scope === scope && m.path === file.path && m.hash === file.hash) ?? false;

export interface ReviewSession { id: string; status: Status; lastUsedAt: string; agent: AgentId } // agent: #925, the session's own

/** The task's sessions as the review offers them (#591), oldest first, each with the status of the worker running it now, else empty. */
// An activity as reviewSessions reads it: structural, since activities.ts is UI-only and this file also compiles for node
type SessionSource = { records: { sessions: Session[] }[]; sessions: { status: Status; session?: { id: string } }[] };

export const reviewSessions = (activity: SessionSource): ReviewSession[] =>
  activity.records.flatMap((r) => r.sessions).map((s) => ({ id: s.id, lastUsedAt: s.lastUsedAt, agent: s.agent, status: activity.sessions.find((a) => a.session?.id === s.id)?.status ?? 'empty' }));

/** sessão padrão (#591): the saved one while it is a session of the task or a new one, else the most recently used, else a new one. */
export function defaultSessionOf(review: ReviewFile, sessions: ReviewSession[]): string {
  const saved = review.defaultSession;
  if (saved !== undefined && (saved === NEW_SESSION || sessions.some((s) => s.id === saved))) return saved;
  return sessions.reduce<ReviewSession | undefined>((best, s) => (best === undefined || s.lastUsedAt > best.lastUsedAt ? s : best), undefined)?.id ?? NEW_SESSION;
}

/** Selected lines as an anchor (#591): the given side, else the new side unless every line is deleted; the side's lines give the range
 * and the excerpt. */
export function anchorOf(scope: DiffScope, path: string, lines: DiffLine[], given?: 'old' | 'new'): ReviewAnchor | undefined {
  const side = given ?? (lines.length > 0 && lines.every((l) => l.kind === 'del') ? 'old' : 'new');
  const numbered = lines.flatMap((l) => {
    const n = l[side];
    return n === undefined ? [] : [{ n, text: l.text }];
  });
  const first = numbered[0];
  const last = numbered.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return { scope, path, side, start: first.n, end: last.n, excerpt: numbered.map((l) => l.text) };
}

export function selectionAnchor(files: FileDiff[], scope: DiffScope, selection?: { path: string; hunk: number; from: number; to: number; side?: 'old' | 'new' }): ReviewAnchor | undefined {
  if (selection === undefined) return undefined;
  const lines = files.find((f) => f.path === selection.path)?.hunks[selection.hunk]?.lines.slice(selection.from, selection.to + 1) ?? [];
  return anchorOf(scope, selection.path, lines, selection.side); // a side-by-side selection anchors on the half it was made in
}

/** Selected lines as a PR comment's anchor (#592): #591's anchor without a scope, since a PR has one diff. */
export function selectedAnchor(files: FileDiff[], selection?: { path: string; hunk: number; from: number; to: number; side?: 'old' | 'new' }): (LineAnchor & { excerpt: string[] }) | undefined {
  const anchor = selectionAnchor(files, 'worktree', selection); // any scope: it is dropped at once
  if (anchor === undefined) return undefined;
  const { scope: _scope, ...lines } = anchor;
  return lines;
}

/** The line a comment shows under (#591): its anchor's last line on its side. */
export const endsAt = (anchor: Pick<LineAnchor, 'side' | 'end'>, line: DiffLine): boolean => line[anchor.side] === anchor.end;

// The file's lines on the anchor's side within its range, in order: a side's numbers are unique, so these are the anchored lines
const linesAt = (file: FileDiff, anchor: ReviewAnchor): DiffLine[] =>
  file.hunks.flatMap((h) => h.lines).filter((l) => {
    const n = l[anchor.side];
    return n !== undefined && n >= anchor.start && n <= anchor.end;
  });

/** Whether the lines an anchor names no longer read as its excerpt (#591): it then shows at its file's top, desatualizado. */
export function isOutdated(file: FileDiff, anchor: ReviewAnchor): boolean {
  const lines = linesAt(file, anchor);
  return lines.length !== anchor.excerpt.length || lines.some((l, i) => l.text !== anchor.excerpt[i]);
}

/** A scope's line comments on a file (#591): a design comment (#111) is never one. */
export const onFile = (scope: DiffScope, path: string) => <T extends { anchor: ThreadAnchor }>(item: T): item is T & { anchor: ReviewAnchor } =>
  !isDesignAnchor(item.anchor) && item.anchor.scope === scope && item.anchor.path === path;

/** A file's comments in the scope (#591): its drafts and conversations, what its pill shows. */
export const commentCount = (review: ReviewFile, scope: DiffScope, path: string): number =>
  review.drafts.filter(onFile(scope, path)).length + review.threads.filter(onFile(scope, path)).length;

/** The sessions answering now (#591): delivered the last user message, not replied since, and their worker working. Derived, never stored. */
export function replyingSessions(thread: ReviewThread, sessions: ReviewSession[]): string[] {
  const last = thread.messages.reduce((at, m, i) => (m.author === 'user' ? i : at), -1);
  if (last === -1) return [];
  const answered = new Set(thread.messages.slice(last + 1).flatMap((m) => (m.author === 'user' ? [] : [m.author.session])));
  const working = new Set(sessions.filter((s) => s.status === 'working').map((s) => s.id));
  return (thread.messages[last]?.to ?? []).filter((id) => thread.participants.includes(id) && !answered.has(id) && working.has(id));
}
