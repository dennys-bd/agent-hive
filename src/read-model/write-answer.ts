import type { ReadModel, SyncKind } from './db.js';
import type { CommentRow, IssueRow } from './rows.js';

/** A write's confirmed answer as rows (#183): what its mutation asked back, normalized. */
export interface WriteAnswer { issues?: IssueRow[]; comments?: CommentRow[] }

/** The model, and the readModel event the sync sends (#180): a write's rows reload every other open view of the repository. */
export interface WriteAnswerDeps { db: ReadModel; notify(repository: string, kinds: SyncKind[]): void }

/** Upserts a write's confirmed answer with origin 'write' in one transaction; notifies the kinds it changed. Returns them. The origin stamps
 * written_at, so a sync page read before the write cannot undo it inside #178's window. Shared by 4.3 and 5.2 (#100). */
export function applyWriteAnswer(deps: WriteAnswerDeps, repository: string, answer: WriteAnswer): SyncKind[] {
  const { db } = deps;
  const kinds = db.transaction((): SyncKind[] => {
    // map, then includes: every row is upserted, not only up to the first that writes
    const issues = (answer.issues ?? []).map((row) => db.upsertIssue(row, 'write'));
    const comments = (answer.comments ?? []).map((row) => db.upsertComment(row, 'write'));
    return [...(issues.includes(true) ? ['issues' as const] : []), ...(comments.includes(true) ? ['comments' as const] : [])];
  });
  if (kinds.length > 0) deps.notify(repository, kinds);
  return kinds;
}
