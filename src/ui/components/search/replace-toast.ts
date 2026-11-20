import { toast } from 'sonner';
import { formatCount, t, tPlural } from '@/i18n';
import { WriteCancelled } from '@/lib/api';
import { undoReplace } from '@/lib/search-replace';
import type { ReplaceAnswer } from '../../../types';

interface ShownOptions { file?: string; isAll?: boolean; onUndo(): void }

/** The notice of a replace: what changed, what was left out, and the undo as its action. */
export function showReplaced(answer: ReplaceAnswer, { file, isAll = false, onUndo }: ShownOptions): void {
  const total = answer.changed.reduce((n, c) => n + c.count, 0);
  const title = file === undefined ? tPlural('search.done.title', answer.changed.length, { n: formatCount(answer.changed.length) }) : t('search.done.file', { name: file });
  const leftOut = answer.skipped.filter((s) => s.reason !== 'failed');
  const failed = answer.skipped.filter((s) => s.reason === 'failed');
  const names = (list: typeof leftOut): string => list.map((s) => s.path).join(', ');
  const parts = [
    `${tPlural('search.occurrences', total, { n: formatCount(total) })}.`,
    ...(isAll ? [t('search.done.reloaded')] : []),
    ...(leftOut.length > 0 ? [t('search.done.skipped', { names: names(leftOut) })] : []),
    ...(failed.length > 0 ? [t('search.done.failed', { names: names(failed) })] : []),
  ];
  toast(title, { description: parts.join(' '), action: { label: t('search.undo'), onClick: onUndo } });
}

/** The undo of a replace: every file back to its previous text; a file that moved on disk since, or whose write failed, stays and is named. */
export async function undoWithNotice(activityId: string, answer: ReplaceAnswer): Promise<void> {
  try {
    const { skipped, failed } = await undoReplace(activityId, answer.changed);
    if (skipped.length > 0) toast(t('search.undoSkipped', { names: skipped.join(', ') }));
    if (failed.length > 0) toast.error(t('search.undoFailed', { names: failed.join(', ') }));
  } catch (error) {
    if (error instanceof WriteCancelled) return;
    toast.error(error instanceof Error ? error.message : String(error));
  }
}
