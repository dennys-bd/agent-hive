import { useState } from 'react';
import { activityOf } from '../../activities';
import { liveRuns } from '../../task-runs';
import { SHORT_SHA } from '../../tasks';
import type { Checkpoint, CheckpointEnd, Stage, State, Task } from '../../types';
import { RestoreDialog } from '@/components/RestoreDialog';
import { useOpenDiff } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { type MessageKey, t } from '@/i18n';
import { compact } from '@/lib/usage';

const MUTED = 'text-muted-foreground';
const ENDED_KEY: Record<CheckpointEnd, MessageKey> = { done: 'checkpoints.ended.done', restart: 'checkpoints.ended.restart', restore: 'checkpoints.ended.restore' };

/** The checkpoints by stage (#619), in column order; a stage no column holds any more comes after them, in capture order. */
export function checkpointGroups(checkpoints: readonly Checkpoint[], stages: readonly Pick<Stage, 'name'>[]): [string, Checkpoint[]][] {
  const names = new Set([...stages.map((s) => s.name), ...checkpoints.map((a) => a.stage)]);
  return [...names].flatMap((name): [string, Checkpoint[]][] => {
    const own = checkpoints.filter((a) => a.stage === name);
    return own.length === 0 ? [] : [[name, own]];
  });
}

// `checkpoint <n> · <age> · <short sha> · <how it ended>` (#619): refreshed by each state broadcast, no timer of its own
const rowText = (checkpoint: Checkpoint, now: number): string => [
  t('checkpoints.row', { n: checkpoint.n }), t('detail.ago', { time: compact(Math.max(0, now - Date.parse(checkpoint.at))) }),
  checkpoint.commit.slice(0, SHORT_SHA), t(ENDED_KEY[checkpoint.ended]),
].join(' · ');

type CheckpointsState = Pick<State, 'stages' | 'workers' | 'terminals' | 'activities' | 'activityRecords'>;

/** The task's checkpoints (#619), the detail panel's section after the sessions; hidden without one. compare opens the diff on the checkpoint scope;
 * restore… opens its dialog, disabled while a run is live on the task, which the route would refuse. */
export function CheckpointsList({ task, state }: { task: Task; state: CheckpointsState }) {
  const openDiff = useOpenDiff();
  const [restoring, setRestoring] = useState<Checkpoint>();
  const activity = activityOf(state, task.item.itemId);
  const checkpoints = activity?.checkpoints ?? [];
  if (!activity || checkpoints.length === 0) return null;
  const busy = liveRuns(task, state).length > 0;
  const now = Date.now();
  return (
    <section aria-label={t('checkpoints.title')} className="flex flex-col gap-1.5 text-xs">
      <h3 className={MUTED}>{t('checkpoints.title')}</h3>
      {checkpointGroups(checkpoints, state.stages).map(([stage, own]) => (
        <div key={stage} className="flex flex-col gap-1">
          <h4 className="font-medium">{stage}</h4>
          <ul className="flex flex-col gap-1">
            {own.map((a) => (
              <li key={a.n} className="flex items-baseline gap-2">
                <span className={`min-w-0 flex-1 truncate ${MUTED}`}>{rowText(a, now)}</span>
                <Button type="button" variant="link" size="xs" className={`h-auto p-0 ${MUTED}`} onClick={() => openDiff?.(task, 'checkpoint', a.n)}>{t('checkpoints.compare')}</Button>
                <span title={busy ? t('checkpoints.busy') : undefined}>
                  <Button type="button" variant="link" size="xs" className={`h-auto p-0 ${MUTED}`} disabled={busy} onClick={() => setRestoring(a)}>{t('checkpoints.restore')}</Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {restoring && <RestoreDialog task={task} activityId={activity.id} checkpoint={restoring} onClose={() => setRestoring(undefined)} />}
    </section>
  );
}
