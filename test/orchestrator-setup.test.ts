import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, withActivity } from '../src/activities.js';
import { initialState, reduce } from '../src/orchestrator.js';
import type { Item, SetupRow, Stage, State } from '../src/types.js';

// A failed worktree setup's rows on the activity (#390): what the Start dialog shows after the mark is gone. Out of orchestrator.test.ts,
// which is past 2,000 lines.
const ID = 'board:1';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const STAGES: Stage[] = [{ name: 'Build', from: { board: ['Ready'] }, prompt: '/build {url}' }];
const AT = '2026-10-19T10:00:00.000Z';
const CONSOLE = 'setup:board:1';
const PREPARING: SetupRow[] = [{ kind: 'worktree', status: 'running', startedAt: AT }, { kind: 'branch', status: 'running', startedAt: AT, branch: 'hive/1-task-1', base: 'origin/main' }];
const PASSED: SetupRow[] = [
  { kind: 'worktree', status: 'done', durationMs: 900 }, { kind: 'branch', status: 'done', branch: 'hive/1-task-1', base: 'origin/main' },
  { kind: 'step', status: 'done', label: 'pnpm install', header: 'RUN pnpm install', durationMs: 40 },
];
const FAILED: SetupRow[] = [...PASSED.slice(0, 2), { ...PASSED[2], status: 'failed', code: '1' }];

// Task 1 polled into Build under red, its activity born as a first open makes it (#629): nothing runs until a start by hand
function opened(): { state: State; id: string } {
  const red = reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, stages: STAGES, transitions: [] }, { type: 'setSignal', signal: 'red' }).state;
  const polled = reduce(red, { type: 'poll', source: 'board', items: [{ item, column: 'Ready' }] }).state;
  const born = reduce(polled, { type: 'createActivity', taskId: ID }).state;
  return { state: born, id: activityOf(born, ID)?.id ?? 'none' };
}
const live = (state: State) => activityOf(state, ID);
const setUp = (state: State, id: string, rows: SetupRow[]): State => {
  const began = reduce(state, { type: 'setupStarted', activityId: id, consoleId: CONSOLE, rows: PREPARING }).state;
  return reduce(began, { type: 'setupStep', activityId: id, step: 'RUN pnpm install', rows }).state;
};

test('setupStarted puts the rows on the setup and drops the last failed setup with the error; setupStep replaces the step and the rows; the input is not mutated (#390)', () => {
  const { state, id } = opened();
  const failedBefore = withActivity(state, { ...live(state)!, error: 'start failed: x', lastSetup: { consoleId: CONSOLE, rows: FAILED } });
  const frozen = structuredClone(failedBefore);
  const began = reduce(failedBefore, { type: 'setupStarted', activityId: id, consoleId: CONSOLE, rows: PREPARING }).state;
  assert.deepEqual([live(began)?.setup, live(began)?.lastSetup, live(began)?.error], [{ consoleId: CONSOLE, rows: PREPARING }, undefined, undefined]);
  const stepped = reduce(began, { type: 'setupStep', activityId: id, step: 'RUN pnpm install', rows: PASSED }).state;
  assert.deepEqual(live(stepped)?.setup, { consoleId: CONSOLE, step: 'RUN pnpm install', rows: PASSED });
  assert.deepEqual(failedBefore, frozen);
});

test('setupEnded keeps a setup with a failed row as lastSetup, next to the error; one that passed leaves none (#390)', () => {
  const { state, id } = opened();
  const error = 'setup failed at line 1 (RUN pnpm install): exit 1';
  const failed = reduce(setUp(state, id, FAILED), { type: 'setupEnded', activityId: id, error }).state;
  assert.deepEqual([live(failed)?.setup, live(failed)?.lastSetup, live(failed)?.error], [undefined, { consoleId: CONSOLE, rows: FAILED }, error]);
  const passed = reduce(setUp(state, id, PASSED), { type: 'setupEnded', activityId: id }).state;
  assert.equal('lastSetup' in (live(passed) ?? {}), false);
});

test('a manual start drops lastSetup where it drops the error (#390)', () => {
  const { state, id } = opened();
  const failed = reduce(setUp(state, id, FAILED), { type: 'setupEnded', activityId: id }).state;
  const started = reduce(failed, { type: 'start', itemId: ID });
  assert.equal('lastSetup' in (live(started.state) ?? {}), false);
  assert.ok(started.effects.some((e) => e.type === 'spawn'));
});
