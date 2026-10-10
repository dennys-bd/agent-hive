import { activityOf, prsOf } from '../../activities';
import { prNumber, prRepo } from '../../pull-requests';
import type { State, Task } from '../../types';
import { useOpenPr } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

// A wait-for-CI stage on the task (#834): what the card's footer and the status box say while it waits. The failure is taskError's.

type Work = Pick<State, 'activities' | 'activityRecords'>;

/** CI falhou when no re-run could be asked, CI aguarda mantenedor while workflows await approval (#854); else aguardando PR while the task has
 * no open PR, aguardando CI · done/total; undefined while it waits for nothing. */
export function ciProgress(task: Task, state: Work): string | undefined {
  const ci = activityOf(state, task.item.itemId)?.ci;
  if (ci === undefined) return undefined;
  if (ci.noRerun) return t('stageCi.noRerun');
  if (ci.awaiting !== undefined) return t('stageCi.awaiting');
  return ci.waitingPr ? t('stageCi.waitingPr') : t('stageCi.waiting', { n: ci.done ?? 0, total: ci.total ?? 0 });
}

/** ciProgress's tone on the card (#854): working while CI runs, muted while a maintainer must act, destructive with no re-run. */
export function ciTone(task: Task, state: Work): 'working' | 'destructive' | undefined {
  const ci = activityOf(state, task.item.itemId)?.ci;
  if (ci?.noRerun) return 'destructive';
  return ci?.awaiting === undefined ? 'working' : undefined;
}

/** The panel's notice under the status box (#854, handoff items 10, 11): who must act on a wait that waits for someone else. */
export function CiNotice({ task, state }: { task: Task; state: Work }) {
  const openPr = useOpenPr();
  const ci = activityOf(state, task.item.itemId)?.ci;
  if (ci?.noRerun) return <p role="status" className="rounded-lg border bg-background p-2.5 text-destructive text-xs">{t('stageCi.noRerunText')}</p>;
  if (ci?.awaiting === undefined) return null;
  const url = prsOf(state, task.item.itemId).find((pr) => pr.state === 'open')?.url;
  return (
    <section aria-label={t('stageCi.awaiting')} className="flex flex-col gap-2 rounded-lg border bg-background p-2.5 text-xs">
      <p className="flex items-center gap-1.5">
        <span aria-hidden="true" className="text-muted-foreground">◷</span>
        <span className="font-medium">{t('stageCi.awaiting')}</span>
      </p>
      {url !== undefined && (
        <>
          <p className="text-muted-foreground">{t('stageCi.awaitingText', { n: prNumber(url), repo: prRepo(url) })}</p>
          <div className="flex gap-1.5">
            <Button type="button" size="xs" variant="outline" onClick={() => openPr?.(url)}>{t('stageCi.openPr')}</Button>
          </div>
        </>
      )}
    </section>
  );
}
