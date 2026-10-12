import { isDeepStrictEqual } from 'node:util';
import { ISSUE_CLOSING_PRS } from '../repos/github-repo-queries.js';
import type { Gql, ProjectPr } from '../types.js';
import type { SyncKind } from './db.js';
import { closingPrsFromGql, commentFromRest, issueFromRest, WireError } from './normalize.js';
import type { CommentRow, IssueRow, IssueView } from './rows.js';
import { EMPTY_REPORT, mergeReports, type SyncDeps, type SyncReport } from './sync.js';

// since never reports what was deleted or transferred (#180): the full listing and the refetch are the only ways a row leaves the model

const API_REPOSITORY = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/;

/** What the refetch needs beyond a sync: the GraphQL of the same login, for the closing PRs REST does not carry. */
export interface RefetchDeps extends SyncDeps { gql: Gql }

/** What a refetch found (#180): the issue changed, stood, or is gone (301, 404, 410, or moved), the kinds whose stored rows changed, and why
 * the closing PRs could not be read, when they could not: the REST part stands without them. */
export interface RefetchResult { outcome: 'changed' | 'unchanged' | 'gone'; kinds: SyncKind[]; linksError?: string }

/** The reconcile scope's stamp: the full listing ran, or a first round read everything, at now. */
export function stampReconcile(deps: SyncDeps, repository: string): void {
  deps.db.setScope(deps.source, repository, 'reconcile', { cursor: null, etag: null, syncedAt: deps.now().toISOString() });
}

// Every item of a list, page after page. A full listing is never conditional, so no ETag; a Link outside the repository throws in the transport
async function allItems(deps: SyncDeps, path: string): Promise<{ items: unknown[]; report: SyncReport }> {
  let next: string | undefined = path;
  let items: unknown[] = [];
  let report = EMPTY_REPORT;
  while (next !== undefined) {
    const answer = await deps.rest(next);
    if (answer.status !== 200) throw new Error(`read model: ${next} answered HTTP ${answer.status}`);
    if (!Array.isArray(answer.body)) throw new Error('read model: a list answered no array');
    items = [...items, ...answer.body];
    report = mergeReports(report, { kinds: [], requests: { 200: 1, 304: 0 } });
    next = answer.next;
  }
  return { items, report };
}

function nodeIdsOf(items: unknown[]): Set<string> {
  return new Set(items.map((item) => {
    const id = (item as { node_id?: unknown } | null)?.node_id;
    if (typeof id !== 'string') throw new WireError('node_id');
    return id;
  }));
}

/** The spaced full listing (#180): every id the repository still has, issues and PRs then comments, both read before anything is removed. */
export async function reconcile(deps: SyncDeps, repository: string): Promise<SyncReport> {
  const { db, source } = deps;
  const issues = await allItems(deps, `repos/${repository}/issues?state=all&per_page=100`);
  const comments = await allItems(deps, `repos/${repository}/issues/comments?per_page=100`);
  const keptIssues = nodeIdsOf(issues.items);
  const keptComments = nodeIdsOf(comments.items);
  const kinds = db.transaction((): SyncKind[] => {
    const goneIssues = db.nodeIds(source, repository, 'issues').filter((id) => !keptIssues.has(id));
    const goneComments = db.nodeIds(source, repository, 'comments').filter((id) => !keptComments.has(id));
    for (const id of goneIssues) db.removeIssue(source, id);
    for (const id of goneComments) db.removeComment(source, id);
    return [...(goneIssues.length > 0 ? ['issues' as const] : []), ...(goneComments.length > 0 ? ['comments' as const] : [])];
  });
  stampReconcile(deps, repository);
  return { ...mergeReports(issues.report, comments.report), kinds };
}

interface Snapshot { issue: IssueView | undefined; comments: CommentRow[] }

function snapshot(deps: SyncDeps, repository: string, number: number): Snapshot {
  const issue = deps.db.issue(deps.source, repository, number);
  return { issue, comments: issue === undefined ? [] : deps.db.comments(deps.source, issue.nodeId) };
}

