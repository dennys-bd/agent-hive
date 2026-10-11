import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { prsOf, taskOfPr } from '../../activities';
import { prGroups, prRepo } from '../../pull-requests';
import type { PrReviewDecision, PrRow, State, Task } from '../../types';
import { Spinner } from '@/components/ui/spinner';
import { type MessageKey, t } from '@/i18n';
import { relativeTime } from '@/lib/home';

const MUTED = 'text-muted-foreground';
const DASH = <span className={MUTED}>—</span>;
// awaiting: a workflow waits for a maintainer, not the user, so it is muted (#854)
const CHECK: Record<NonNullable<PrRow['checks']>, { mark: ReactNode; tone: string }> = {
  success: { mark: '✓', tone: 'text-working' }, failure: { mark: '✕', tone: 'text-destructive' }, pending: { mark: <Spinner />, tone: 'text-waiting' },
  awaiting: { mark: '◷', tone: MUTED },
};
const REVIEW: Record<PrReviewDecision, { key: MessageKey; tone: string }> = {
  approved: { key: 'prs.review.approved', tone: 'text-working' }, changes: { key: 'prs.review.changes', tone: 'text-waiting' }, pending: { key: 'prs.review.pending', tone: MUTED },
};

/** The merge cell's value (#758): `none` is the empty cell. */
export type MergeCell = 'draft' | 'conflict' | 'failing' | 'review' | 'ready' | 'none';

/** What the merge cell says (#758, handoff 03), the first that holds: a draft —; conflicts; failing checks; not approved, awaiting review;
 * ready while GitHub says it merges clean or with hooks; anything else (blocked, behind, unknown) empty. The list never reads again to resolve
 * an unknown: GitHub computes it lazily and the PR's page reads it again. */
export function mergeCell(row: Pick<PrRow, 'isDraft' | 'mergeState' | 'checks' | 'decision'>): MergeCell {
  if (row.isDraft) return 'draft';
  if (row.mergeState === 'conflicts') return 'conflict';
  if (row.checks === 'failure' || row.mergeState === 'unstable') return 'failing';
  if (row.decision !== 'approved') return 'review';
  return row.mergeState === 'clean' || row.mergeState === 'hooks' ? 'ready' : 'none';
}

const MERGE: Record<Exclude<MergeCell, 'draft' | 'none'>, { key: MessageKey; tone: string }> = {
  ready: { key: 'prs.merge.ready', tone: 'text-working' }, conflict: { key: 'prs.merge.conflict', tone: 'text-destructive' },
  failing: { key: 'prs.merge.failing', tone: 'text-destructive' }, review: { key: 'prs.merge.review', tone: MUTED },
};

// A PR's k/n in its task's stack in its repository (#698), from the records; undefined out of a stack
function stackOf(state: State, task: Task | undefined, url: string): string | undefined {
  if (task === undefined) return undefined;
  const line = prGroups(prsOf(state, task.item.itemId), prRepo(url)).flatMap((group) => group.lines).find((l) => l.pr.url === url);
  return line?.position === undefined ? undefined : `${line.position.k}/${line.position.total}`;
}

// open in review blue, a draft muted; merged and closed muted in their own segments
function StateCell({ row }: { row: PrRow }) {
  if (row.state !== 'open') return <span className={MUTED}>{t(`prs.state.${row.state}`)}</span>;
  return row.isDraft ? <span className={MUTED}>{t('prs.state.draft')}</span> : <span className="text-review">{t('prs.state.open')}</span>;
}

function ReviewCell({ row }: { row: PrRow }) {
  if (row.isDraft) return DASH;
  return row.decision === undefined ? null : <span className={REVIEW[row.decision].tone}>{t(REVIEW[row.decision].key)}</span>;
}

function MergeView({ row, canPush }: { row: PrRow; canPush: boolean }) {
  const cell = mergeCell(row);
  if (cell === 'draft') return DASH;
  if (!canPush && row.state === 'open') return <span className={MUTED}>{t('prs.merge.noPermission')}</span>; // #854: the merge is a maintainer's
  return cell === 'none' ? null : <span className={MERGE[cell].tone}>{t(MERGE[cell].key)}</span>;
}

export interface RepoPrRowProps { row: PrRow; columns: string; state: State; canPush?: boolean; onOpen?(row: PrRow): void }

/** One PR of a repository's list (#758, handoff 03): its number and title, state, checks, review, merge, k/n in its task's stack, its task's
 * number and when it last changed. A click or ↵ opens its page; ⇧↵ opens it on GitHub. */
export function RepoPrRow({ row, columns, state, canPush, onOpen }: RepoPrRowProps) {
  const task = taskOfPr(state, row.url);
  const check = row.checks === undefined ? undefined : CHECK[row.checks];
  // a click on a cell's own control is not the row's
  const onClick = (e: MouseEvent<HTMLTableRowElement>): void => {
    const target = e.target as Element;
    if (e.currentTarget.contains(target) && !target.closest('button, a')) onOpen?.(row);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>): void => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
    e.preventDefault();
    if (e.shiftKey) window.open(row.url, '_blank', 'noreferrer');
    else onOpen?.(row);
  };
  return (
    <tr
      tabIndex={0} onClick={onClick} onKeyDown={onKeyDown} style={{ gridTemplateColumns: columns }}
      className="grid h-10 cursor-pointer items-center gap-3 border-b px-3 text-[13px] outline-none hover:bg-muted focus:bg-muted"
    >
      <td className="flex min-w-0 items-center gap-1.5"><span className="shrink-0 font-medium">#{row.number}</span><span className="min-w-0 truncate">{row.title}</span></td>
      <td className="truncate text-xs"><StateCell row={row} /></td>
      <td className="text-xs">{check && <span className={check.tone}>{check.mark}</span>}</td>
      <td className="truncate text-xs"><ReviewCell row={row} /></td>
      <td className="truncate text-xs"><MergeView row={row} canPush={canPush !== false} /></td>
      <td className="text-xs"><span className="tabular-nums">{stackOf(state, task, row.url)}</span></td>
      <td className="text-xs">{task ? <span className="text-foreground">#{task.item.id}</span> : DASH}</td>
      <td className="truncate text-muted-foreground text-xs">{relativeTime(row.updatedAt)}</td>
    </tr>
  );
}
