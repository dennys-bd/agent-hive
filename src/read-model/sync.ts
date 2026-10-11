import type { ReadModel } from './db.js';
import { commentFromRest, issueFromRest } from './normalize.js';
import type { RestGet, RestQuota } from './rest.js';
import type { CommentRow, IssueRow } from './rows.js';

/** What a sync needs (#765): the database, the read transport, whose rows these are, and the clock its cursors are stamped with. */
export interface SyncDeps { db: ReadModel; rest: RestGet; source: string; now(): Date }

/** What a sync did (#765): whether a stored row changed, its 200s and 304s, and the last quota reading. */
export interface SyncReport { changed: boolean; requests: { 200: number; 304: number }; quota?: RestQuota }

type ScopeKind = 'issues' | 'comments';

export const EMPTY_REPORT: SyncReport = { changed: false, requests: { 200: 0, 304: 0 } };

export const scopeOf = (source: string, repository: string, kind: ScopeKind | 'reconcile'): string => `${source}|${repository}|${kind}`;

/** A scope's URL (#765). One fixed spelling per cursor, so a saved ETag names exactly the URL it is sent with again. sort=updated: the
 * comments endpoint otherwise orders by creation and an edited comment would fall behind the cursor. */
export function scopePath(repository: string, kind: ScopeKind, cursor: string | null): string {
  const since = cursor === null ? '' : `&since=${encodeURIComponent(cursor)}`;
  return kind === 'issues'
    ? `repos/${repository}/issues?state=all&sort=updated&direction=asc&per_page=100${since}`
    : `repos/${repository}/issues/comments?sort=updated&direction=asc&per_page=100${since}`;
}

export function mergeReports(a: SyncReport, b: SyncReport): SyncReport {
  const quota = b.quota ?? a.quota;
  return {
    changed: a.changed || b.changed, requests: { 200: a.requests[200] + b.requests[200], 304: a.requests[304] + b.requests[304] },
    ...(quota === undefined ? {} : { quota }),
  };
}

function itemsOf(body: unknown): unknown[] {
  if (!Array.isArray(body)) throw new Error('read model: a list answered no array');
  return body;
}

function rowOf(deps: SyncDeps, repository: string, kind: ScopeKind, item: unknown): IssueRow | CommentRow | undefined {
  const { db, source } = deps;
  return kind === 'issues' ? issueFromRest(source, repository, item) : commentFromRest(source, repository, item, (n) => db.nodeIdOf(source, repository, n));
}

// One page in one transaction: the last updated_at it stored, and whether a comment with no stored issue stopped it there
function storePage(deps: SyncDeps, repository: string, kind: ScopeKind, items: unknown[]): { last: string | undefined; blocked: boolean } {
  const { db } = deps;
  return db.transaction(() => {
    let last: string | undefined;
    for (const item of items) {
      const row = rowOf(deps, repository, kind, item);
      if (row === undefined) return { last, blocked: true };
      if ('number' in row) db.upsertIssue(row);
      else db.upsertComment(row);
      last = row.updatedAt;
    }
    return { last, blocked: false };
  });
}

/** One scope of one repository (#765): every page from the cursor, then the cursor moved to the last updated_at stored. The first page's
 * ETag names the URL of the cursor the run started from, so it is kept only when the cursor stands still. */
export async function syncScope(deps: SyncDeps, repository: string, kind: ScopeKind): Promise<SyncReport> {
  const scope = scopeOf(deps.source, repository, kind);
  const saved = deps.db.cursor(scope);
  const from = saved?.cursor ?? null;
  let path: string | undefined = scopePath(repository, kind, from);
  let first = true;
  let firstEtag: string | null = null;
  let last = from;
  let report = EMPTY_REPORT;
  while (path !== undefined) {
    const answer = await deps.rest(path, first ? (saved?.etag ?? undefined) : undefined);
    const quota = answer.quota === undefined ? {} : { quota: answer.quota };
    if (answer.status === 304) return mergeReports(report, { changed: false, requests: { 200: 0, 304: 1 }, ...quota }); // cursor and ETag stand
    if (answer.status !== 200) throw new Error(`read model: the ${kind} of ${repository} answered HTTP ${answer.status}`);
    if (first) firstEtag = answer.etag ?? null;
    const page = storePage(deps, repository, kind, itemsOf(answer.body));
    const moved = page.last !== undefined && (last === null || page.last > last);
    last = page.last ?? last;
    report = mergeReports(report, { changed: moved, requests: { 200: 1, 304: 0 }, ...quota });
    path = page.blocked ? undefined : answer.next;
    first = false;
  }
  deps.db.setCursor(scope, { cursor: last, etag: last === from ? firstEtag : null, syncedAt: deps.now().toISOString() });
  return report;
}
