// The timeline section's pure parts (#961): its totals and summary, its days, the checkpoint of each stage row and the words of each event.
// No React: the section renders these, the read lives in hooks/use-timeline.ts.
import type { MoveBy, StageOutcome } from '../../facts.js';
import type { TaskTimeline, TimelineEvent } from '../../server-timeline.js';
import type { Checkpoint } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';
import { compact } from './usage.js';

export type StageEvent = Extract<TimelineEvent, { kind: 'stage' }>;
/** A run of text, or a name the row draws bold (the drawing's <b>: a stage, a column, a PR number). */
export type TextPart = string | { bold: string };
export interface TimelineDay { key: string; label: string; rows: { index: number; event: TimelineEvent }[] }
type CheckpointAt = Pick<Checkpoint, 'n' | 'stage' | 'at'>;

// The capture lands just after stage.ended (spec, checkpoint of a stage row)
const CHECKPOINT_SLACK_MS = 5_000;
const OUTCOME_KEY: Record<StageOutcome, MessageKey> = {
  done: 'timeline.outcome.done', approval: 'timeline.outcome.approval', stop: 'timeline.outcome.stop', agent_stop: 'timeline.outcome.agent_stop',
  killed: 'timeline.outcome.killed', failed: 'timeline.outcome.failed', exit: 'timeline.outcome.exit',
};
const BY_KEY: Record<MoveBy, MessageKey> = {
  hand: 'timeline.by.hand', auto: 'timeline.by.auto', on_finish: 'timeline.by.auto', source: 'timeline.by.source',
  merge: 'timeline.by.merge', approval: 'timeline.by.approval', epic: 'timeline.by.epic',
};
const APPROVAL_KEY: Record<'granted' | 'rejected' | 'expired', MessageKey> = {
  granted: 'timeline.approval.granted', rejected: 'timeline.approval.rejected', expired: 'timeline.approval.expired',
};

// outcome and by reach the UI unchecked (#960): a value this build does not word shows as it is
const known = <K extends string>(keys: Readonly<Record<K, MessageKey>>, value: string): string =>
  (Object.hasOwn(keys, value) ? t(keys[value as K]) : value);

export const workedOf = (event: StageEvent): number => Math.max(0, event.durationMs - event.waitedMs);

/** The worked and waited sums over the stage events, the summary's totals: they match the list, a cut start included. */
export function timelineTotals(events: readonly TimelineEvent[]): { workedMs: number; waitedMs: number } {
  return events.reduce(
    (sum, event) => (event.kind !== 'stage' ? sum : { workedMs: sum.workedMs + workedOf(event), waitedMs: sum.waitedMs + event.waitedMs }),
    { workedMs: 0, waitedMs: 0 },
  );
}

/** A stage row's second line: `trabalhou X`, then `esperou você Y` only when the run waited. */
export const workedText = (workedMs: number, waitedMs: number): string =>
  [t('timeline.worked', { time: compact(workedMs) }), ...(waitedMs > 0 ? [t('timeline.waited', { time: compact(waitedMs) })] : [])].join(' · ');

/** `28 set` / `Sep 28`: the locale's own order of day and short month, without its dot or pt's `de`. */
export function shortDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).formatToParts(new Date(iso))
    .filter((part) => part.type === 'day' || part.type === 'month').map((part) => part.value.replace('.', '')).join(' ');
}

/** The closed line: `desde <date> · ` when the store's history is cut, then both sums; nada registrado ainda for a task the store never saw. */
export function summaryText({ since, events }: TaskTimeline, locale: string): string {
  if (since === undefined && events.length === 0) return t('timeline.empty');
  const { workedMs, waitedMs } = timelineTotals(events);
  const lead = since === undefined ? [] : [t('timeline.since', { date: shortDate(since, locale) })];
  return [...lead, t('timeline.worked', { time: compact(workedMs) }), t('timeline.waited', { time: compact(waitedMs) })].join(' · ');
}

