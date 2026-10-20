import { isDeepStrictEqual } from 'node:util';
import type { ReadModel, SyncKind, SyncScope } from './db.js';
import { commentFromRest, issueFromRest, pullFlagsFromRest } from './normalize.js';
import type { RestGet } from './rest.js';
import type { CommentRow, IssueRow } from './rows.js';

const KINDS: readonly SyncKind[] = ['issues', 'comments', 'repo', 'labels', 'assignees', 'milestones', 'issueTypes', 'pulls']; // mergeReports' order: a kind missing here is dropped
// the two since-cursor scopes; repo and labels are repo-scopes.ts's
type ListKind = Extract<SyncKind, 'issues' | 'comments'>;

/** What a sync needs (#180): the database, the read transport, whose rows these are, and the clock its scopes are stamped with. */
export interface SyncDeps { db: ReadModel; rest: RestGet; source: string; now(): Date; isStopped?: () => boolean }

/** A sync given up between pages because the loop stopped (#180): not a failure. Nothing was written for the scope that met it. */
export class SyncStopped extends Error {
  constructor() {
    super('read model: stopped');
  }
}

/** A scope that failed after storing pages: carries what those pages changed, so the round still reports it. Its message is the cause's. */
export class PartialSyncError extends Error {
  constructor(readonly original: unknown, readonly report: SyncReport) {
    super(original instanceof Error ? original.message : String(original));
  }
}

/** Between pages only: each page is its own transaction and the scope's place is written once at its end, so stopping here loses nothing. */
export function throwIfStopped(deps: SyncDeps): void {
  if (deps.isStopped?.() === true) throw new SyncStopped();
}

/** What a sync did (#180): the kinds whose stored rows changed, which the readModel event carries, and its 200s and 304s. */
export interface SyncReport { kinds: SyncKind[]; requests: { 200: number; 304: number } }

/** One scope's report; `full` when it read everything: from a null cursor to the last page, no page cut short. */
export interface ScopeReport extends SyncReport { full: boolean; blocked?: true }

export const EMPTY_REPORT: SyncReport = { kinds: [], requests: { 200: 0, 304: 0 } };

/** A scope's URL. One fixed spelling per cursor, so a saved ETag names exactly the URL it is sent with again. sort=updated: the comments
 * endpoint otherwise orders by creation, and an edited comment would fall behind the cursor. */
export function scopePath(repository: string, kind: ListKind, cursor: string | null): string {
  const since = cursor === null ? '' : `&since=${encodeURIComponent(cursor)}`;
  return kind === 'issues'
    ? `repos/${repository}/issues?state=all&sort=updated&direction=asc&per_page=100${since}`
    : `repos/${repository}/issues/comments?sort=updated&direction=asc&per_page=100${since}`;
}

export function mergeReports(a: SyncReport, b: SyncReport): SyncReport {
  return {
    kinds: KINDS.filter((kind) => a.kinds.includes(kind) || b.kinds.includes(kind)),
    requests: { 200: a.requests[200] + b.requests[200], 304: a.requests[304] + b.requests[304] },
  };
}

function itemsOf(body: unknown): unknown[] {
  if (!Array.isArray(body)) throw new Error('read model: a list answered no array');
  return body;
}

function rowOf(deps: SyncDeps, repository: string, kind: ListKind, item: unknown): IssueRow | CommentRow | undefined {
  const { db, source } = deps;
  return kind === 'issues' ? issueFromRest(source, repository, item) : commentFromRest(source, repository, item, (n) => db.nodeIdOf(source, repository, n));
}

/** Whether an issues row stands as read (#187): just written, or stored identical. The rule that lets its PR flags be written beside it. */
export function rowStands(db: ReadModel, source: string, row: IssueRow, wrote: boolean): boolean {
  return wrote || isDeepStrictEqual(db.issueByNode(source, row.nodeId), row);
}

/** A PR item's own flags beside its issues row (#186), written wherever a PR item is read: the issues scope, the full listing and the
 * refetch. Only for a row that stands as read (#187): just written, or stored identical. A row the replace rule refused (a write's answer
 * inside its window) keeps that write's flags, so a page read before a merge cannot set merged_at back. Whether they changed. */
