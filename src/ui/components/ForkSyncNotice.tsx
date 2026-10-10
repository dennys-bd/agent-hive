import { TriangleAlertIcon } from 'lucide-react';
import { activityOf } from '../../activities';
import type { Activity, ForkSyncResult, State, Task } from '../../types';
import { t } from '@/i18n';
import { relativeTime } from '@/lib/home';

type Work = Pick<State, 'activities' | 'activityRecords'>;

/** The activity's automatic sync when it failed (#854): what the card's line, the panel's block and the base row show; none after one that worked. */
export const failedSync = (activity: Pick<Activity, 'sync'> | undefined): ForkSyncResult | undefined =>
  activity?.sync !== undefined && activity.sync.result !== 'synced' && activity.sync.result !== 'current' ? activity.sync : undefined;

const hhmm = (iso: string): string => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
};

// Why it failed, one line per case (handoff item 7)
function reasonOf(sync: ForkSyncResult): string {
  if (sync.result === 'diverged') return t('fork.sync.diverged', { base: sync.base, n: sync.commits ?? 0 });
  if (sync.result === 'conflict') {
    const files = sync.files ?? [];
    return files.length === 1 ? t('fork.sync.conflict', { base: sync.base, file: files[0] }) : t('fork.sync.conflictN', { base: sync.base, n: files.length });
  }
  return sync.result === 'offline' ? t('fork.sync.offline') : (sync.reason ?? '');
}

/** The card's line (#854): not a blocker, the task keeps its status. */
export function SyncLine({ task, state }: { task: Task; state: Work }) {
  if (failedSync(activityOf(state, task.item.itemId)) === undefined) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      <TriangleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{t('fork.sync.line')}</span>
    </div>
  );
}

/** The panel's block under the status box (#854): why, what the worktree started from, its sha and when; it stays while the activity lives. */
export function SyncBlock({ task, state }: { task: Task; state: Work }) {
  const sync = failedSync(activityOf(state, task.item.itemId));
  if (sync === undefined) return null;
  return (
    <section aria-label={t('fork.sync.failed')} className="flex flex-col gap-1.5 rounded-lg border bg-background p-2.5 text-xs leading-[18px]">
      <p className="flex items-center gap-1.5">
        <span aria-hidden="true" className="text-muted-foreground">⚠</span>
        <span className="font-medium">{t('fork.sync.failed')}</span>
        <span className="ml-auto text-muted-foreground">{t('fork.sync.before', { time: hhmm(sync.at) })}</span>
      </p>
      <p className="text-muted-foreground">{reasonOf(sync)}</p>
      <p>{t('fork.sync.asItWas')}</p>
      <p className="font-mono text-muted-foreground">{[sync.base, sync.sha, relativeTime(sync.at)].filter((part) => part !== '').join(' · ')}</p>
    </section>
  );
}

/** The panel's base row (#854): the fork's base, and sem sync after a failed sync. */
export const baseText = (sync: ForkSyncResult): string => (failedSync({ sync }) === undefined ? sync.base : `${sync.base} · ${t('fork.sync.noSync')}`);
