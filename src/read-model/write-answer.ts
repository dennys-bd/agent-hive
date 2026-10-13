import type { ReadModel, SyncKind } from './db.js';
import { rowStands } from './sync.js';
import type { CommentRow, IssueRow, ItemRow, PullFlags, ReviewRow } from './rows.js';

/** A write's confirmed answer as rows (#183, #187): what its mutation asked back, normalized; a PR write's review and flags too; a Project
 * field write's re-read item (#190). */
export interface WriteAnswer { issues?: IssueRow[]; comments?: CommentRow[]; reviews?: ReviewRow[]; pullFlags?: PullFlags[]; items?: ItemRow[] }

/** The model, and the readModel event the sync sends (#180): a write's rows reload every other open view of the repository. */
export interface WriteAnswerDeps { db: ReadModel; notify(repository: string, kinds: SyncKind[]): void }

/** Upserts a write's confirmed answer with origin 'write' in one transaction; notifies the kinds it changed. Returns them. The origin stamps
 * written_at, so a sync page read before the write cannot undo it inside #178's window. Shared by 4.3 and 5.2 (#100). */
export function applyWriteAnswer(deps: WriteAnswerDeps, repository: string, answer: WriteAnswer): SyncKind[] {
  const { db } = deps;
  const kinds = db.transaction((): SyncKind[] => {
    // #190: items name no SyncKind: the itemRead dispatch updates the board, and the next poll reads them back
    for (const row of answer.items ?? []) db.upsertItem(row, 'write');
    // map, then includes: every row is upserted, not only up to the first that writes
    const issues = (answer.issues ?? []).map((row) => db.upsertIssue(row, 'write'));
    const comments = (answer.comments ?? []).map((row) => db.upsertComment(row, 'write'));
    // a PR's flags follow its row (#187): one whose row the replace rule refused keeps the newer flags the stored row came with
    const wroteNode = new Map((answer.issues ?? []).map((row, i) => [row.nodeId, { row, wrote: issues[i] === true }]));
    const stands = (flags: PullFlags): boolean => {
      const entry = wroteNode.get(flags.nodeId);
      return entry === undefined || rowStands(db, flags.source, entry.row, entry.wrote);
    };
    const pulls = [...(answer.reviews ?? []).map((row) => db.upsertReview(row, 'write')), ...(answer.pullFlags ?? []).filter(stands).map((flags) => db.setPullFlags(flags))];
    return [
      ...(issues.includes(true) ? ['issues' as const] : []), ...(comments.includes(true) ? ['comments' as const] : []), ...(pulls.includes(true) ? ['pulls' as const] : []),
    ];
  });
  if (kinds.length > 0) deps.notify(repository, kinds);
  return kinds;
}