export function storePullFlags(deps: SyncDeps, repository: string, item: unknown, row: IssueRow, wrote: boolean): boolean {
  const flags = pullFlagsFromRest(deps.source, repository, item);
  if (flags === undefined) return false;
  if (!rowStands(deps.db, deps.source, row, wrote)) return false;
  return deps.db.setPullFlags(flags);
}

interface PageStored { last: string | undefined; blocked: boolean; wrote: boolean; pulls: boolean }

// One page in one transaction: the last updated_at it stored, whether a comment with no stored issue stopped it, whether a row was written,
// and whether a PR's flags changed (#186)
function storePage(deps: SyncDeps, repository: string, kind: ListKind, items: unknown[]): PageStored {
  const { db } = deps;
  return db.transaction(() => {
    let last: string | undefined;
    let wrote = false;
    let pulls = false;
    for (const item of items) {
      const row = rowOf(deps, repository, kind, item);
      if (row === undefined) return { last, blocked: true, wrote, pulls };
      const written = 'number' in row ? db.upsertIssue(row, 'sync') : db.upsertComment(row, 'sync');
      wrote = wrote || written;
      if ('number' in row) pulls = storePullFlags(deps, repository, item, row, written) || pulls;
      last = row.updatedAt;
    }
    return { last, blocked: false, wrote, pulls };
  });
}

interface PagesRead { report: SyncReport; last: string | null; firstEtag: string | null; blocked: boolean }

// Every page from the saved cursor; undefined on a 304, which only a first page sent with its ETag can answer
async function readPages(deps: SyncDeps, repository: string, kind: ListKind, saved: SyncScope | undefined): Promise<PagesRead | undefined> {
  let path: string | undefined = scopePath(repository, kind, saved?.cursor ?? null);
  let read: PagesRead = { report: EMPTY_REPORT, last: saved?.cursor ?? null, firstEtag: null, blocked: false };
  let first = true;
  try {
    while (path !== undefined) {
      throwIfStopped(deps);
      const answer = await deps.rest(path, first ? (saved?.etag ?? undefined) : undefined);
      if (answer.status === 304) return undefined;
      if (answer.status !== 200) throw new Error(`read model: the ${kind} of ${repository} answered HTTP ${answer.status}`);
      const page = storePage(deps, repository, kind, itemsOf(answer.body));
      read = {
        report: mergeReports(read.report, { kinds: [...(page.wrote ? [kind] : []), ...(page.pulls ? ['pulls' as const] : [])], requests: { 200: 1, 304: 0 } }),
        last: page.last ?? read.last, firstEtag: first ? (answer.etag ?? null) : read.firstEtag, blocked: page.blocked,
      };
      path = page.blocked ? undefined : answer.next;
      first = false;
    }
  } catch (error) {
    // the pages already stored are in the model: the round reports their kinds though this scope's place stays
    throw read.report.kinds.length > 0 ? new PartialSyncError(error, read.report) : error;
  }
  return read;
}

/** One scope of one repository (#180): every page from its cursor, then the cursor on the last updated_at stored. A throw leaves the scope
 * where it was: it never reaches setScope. */
export async function syncScope(deps: SyncDeps, repository: string, kind: ListKind): Promise<ScopeReport> {
  const { db, source } = deps;
  const saved = db.scope(source, repository, kind);
  const from = saved?.cursor ?? null;
  const read = await readPages(deps, repository, kind, saved);
  const syncedAt = deps.now().toISOString();
  if (read === undefined) {
    // a 304 is a complete round: the lists' syncedAt says the data is that fresh
    db.setScope(source, repository, kind, { cursor: from, etag: saved?.etag ?? null, syncedAt });
    return { kinds: [], requests: { 200: 0, 304: 1 }, full: false };
  }
  // The first page's ETag names the URL of the cursor the run started from: kept only while that cursor stands and no page was cut short,
  // so a 304 never hides a comment still to be read
  const etag = read.last === from && !read.blocked ? read.firstEtag : null;
  db.setScope(source, repository, kind, { cursor: read.last, etag, syncedAt: read.blocked ? (saved?.syncedAt ?? null) : syncedAt });
  return { ...read.report, full: from === null && !read.blocked, ...(read.blocked ? { blocked: true as const } : {}) };
}
