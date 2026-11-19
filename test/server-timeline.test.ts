import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { SCHEMA_VERSION, type FactRecord } from '../src/facts.js';
import { registerTimelineRoute, timelineOf, type TimelineRouteDeps } from '../src/server-timeline.js';
import { openUsageStore, type UsageStore } from '../src/usage-store.js';
import { fakeLog } from './fakes.js';
import { tempDir } from './temp-dir.js';

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

// GET /tasks/:id/timeline on an app of its own; bound to the host the fetch calls (as server-copilot-trust.test.ts)
async function getTimeline(t: TestContext, deps: TimelineRouteDeps, id: string): Promise<[number, unknown]> {
  const app = express();
  registerTimelineRoute(app, deps);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/tasks/${encodeURIComponent(id)}/timeline`);
  return [res.status, await res.json()];
}

const MOVED: FactRecord = { schema_version: SCHEMA_VERSION, ts: TS(1), event: 'task.moved', level: 'info', task_id: 'board:I1', from: 'dev', to: 'review', by: 'hand' };

test('the route answers a task\'s timeline from the store, and { events: [] } for an id with no records (#960)', async (t) => {
  const home = await tempDir(t, 'timeline-');
  const { log, lines } = fakeLog();
  const usage = await openUsageStore(home, log);
  try {
    usage.write(MOVED);
    assert.deepEqual(await getTimeline(t, { usage, log }, 'board:I1'), [200, { since: TS(1), events: [{ kind: 'move', ts: TS(1), to: 'review', by: 'hand' }] }]);
    assert.deepEqual(await getTimeline(t, { usage, log }, 'board:I9'), [200, { events: [] }]);
  } finally {
    usage.close(); // before tempDir removes the home: Windows cannot delete an open database
  }
  assert.deepEqual(lines, []);
});

test('the route answers 503 with no store or the off store, and 500 with one hive.log error line when the read throws (#960)', async (t) => {
  const { log, lines } = fakeLog();
  const off: UsageStore = { write: () => undefined, timeline: () => undefined, close: () => undefined };
  const broken: UsageStore = { write: () => undefined, timeline: () => { throw new Error('database disk image is malformed'); }, close: () => undefined };
  assert.deepEqual(await getTimeline(t, { usage: undefined, log }, 'board:I1'), [503, { error: 'the usage store is off' }]);
  assert.deepEqual(await getTimeline(t, { usage: off, log }, 'board:I1'), [503, { error: 'the usage store is off' }]);
  assert.deepEqual(lines, []);
  assert.deepEqual(await getTimeline(t, { usage: broken, log }, 'board:I1'), [500, { error: 'the timeline read failed' }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ERROR timeline board:I1: the usage store read failed: database disk image is malformed$/);
});
