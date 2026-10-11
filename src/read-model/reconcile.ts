import { isDeepStrictEqual } from 'node:util';
import { apiRepository, commentFromRest, issueFromRest } from './normalize.js';
import type { CommentRow, IssueRow } from './rows.js';
import { EMPTY_REPORT, mergeReports, scopeOf, type SyncDeps, type SyncReport } from './sync.js';

// since never reports what was deleted or transferred (#765): these two reads are the only way a row leaves the read model

// Every item of a list, page after page; a full listing is never conditional, so no ETag
async function allItems(deps: SyncDeps, path: string): Promise<{ items: unknown[]; report: SyncReport }> {
  let next: string | undefined = path;
  let items: unknown[] = [];
  let report = EMPTY_REPORT;
  while (next !== undefined) {
    const answer = await deps.rest(next);
    if (answer.status !== 200) throw new Error(`read model: ${next} answered HTTP ${answer.status}`);
    if (!Array.isArray(answer.body)) throw new Error('read model: a list answered no array');
    items = [...items, ...answer.body];
    report = mergeReports(report, { changed: false, requests: { 200: 1, 304: 0 }, ...(answer.quota === undefined ? {} : { quota: answer.quota }) });
    next = answer.next;
  }
  return { items, report };
}

function nodeIdsOf(items: unknown[]): Set<string> {
  return new Set(items.map((item) => {
    const id = (item as { node_id?: unknown } | null)?.node_id;
    if (typeof id !== 'string') throw new Error('read model: unexpected node_id');
    return id;
  }));
}

/** The spaced full sync (#765): every id the repository still has, issues and PRs then comments; the stored rows not among them removed. */
export async function reconcile(deps: SyncDeps, repository: string): Promise<SyncReport> {
  const { db, source } = deps;
  const issues = await allItems(deps, `repos/${repository}/issues?state=all&per_page=100`);
  const comments = await allItems(deps, `repos/${repository}/issues/comments?per_page=100`);
  const keptIssues = nodeIdsOf(issues.items);
  const keptComments = nodeIdsOf(comments.items);
  const removed = db.transaction(() => {
    const goneIssues = db.nodeIds(source, repository, 'issues').filter((id) => !keptIssues.has(id));
    const goneComments = db.nodeIds(source, repository, 'comments').filter((id) => !keptComments.has(id));
    for (const id of goneIssues) db.removeIssue(source, id);
    for (const id of goneComments) db.removeComment(source, id);
    return goneIssues.length + goneComments.length;
  });
  db.setCursor(scopeOf(source, repository, 'reconcile'), { cursor: null, etag: null, syncedAt: deps.now().toISOString() });
  return { ...mergeReports(issues.report, comments.report), changed: removed > 0 };
}

interface IssueSnapshot { issue?: IssueRow; comments: CommentRow[] }

function snapshot(deps: SyncDeps, repository: string, number: number): IssueSnapshot {
  const issue = deps.db.issue(deps.source, repository, number);
  return issue === undefined ? { comments: [] } : { issue, comments: deps.db.comments(deps.source, issue.nodeId) };
}

// gh follows a transferred issue to its new repository: an answer from another one is a move. owner/name compares without case, as GitHub does
function movedFrom(body: unknown, repository: string): boolean {
  const url = (body as { repository_url?: unknown } | null)?.repository_url;
  return typeof url === 'string' && apiRepository(url).toLowerCase() !== repository.toLowerCase();
}

function removeStored(deps: SyncDeps, before: IssueSnapshot): boolean {
  if (before.issue === undefined) return false;
  deps.db.removeIssue(deps.source, before.issue.nodeId);
  return true;
}

/** Opening an issue's page (#765): it and all its comments read again; gone (301, 404, 410) or moved, it leaves the read model. Whether the
 * stored issue or its comments changed. */
export async function refetchIssue(deps: SyncDeps, repository: string, number: number): Promise<boolean> {
  const before = snapshot(deps, repository, number);
  const answer = await deps.rest(`repos/${repository}/issues/${number}`);
  if (answer.status === 304) return false;
  if (answer.status !== 200 || movedFrom(answer.body, repository)) return removeStored(deps, before);
  const issue = issueFromRest(deps.source, repository, answer.body);
  const { items } = await allItems(deps, `repos/${repository}/issues/${number}/comments?per_page=100`);
  const comments = items.flatMap((item) => commentFromRest(deps.source, repository, item, () => issue.nodeId) ?? []);
  const kept = new Set(comments.map((c) => c.nodeId));
  deps.db.transaction(() => {
    deps.db.upsertIssue(issue);
    for (const comment of comments) deps.db.upsertComment(comment);
    for (const old of before.comments) if (!kept.has(old.nodeId)) deps.db.removeComment(deps.source, old.nodeId);
  });
  return !isDeepStrictEqual(before, snapshot(deps, repository, number));
}
