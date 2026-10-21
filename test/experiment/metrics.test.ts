import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedMetrics, parseShortstat, runMetrics, stageSpans } from '../../scripts/experiment/metrics.js';
import type { ActivityRecord, TaskUsage } from '../../src/types.js';
import { snap, task } from '../benchmark/fixtures.js';

const T0 = '2026-10-01T22:00:00.000Z';
// #629: usage and the reported result live on the task's activity record, not on the task
const withRecord = (state: ReturnType<typeof snap>, n: number, extra: Partial<ActivityRecord>): ReturnType<typeof snap> => ({
  ...state, activityRecords: state.activityRecords.map((r) => (r.taskIds[0] === `local:${n}` ? { ...r, ...extra } : r)),
});
const plus = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();

test('stageSpans measures each stage up to the next entry, stops at Done, and runs an unfinished stage to the end (#105)', () => {
  const entries = [{ stage: 'Spec', at: T0 }, { stage: 'Plan', at: plus(10) }, { stage: 'Build', at: plus(40) }, { stage: 'Merge', at: plus(120) }, { stage: 'Done', at: plus(130) }];
  assert.deepEqual(stageSpans(entries, plus(500)), [{ stage: 'Spec', ms: 600_000 }, { stage: 'Plan', ms: 1_800_000 }, { stage: 'Build', ms: 4_800_000 }, { stage: 'Merge', ms: 600_000 }]);
  assert.deepEqual(stageSpans(entries.slice(0, 3), plus(100)), [{ stage: 'Spec', ms: 600_000 }, { stage: 'Plan', ms: 1_800_000 }, { stage: 'Build', ms: 3_600_000 }]);
  assert.deepEqual(stageSpans([], plus(1)), []);
});

test('parseShortstat reads git diff --shortstat, with either count missing and with no change (#105)', () => {
  assert.deepEqual(parseShortstat(' 12 files changed, 340 insertions(+), 25 deletions(-)\n'), { files: 12, insertions: 340, deletions: 25 });
  assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)\n'), { files: 1, insertions: 1, deletions: 0 });
  assert.deepEqual(parseShortstat(' 2 files changed, 3 deletions(-)\n'), { files: 2, insertions: 0, deletions: 3 });
  assert.deepEqual(parseShortstat(''), { files: 0, insertions: 0, deletions: 0 });
});

test('runMetrics sums usage, counts Build restarts, keeps outcome, the last Done report, and an unpaired rerun (#105)', () => {
  const watch = {
    tasks: [{ itemId: 'local:1', blockedBy: [] }, { itemId: 'local:2', blockedBy: ['local:1'] }], released: ['local:1', 'local:2'],
    entries: { 'local:1': [{ stage: 'Spec', at: T0 }, { stage: 'Done', at: plus(60) }], 'local:2': [{ stage: 'Spec', at: plus(60) }, { stage: 'Build', at: plus(90) }] },
    buildRuns: { 'local:1': ['r1'], 'local:2': ['r2', 'r3', 'r4'] },
  };
  const usage: TaskUsage = { tokens: 1000, ms: 3_000_000, waitingMs: 0, parts: [] };
  const state = withRecord(snap([task(1, 'Done'), task(2, 'Build')]), 1, { usage, result: { testsGreen: false } });
  const metrics = runMetrics({ token: 'bbbbbb', startedAt: T0, endedAt: plus(120), end: { outcome: 'error', reason: 'MON-2: boom' }, watch, state, diff: { files: 1, insertions: 2, deletions: 3 }, unpaired: true });
  assert.deepEqual([metrics.token, metrics.outcome, metrics.reason, metrics.tokens, metrics.ms, metrics.buildRestarts, metrics.reportedTestsGreen, metrics.unpaired], ['bbbbbb', 'error', 'MON-2: boom', 1000, 3_000_000, 2, false, true]);
  assert.deepEqual(metrics.tasks.map((t) => [t.id, t.tokens, t.buildRestarts, t.stages]), [
    ['MON-1', 1000, 0, [{ stage: 'Spec', ms: 3_600_000 }]],
    ['MON-2', 0, 2, [{ stage: 'Spec', ms: 1_800_000 }, { stage: 'Build', ms: 1_800_000 }]],
  ]);
});

test('failedMetrics records an attempt that failed before anything ran (#105)', () => {
  const m = failedMetrics('aaaaaa', T0, 'git push refused', true);
  assert.deepEqual([m.token, m.outcome, m.reason, m.tasks, m.tokens, m.diff, m.unpaired], ['aaaaaa', 'error', 'git push refused', [], 0, { files: 0, insertions: 0, deletions: 0 }, true]);
});