const dayKey = (time: number): string => new Date(time).toDateString(); // the local calendar day
function dayBefore(now: number): number {
  const day = new Date(now);
  day.setDate(day.getDate() - 1); // a fresh Date: setDate keeps a DST day's 23 or 25 hours right
  return day.getTime();
}
function dayLabel(key: string, ts: string, now: number, locale: string): string {
  if (key === dayKey(now)) return t('timeline.today');
  if (key === dayKey(dayBefore(now))) return t('timeline.yesterday');
  return shortDate(ts, locale);
}

/** The events by local day, in the route's order (oldest first); each row keeps its index for the checkpoint map. */
export function groupByDay(events: readonly TimelineEvent[], now: number, locale: string): TimelineDay[] {
  const days: TimelineDay[] = [];
  events.forEach((event, index) => {
    const key = dayKey(Date.parse(event.ts));
    const last = days.at(-1);
    if (last?.key === key) last.rows.push({ index, event });
    else days.push({ key, label: dayLabel(key, event.ts, now, locale), rows: [{ index, event }] });
  });
  return days;
}

// The nearest free checkpoint of the row's stage captured inside its run: the window keeps one off another run of the same stage
function nearest(event: StageEvent, checkpoints: readonly CheckpointAt[], taken: ReadonlySet<number>): number | undefined {
  const end = Date.parse(event.ts);
  const gap = (c: CheckpointAt): number => Math.abs(Date.parse(c.at) - end);
  return checkpoints
    .filter((c) => c.stage === event.stage && !taken.has(c.n) && Date.parse(c.at) >= end - event.durationMs && Date.parse(c.at) <= end + CHECKPOINT_SLACK_MS)
    .reduce<CheckpointAt | undefined>((best, c) => (best === undefined || gap(c) < gap(best) ? c : best), undefined)?.n;
}

/** Each stage row's checkpoint n, by the row's index. Rows choose oldest first and a chosen one is taken, so none shows on two rows. */
export function matchCheckpoints(events: readonly TimelineEvent[], checkpoints: readonly CheckpointAt[]): ReadonlyMap<number, number> {
  const found = new Map<number, number>();
  const taken = new Set<number>();
  events.forEach((event, index) => {
    if (event.kind !== 'stage' || event.stage === undefined) return;
    const n = nearest(event, checkpoints, taken);
    if (n === undefined) return;
    found.set(index, n);
    taken.add(n);
  });
  return found;
}

// A row's segments joined by ` · `, an empty one dropped: a missing stage, outcome, by or checkpoint takes its part with it
const line = (...segments: readonly (readonly TextPart[])[]): TextPart[] =>
  segments.filter((segment) => segment.length > 0).flatMap((segment, i) => (i === 0 ? [...segment] : [' · ', ...segment]));
const named = (stage: string | undefined): TextPart[] => (stage === undefined ? [] : [{ bold: stage }]);

function stageText(event: StageEvent, n: number | undefined): TextPart[] {
  const outcome = event.outcome === undefined ? [] : [known(OUTCOME_KEY, event.outcome)];
  const head = event.stage === undefined || outcome.length === 0 ? [...named(event.stage), ...outcome] : [...named(event.stage), ' ', ...outcome];
  return line(head, [compact(event.durationMs)], n === undefined ? [] : [t('checkpoints.row', { n })]);
}

/** The words of an event as the drawing writes them (#961), the decomposition's wording of each value; n is a stage row's checkpoint. */
export function eventText(event: TimelineEvent, n?: number): TextPart[] {
  switch (event.kind) {
    case 'stage': return stageText(event, n);
    case 'question':
      return line([t('timeline.question')], [event.answered ? t('timeline.answeredIn', { time: compact(event.durationMs) }) : t('timeline.unanswered')]);
    case 'restart':
      return line([...named(event.stage), ...(event.stage === undefined ? [] : [' ']), t('timeline.restarted')], [t('timeline.stoppedFor', { time: compact(event.durationMs) })]);
    case 'approval':
      return line([t(APPROVAL_KEY[event.result])], [t('timeline.after', { time: compact(event.durationMs) })], event.start === true ? [t('timeline.startedNow')] : []);
    case 'move': return line([t('timeline.movedTo'), ' ', { bold: event.to }], event.by === undefined ? [] : [known(BY_KEY, event.by)]);
    case 'pr': return [t('timeline.pr'), ' ', { bold: `#${event.pr}` }];
  }
}
