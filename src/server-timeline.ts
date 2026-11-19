import type { MoveBy, StageOutcome } from './facts.js';

export type TimelineEvent =
  | { kind: 'stage'; ts: string; stage?: string; attempt: number; outcome?: StageOutcome; durationMs: number; waitedMs: number }
  | { kind: 'question'; ts: string; durationMs: number; answered: boolean }
  | { kind: 'restart'; ts: string; stage?: string; durationMs: number }
  | { kind: 'approval'; ts: string; result: 'granted' | 'rejected' | 'expired'; durationMs: number; start?: boolean }
  | { kind: 'move'; ts: string; to: string; by?: MoveBy }
  | { kind: 'pr'; ts: string; pr: number };
export interface TaskTimeline { since?: string; events: TimelineEvent[] }

type Fields = Readonly<Record<string, unknown>>;
type Mapper = (record: Fields, ts: string) => TimelineEvent | undefined;

// An imported old generation may lack a field: a number becomes 0, so the timeline stays whole and an old stage shows 0 waited
const numberOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// outcome and by pass through unchecked: the UI words the values it knows, and an unknown one as it can (spec, closed decisions)
const stageOf: Mapper = (r, ts) => ({
  kind: 'stage', ts, stage: textOf(r.stage), attempt: numberOf(r.attempt), outcome: textOf(r.outcome) as StageOutcome | undefined,
  durationMs: numberOf(r.duration_ms), waitedMs: numberOf(r.waited_ms),
});
const questionOf: Mapper = (r, ts) => ({ kind: 'question', ts, durationMs: numberOf(r.duration_ms), answered: r.outcome === 'answered' });
const restartOf: Mapper = (r, ts) => ({ kind: 'restart', ts, stage: textOf(r.stage), durationMs: numberOf(r.duration_ms) });
// start only on a rejection; its text's length and hash are never copied
const approvalOf = (result: 'granted' | 'rejected' | 'expired'): Mapper => (r, ts) => ({
  kind: 'approval', ts, result, durationMs: numberOf(r.duration_ms), ...(result === 'rejected' ? { start: r.start === true } : {}),
});
const moveOf: Mapper = (r, ts) => {
  const to = textOf(r.to);
  return to === undefined ? undefined : { kind: 'move', ts, to, by: textOf(r.by) as MoveBy | undefined };
};
const prOf: Mapper = (r, ts) => (typeof r.pr === 'number' ? { kind: 'pr', ts, pr: r.pr } : undefined);

// A Map, not an object: an event named after an Object.prototype key finds no mapper
const MAPPERS: ReadonlyMap<string, Mapper> = new Map<string, Mapper>([
  ['stage.ended', stageOf], ['question.answered', questionOf], ['run.restarted', restartOf],
  ['approval.granted', approvalOf('granted')], ['approval.rejected', approvalOf('rejected')], ['approval.expired', approvalOf('expired')],
  ['task.moved', moveOf], ['pr.opened', prOf],
]);

/** The store's records, already in ts order, as the timeline (#960). since: the oldest dated record's ts, only when no task.discovered is among
 * them (the task started before the store's history); task.discovered itself is never an event. */
export function timelineOf(records: readonly Fields[]): TaskTimeline {
  const dated = records.flatMap((record) => (typeof record.ts === 'string' ? [{ record, ts: record.ts }] : []));
  const events = dated.flatMap(({ record, ts }): TimelineEvent[] => {
    const event = MAPPERS.get(String(record.event))?.(record, ts);
    return event === undefined ? [] : [event];
  });
  const since = dated.at(0)?.ts;
  return since === undefined || dated.some(({ record }) => record.event === 'task.discovered') ? { events } : { since, events };
}
