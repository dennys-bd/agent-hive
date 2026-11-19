import type { ReactNode } from 'react';
import { activityOf } from '../../activities.js';
import type { TaskTimeline, TimelineEvent } from '../../server-timeline.js';
import { liveRuns } from '../../task-runs.js';
import type { Checkpoint, State, Task } from '../../types.js';
import { DetailSection, SUMMARY_LINE } from '@/components/DetailSection';
import { STATUS_WORD, statusWord } from '@/components/DetailSections';
import { Button } from '@/components/ui/button';
import { type TimelineRead, useTimeline } from '@/hooks/use-timeline';
import { t } from '@/i18n';
import { taskState } from '@/lib/task-state';
import { eventText, groupByDay, matchCheckpoints, shortDate, summaryText, type StageEvent, type TextPart, workedOf, workedText } from '@/lib/timeline';
import { clock, compact } from '@/lib/usage';

type TimelineState = Pick<State, 'workers' | 'terminals' | 'activities' | 'activityRecords'> & Partial<Pick<State, 'stages' | 'semaphores'>>;
interface TimelineSectionProps { task: Task; state: TimelineState; locale: string }

const SKELETON_WIDTHS = ['70%', '90%', '55%', '80%']; // the drawing's four bars
const BAR = 'min-w-0.5 rounded-[2px]';
// The drawing's .tdp-tl-ev: the time in a 34px column, the text beside it
const ROW = 'grid grid-cols-[34px_minmax(0,1fr)] items-baseline gap-2 text-muted-foreground tabular-nums';

const shown = (parts: readonly TextPart[]): ReactNode[] =>
  parts.map((part) => (typeof part === 'string' ? part : <b key={part.bold} className="font-medium text-foreground">{part.bold}</b>));

function Summary({ read, locale }: { read: TimelineRead; locale: string }) {
  if (read.kind === 'loading') return <span className={SUMMARY_LINE}>{t('timeline.loading')}</span>;
  // the colour on an inner span: a second colour class beside SUMMARY_LINE's muted one would depend on the stylesheet's order
  if (read.kind === 'error') return <span className={SUMMARY_LINE}><span className="text-destructive">{t('timeline.failed')}</span></span>;
  return <span className={SUMMARY_LINE}>{summaryText(read.timeline, locale)}</span>;
}

function Skeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2">
      <span className="sr-only">{t('timeline.loading')}</span>
      {SKELETON_WIDTHS.map((width) => <span key={width} className="h-2.5 rounded-[3px] bg-muted" style={{ width }} />)}
    </div>
  );
}

function Failed({ onRetry }: { onRetry(): void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-1.5">
      <span className="text-destructive">{t('timeline.failed')}</span>
      <Button type="button" variant="outline" size="xs" onClick={onRetry}>{t('timeline.retry')}</Button>
    </div>
  );
}

// Worked then waited in the status colours that mean them; aria-hidden, since the line under it says the same
function StageSplit({ event }: { event: StageEvent }) {
  const worked = workedOf(event);
  return (
    <>
      <span aria-hidden="true" data-slot="timeline-split" className="flex h-1 gap-0.5">
        <span className={`${BAR} bg-working`} style={{ flexGrow: worked }} />
        {event.waitedMs > 0 && <span className={`${BAR} bg-waiting`} style={{ flexGrow: event.waitedMs }} />}
      </span>
      <span>{workedText(worked, event.waitedMs)}</span>
    </>
  );
}

function EventRow({ event, n, locale }: { event: TimelineEvent; n: number | undefined; locale: string }) {
  return (
    <div className={ROW}>
      <time dateTime={event.ts}>{clock(event.ts, locale)}</time>
      <div className="flex min-w-0 flex-col gap-1">
        <span>{shown(eventText(event, n))}</span>
        {event.kind === 'stage' && <StageSplit event={event} />}
      </div>
    </div>
  );
}

// The task's state as the status box words it, then how long since the last event; refreshed by each broadcast, no timer of its own.
// With no event there is no since: the state alone, as a task the store never saw still has one
function LiveLine({ task, state, lastTs }: { task: Task; state: TimelineState; lastTs: string | undefined }) {
  const now = Date.now();
  const ago = lastTs === undefined ? [] : [t('detail.ago', { time: compact(Math.max(0, now - Date.parse(lastTs))) })];
  return (
    <div className={ROW}>
      <span />
      <span className={STATUS_WORD[taskState(task, state)]}>{[statusWord(task, state, now), ...ago].join(' · ')}</span>
    </div>
  );
}

interface ListProps { timeline: TaskTimeline; checkpoints: readonly Checkpoint[]; task: Task; state: TimelineState; locale: string }

function TimelineList({ timeline, checkpoints, task, state, locale }: ListProps) {
  const matched = matchCheckpoints(timeline.events, checkpoints);
  return (
    <div className="flex flex-col gap-3">
      {timeline.since !== undefined && (
        <p className="rounded-md border border-dashed px-2 py-1.5 leading-4 text-muted-foreground">{t('timeline.sinceNote', { date: shortDate(timeline.since, locale) })}</p>
      )}
      {groupByDay(timeline.events, Date.now(), locale).map((day) => (
        <section key={day.key} aria-label={day.label} className="flex flex-col gap-2">
          <h4 className="font-medium text-foreground">{day.label}</h4>
          {day.rows.map(({ index, event }) => <EventRow key={index} event={event} n={matched.get(index)} locale={locale} />)}
        </section>
      ))}
      <LiveLine task={task} state={state} lastTs={timeline.events.at(-1)?.ts} />
    </div>
  );
}

/** linha do tempo (#961): the task's timeline from usage.sqlite, a details section closed by default after pontos de restauração. It reads on
 * mount, so the closed summary has its totals, then only when the run key moves (the stage, the checkpoint count, a live run or none): a stage
 * run's end moves one of them, so the list follows without a read per broadcast. */
export function TimelineSection({ task, state, locale }: TimelineSectionProps) {
  const checkpoints = activityOf(state, task.item.itemId)?.checkpoints ?? [];
  const runKey = [task.stage, checkpoints.length, liveRuns(task, state).length > 0].join(':');
  const { read, retry } = useTimeline(task.item.itemId, runKey);
  return (
    <DetailSection name={t('timeline.title')} summary={<Summary read={read} locale={locale} />}>
      {read.kind === 'loading' && <Skeleton />}
      {read.kind === 'error' && <Failed onRetry={retry} />}
      {read.kind === 'list' && <TimelineList timeline={read.timeline} checkpoints={checkpoints} task={task} state={state} locale={locale} />}
    </DetailSection>
  );
}
