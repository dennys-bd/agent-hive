import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineOf } from '../src/server-timeline.js';

const TS = (minute: number): string => `2026-11-19T12:${String(minute).padStart(2, '0')}:00.000Z`;
// A record as usage.sqlite's data holds it: an imported old generation is not typed, so neither is this
const rec = (event: string, minute: number, fields: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ schema_version: 1, ts: TS(minute), event, level: 'info', task_id: 'board:I1', ...fields });

test('timelineOf maps each timeline fact to its event, never copies a rejection\'s text, and gives no since when the task.discovered is there (#960)', () => {
  const records = [
    rec('task.discovered', 0, { source: 'board' }),
    rec('stage.ended', 1, { stage: 'dev', attempt: 2, outcome: 'done', duration_ms: 60_000, waited_ms: 5_000, tool_counts: {} }),
    rec('question.answered', 2, { kind: 'ask', outcome: 'answered', duration_ms: 1_000 }),
    rec('question.answered', 3, { kind: 'ask', outcome: 'unresolved', duration_ms: 2_000 }),
    rec('run.restarted', 4, { stage: 'dev', duration_ms: 3_000 }),
    rec('approval.granted', 5, { duration_ms: 4_000 }),
    rec('approval.rejected', 6, { duration_ms: 5_000, start: true, chars: 12, sha256: '0123456789abcdef' }),
    rec('approval.expired', 7, { duration_ms: 6_000 }),
    rec('task.moved', 8, { from: 'dev', to: 'review', by: 'hand' }),
    rec('pr.opened', 9, { pr: 42 }),
  ];
  assert.deepEqual(timelineOf(records), { events: [
    { kind: 'stage', ts: TS(1), stage: 'dev', attempt: 2, outcome: 'done', durationMs: 60_000, waitedMs: 5_000 },
    { kind: 'question', ts: TS(2), durationMs: 1_000, answered: true },
    { kind: 'question', ts: TS(3), durationMs: 2_000, answered: false },
    { kind: 'restart', ts: TS(4), stage: 'dev', durationMs: 3_000 },
    { kind: 'approval', ts: TS(5), result: 'granted', durationMs: 4_000 },
    { kind: 'approval', ts: TS(6), result: 'rejected', durationMs: 5_000, start: true },
    { kind: 'approval', ts: TS(7), result: 'expired', durationMs: 6_000 },
    { kind: 'move', ts: TS(8), to: 'review', by: 'hand' },
    { kind: 'pr', ts: TS(9), pr: 42 },
  ] });
});

test('a missing or non-numeric number becomes 0 and a missing outcome or by passes as undefined; since is the oldest ts without a task.discovered (#960)', () => {
  const records = [
    rec('stage.ended', 1, { stage: 'dev', duration_ms: 60_000 }), // an old generation: no attempt, outcome nor waited_ms
    rec('run.restarted', 2, { stage: 'dev', duration_ms: 'soon' }),
    rec('task.moved', 3, { to: 'done' }),
  ];
  assert.deepEqual(timelineOf(records), { since: TS(1), events: [
    { kind: 'stage', ts: TS(1), stage: 'dev', attempt: 0, outcome: undefined, durationMs: 60_000, waitedMs: 0 },
    { kind: 'restart', ts: TS(2), stage: 'dev', durationMs: 0 },
    { kind: 'move', ts: TS(3), to: 'done', by: undefined },
  ] });
});

test('a record without a string ts, a move without to and a pr without a numeric pr are dropped; since still counts a dropped dated record; none gives { events: [] } (#960)', () => {
  const records = [
    { event: 'pr.opened', ts: 5, pr: 1 }, // no string ts: neither an event nor since
    rec('task.moved', 0, { from: 'dev', by: 'hand' }),
    rec('pr.opened', 1, { pr: '7' }),
    rec('pr.opened', 2, { pr: 7 }),
  ];
  assert.deepEqual(timelineOf(records), { since: TS(0), events: [{ kind: 'pr', ts: TS(2), pr: 7 }] });
  assert.deepEqual(timelineOf([]), { events: [] });
});
