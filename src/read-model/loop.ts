import type { SyncKind } from './db.js';
import { reconcile, stampReconcile } from './reconcile.js';
import { EMPTY_REPORT, mergeReports, syncScope, type SyncDeps, type SyncReport } from './sync.js';

export const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000; // the full listing's spacing (#180): every page of it is a 200, so once a day bounds its cost
export const REFETCH_COOLDOWN_MS = 10_000; // an issue page opened again within it reads the model, not GitHub

/** What a refetch did (#180): 2.2's issue page waits for it, so the caller needs the outcome. */
export type RefetchOutcome = 'changed' | 'unchanged' | 'gone' | 'failed' | 'skipped';

/** A repository's round: what it stored, and the error that ended it early, if one did. */
export interface RoundResult { report: SyncReport; error?: unknown }

/** The readModel frame of /events (#180): a named event as review's, so no State reader takes it for one; the kinds let a view reload only for its own. */
export const readModelEvent = (repository: string, kinds: SyncKind[]): string =>
  `event: readModel\ndata: ${JSON.stringify({ type: 'readModel', repository, kinds })}\n\n`;

// An absent or unreadable stamp is due: NaN fails the <=
function reconcileDue(deps: SyncDeps, repository: string): boolean {
  const at = deps.db.scope(deps.source, repository, 'reconcile')?.syncedAt;
  return !(deps.now().getTime() - Date.parse(at ?? '') <= RECONCILE_EVERY_MS);
}

/** One repository's round (#180): issues, then comments (whose issues the first scope stored), then the full listing when due. A first round
 * that read both scopes from null to their end already read everything: it counts as the listing. A scope that throws ends the round
 * there, keeping what the earlier one stored; its own place was never written. REST only: a round never calls GraphQL. */
export async function syncRepository(deps: SyncDeps, repository: string): Promise<RoundResult> {
  let report = EMPTY_REPORT;
  try {
    const issues = await syncScope(deps, repository, 'issues');
    report = mergeReports(report, issues);
    const comments = await syncScope(deps, repository, 'comments');
    report = mergeReports(report, comments);
    if (issues.full && comments.full) stampReconcile(deps, repository);
    else if (reconcileDue(deps, repository)) report = mergeReports(report, await reconcile(deps, repository));
    return { report };
  } catch (error) {
    return { report, error };
  }
}
