import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseShortstat, readInterventions, runMetrics, stageSpans } from '../../src/benchmark/metrics.js';
import { costOf } from '../../src/benchmark/prices.js';
import type { WatchState, WatchTask } from '../../src/benchmark/watcher.js';
import type { ActivityRecord, Intervention, TaskUsage } from '../../src/types.js';
import { tempDir } from '../temp-dir.js';
import { snap, task, watchTask } from './fixtures.js';

const T0 = '2026-10-21T22:00:00.000Z';
// #629: usage and the reported result live on the task's activity record, not on the task
const withRecord = (state: ReturnType<typeof snap>, n: number, extra: Partial<ActivityRecord>): ReturnType<typeof snap> => ({
  ...state, activityRecords: state.activityRecords.map((r) => (r.taskIds[0] === `local:${n}` ? { ...r, ...extra } : r)),
});
const plus = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();
const usage = (tokens: number, minutes: number, waitingMinutes = 0): TaskUsage => ({ tokens, ms: minutes * 60_000, waitingMs: waitingMinutes * 60_000, parts: [] });
const watchOf = (tasks: WatchTask[], stageRuns: WatchState['stageRuns']): WatchState => ({ tasks, released: [], entries: {}, stageRuns });
const FACTS = { startedAt: T0, endedAt: plus(60), sleptMs: 0, diff: { files: 0, insertions: 0, deletions: 0 }, modelTokens: {} };
// Run B · par 1 of benchmark.hv.html's result screen: three of its tasks, HIV-415 restarted in Build, 30 minutes asleep, two models
const SCREEN_TASKS = [watchTask(1, [], 'HIV-413', 'cor do workspace no card'), watchTask(2, [], 'HIV-414', 'menu da source'), watchTask(3, [], 'HIV-415', 'paginação na coluna de concluídas')];
const MODEL_TOKENS = {
  'claude-opus-5-5': { input: 40_000, output: 300_000, cache_write: 200_000, cache_read: 1_500_000 },
  'claude-sonnet-5-5': { input: 10_000, output: 50_000, cache_write: 100_000, cache_read: 400_000 },
};

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

test("runMetrics gives the result screen's run B · par 1: tokens, time without sleep, waiting, restarts with where, diff, tests and cost (#473)", () => {
  const usages = [usage(800_000, 22), usage(700_000, 38), usage(1_100_000, 72, 18)];
  const state = usages.reduce((s, u, i) => withRecord(s, i + 1, { usage: u, result: { merged: true, testsGreen: true } }), snap([task(1, 'Done'), task(2, 'Done'), task(3, 'Done')]));
  const watch = watchOf(SCREEN_TASKS, { 'local:1': { Build: ['r1'] }, 'local:2': { Build: ['r2'] }, 'local:3': { Spec: ['r3'], Build: ['r4', 'r5'] } });
  const diff = { files: 33, insertions: 3480, deletions: 540 };
  const { metrics, unpriced } = runMetrics({ startedAt: T0, endedAt: plus(325), sleptMs: 30 * 60_000, watch, state, diff, modelTokens: MODEL_TOKENS });
  assert.deepEqual(
    [metrics.tokens, metrics.ms, metrics.waitingMs, metrics.restarts, metrics.diff, metrics.tests],
    [2_600_000, 17_700_000, 1_080_000, { count: 1, where: ['build · HIV-415'] }, diff, { green: 3, total: 3 }],
  );
  assert.deepEqual(metrics.tasks.map((t) => [t.key, t.title, t.ms, t.restarts]), [
    ['HIV-413', 'cor do workspace no card', 1_320_000, 0], ['HIV-414', 'menu da source', 2_280_000, 0], ['HIV-415', 'paginação na coluna de concluídas', 4_320_000, 1],
  ]);
  // The cost is the table's: the screen's $31 is sample data
  assert.deepEqual([metrics.costUsd, unpriced], [costOf(MODEL_TOKENS).usd, []]);
  assert.ok(metrics.costUsd > 0);
});

test('runMetrics counts restarts in every stage, one where entry per stage and task in seed order; tests count only a boolean testsGreen; sleep past the span is 0 ms (#473)', () => {
  const watch = watchOf([watchTask(1), watchTask(2)], { 'local:1': { Spec: ['r1', 'r2'], Build: ['r3', 'r4'] }, 'local:2': { Plan: ['r5'], Build: ['r6', 'r7', 'r8'] } });
  const state = withRecord(withRecord(snap([task(1, 'Done'), task(2, 'Done')]), 1, { result: { testsGreen: false } }), 2, { result: { testsGreen: 'yes' } });
  const { metrics } = runMetrics({ ...FACTS, sleptMs: 2 * 3_600_000, watch, state });
  assert.deepEqual(metrics.restarts, { count: 4, where: ['spec · T1', 'build · T1', 'build · T2'] });
  assert.deepEqual(metrics.tasks.map((t) => t.restarts), [2, 2]);
  assert.deepEqual([metrics.tests, metrics.ms, metrics.costUsd], [{ green: 0, total: 1 }, 0, 0]);
});

const DONE: Intervention = { at: '2026-10-21T00:42:00.000Z', action: 'approve', detail: 'git push --force · denied by the arm rule', by: 'user' };
const recorder = (): { log: (line: string) => void; lines: string[] } => {
  const lines: string[] = [];
  return { lines, log: (line) => { lines.push(line); } };
};

test('readInterventions reads interventions.json, a missing file as none, and a half-written one as none with one line naming the home (#473)', async (t) => {
  const home = await tempDir(t, 'bench-');
  const { log, lines } = recorder();
  assert.deepEqual(await readInterventions(home, log), []);
  assert.equal(lines.length, 0, 'a run without interventions logs nothing'); // not deepEqual: it would narrow lines to never
  await writeFile(join(home, 'interventions.json'), JSON.stringify([DONE]));
  assert.deepEqual(await readInterventions(home, log), [DONE]);
  await writeFile(join(home, 'interventions.json'), JSON.stringify([DONE]).slice(0, 30));
  assert.deepEqual(await readInterventions(home, log), []);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(home));
});

test('readInterventions drops what is not an intervention, with one line that never quotes it (#473)', async (t) => {
  const home = await tempDir(t, 'bench-');
  const { log, lines } = recorder();
  await writeFile(join(home, 'interventions.json'), JSON.stringify([DONE, { ...DONE, by: 'worker' }, { ...DONE, detail: 1 }, 'x', null]));
  assert.deepEqual(await readInterventions(home, log), [DONE]);
  await writeFile(join(home, 'interventions.json'), JSON.stringify({ at: DONE.at }));
  assert.deepEqual(await readInterventions(home, log), []);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(line.includes(home) && !line.includes('denied') && !line.includes(DONE.at), line);
});