// The view carries the closing PRs: links that changed alone are a change of issues
function changedKinds(before: Snapshot, after: Snapshot): SyncKind[] {
  return [
    ...(isDeepStrictEqual(before.issue, after.issue) ? [] : ['issues' as const]),
    ...(isDeepStrictEqual(before.comments, after.comments) ? [] : ['comments' as const]),
  ];
}

// gh follows a transferred issue to its new repository: an answer from another one is a move. owner/name compares without case, as GitHub does
function movedFrom(body: unknown, repository: string): boolean {
  const url = (body as { repository_url?: unknown } | null)?.repository_url;
  const owner = typeof url === 'string' ? API_REPOSITORY.exec(url)?.[1] : undefined;
  if (owner === undefined) throw new WireError('repository_url');
  return owner.toLowerCase() !== repository.toLowerCase();
}

// By nodeIdOf, not the snapshot: a PR's row (no issue page) leaves the model too
function removeGone(deps: SyncDeps, repository: string, number: number, before: Snapshot): RefetchResult {
  const nodeId = deps.db.nodeIdOf(deps.source, repository, number);
  if (nodeId !== undefined) deps.db.removeIssue(deps.source, nodeId);
  return { outcome: 'gone', kinds: changedKinds(before, { issue: undefined, comments: [] }) };
}

// The issue's closing PRs (#180), or why they could not be read: GraphQL's failure never undoes what REST read
async function closingPrs(deps: RefetchDeps, repository: string, number: number): Promise<{ prs?: ProjectPr[]; error?: string }> {
  const [owner = '', name = ''] = repository.split('/');
  try {
    const data = await deps.gql(ISSUE_CLOSING_PRS, { owner, name, number });
    return { prs: closingPrsFromGql((data as { repository?: { issue?: unknown } | null } | null)?.repository?.issue) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// One transaction: the issue, its comments, the comments GitHub no longer lists, and the closing PRs when GraphQL answered them
function storeRefetch(deps: SyncDeps, before: Snapshot, issue: IssueRow, comments: CommentRow[], prs: ProjectPr[] | undefined): void {
  const { db, source } = deps;
  const kept = new Set(comments.map((c) => c.nodeId));
  db.transaction(() => {
    db.upsertIssue(issue, 'sync');
    for (const comment of comments) db.upsertComment(comment, 'sync');
    for (const old of before.comments) if (!kept.has(old.nodeId)) db.removeComment(source, old.nodeId);
    if (prs !== undefined) db.setClosingPrs(source, issue.nodeId, prs);
  });
}

/** Opening an issue's page (#180): it and all its comments read again over REST, then its closing PRs over GraphQL; gone (301, 404, 410) or
 * moved, it leaves the read model. A REST failure throws; a GraphQL one comes back as linksError. */
export async function refetchIssue(deps: RefetchDeps, repository: string, number: number): Promise<RefetchResult> {
  const before = snapshot(deps, repository, number);
  const answer = await deps.rest(`repos/${repository}/issues/${number}`);
  if (answer.status === 304) return { outcome: 'unchanged', kinds: [] }; // no ETag is sent, yet the type allows it: never taken for gone
  if (answer.status !== 200 || movedFrom(answer.body, repository)) return removeGone(deps, repository, number, before);
  const issue = issueFromRest(deps.source, repository, answer.body);
  const { items } = await allItems(deps, `repos/${repository}/issues/${number}/comments?per_page=100`);
  const comments = items.flatMap((item) => commentFromRest(deps.source, repository, item, () => issue.nodeId) ?? []);
  const links = issue.kind === 'issue' ? await closingPrs(deps, repository, number) : {}; // a PR closes nothing
  storeRefetch(deps, before, issue, comments, links.prs);
  const kinds = changedKinds(before, snapshot(deps, repository, number));
  return { outcome: kinds.length > 0 ? 'changed' : 'unchanged', kinds, ...(links.error === undefined ? {} : { linksError: links.error }) };
}
