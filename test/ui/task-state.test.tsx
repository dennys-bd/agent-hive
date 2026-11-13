// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx
import { expect, test } from 'vitest';
import { answerableActivity, semaphoreWait, taskState } from '@/lib/task-state';
import type { Activity, PrState, SemaphoreState, Stage, Task, Worker } from '../../src/types';
import { activityIdOf, taskPairOf } from '../fixtures/work';

const T0 = '2026-10-01T10:00:00.000Z';
const TASK: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'review', boardColumn: '', auto: true };
const run = (status: Worker['status'], n = 1): Worker => ({ id: `s${n}`, status, activityId: activityIdOf('I1'), runId: `W${n}` });
// The task's live activity and its record (#629): the approval is the activity's, the PRs the record's
// No stage by default: the task's stage is unknown, so it is never queued and the review rules read as before #15
const stateOf = (workers: Worker[], { approval = false, prs = [], stages = [], live = {} }: { approval?: boolean; prs?: PrState[]; stages?: Stage[]; live?: Partial<Activity> } = {}) => {
  const made = { prs: prs.map((state, i) => ({ url: `https://github.com/o/r/pull/${i + 1}`, state })) };
  const { activity, record } = taskPairOf('I1', { ...(approval ? { approval: { since: T0 } } : {}), ...live }, made);
  return { workers, activities: [activity], activityRecords: [record], stages };
};

test('with no session at work, an open PR in the records is review, over an approval and over a held run (#663)', () => {
  expect(taskState(TASK, stateOf([], { prs: ['open'] }))).toBe('review');
  expect(taskState(TASK, stateOf([], { approval: true, prs: ['merged', 'open'] }))).toBe('review');
  expect(taskState(TASK, stateOf([run('approval')], { approval: true, prs: ['open'] }))).toBe('review');
});

test('with no session at work and no open PR, an awaiting approval is approval, a held run or not; a merged or closed PR alone is empty (#663)', () => {
  expect(taskState(TASK, stateOf([], { approval: true }))).toBe('approval');
  expect(taskState(TASK, stateOf([run('approval')], { approval: true, prs: ['closed'] }))).toBe('approval');
  expect(taskState(TASK, stateOf([], { prs: ['merged', 'closed'] }))).toBe('empty');
  expect(taskState(TASK, stateOf([]))).toBe('empty');
});

test('a session working or waiting wins over review and approval, the most urgent of them (#663)', () => {
  expect(taskState(TASK, stateOf([run('working')], { prs: ['open'] }))).toBe('working');
  expect(taskState(TASK, stateOf([run('waiting')], { approval: true }))).toBe('waiting');
  expect(taskState(TASK, stateOf([run('working'), run('waiting', 2), run('approval', 3)], { approval: true, prs: ['open'] }))).toBe('waiting');
});

test('answerableActivity: the live activity while it carries an approval and no session of the task is live, its status approval or review; undefined while a session works, waits or backs off, and without an approval (#829)', () => {
  const answerable = (workers: Worker[], extra: { approval?: boolean; prs?: PrState[] } = {}): boolean => answerableActivity(TASK, stateOf(workers, extra)) !== undefined;
  expect(answerableActivity(TASK, stateOf([], { approval: true }))?.id).toBe(activityIdOf('I1'));
  expect(answerable([run('approval')], { approval: true })).toBe(true); // a held run is idle until approve or feedback (#268)
  expect(answerable([], { approval: true, prs: ['open'] })).toBe(true); // review: nothing runs, the stage's approval is still the user's
  expect(answerable([run('working')], { approval: true })).toBe(false);
  expect(answerable([run('waiting')], { approval: true })).toBe(false); // the user answers in the waiting session
  expect(answerable([run('backoff')], { approval: true })).toBe(false); // a run waiting out an API error still holds its run (#805)
  expect(answerable([])).toBe(false);
  expect(answerable([], { prs: ['open'] })).toBe(false);
});

test('a task with no live activity and no session at work is new; a deleted activity\'s open PR still reads review (#727)', () => {
  expect(taskState(TASK, { workers: [], activities: [], activityRecords: [], stages: [] })).toBe('new');
  const kept = { workers: [], activities: [], stages: [], activityRecords: [{ id: 'old', taskIds: ['I1'], sessions: [], prs: [{ url: 'https://github.com/o/r/pull/1', state: 'open' as const }] }] };
  expect(taskState(TASK, kept)).toBe('review');
  expect(taskState(TASK, stateOf([]))).toBe('empty'); // a live activity, nothing at work: stopped, not new
});

const RUNS: Stage = { name: 'review', from: {}, prompt: 'p' };
const GATE: Stage = { name: 'review', from: {} };

test('a CI wait or a commands stage in flight is working, never review, its open PR or not (#15)', () => {
  const ci: Partial<Activity> = { ci: { stage: 'review', since: T0, reran: [] } };
  const commands: Partial<Activity> = { commands: { stage: 'review', at: 0, ptyId: 'p1', runId: 'p1', failed: [], workerId: 's1', started: [] } };
  expect(taskState(TASK, stateOf([], { prs: ['open'], live: ci }))).toBe('working');
  expect(taskState(TASK, stateOf([], { prs: ['open'], live: commands, stages: [GATE] }))).toBe('working');
  expect(taskState(TASK, stateOf([], { live: ci }))).toBe('working');
});

test('a task queued to run with an open PR is not review: empty, or new without a live activity; out of the queue it is review again (#15)', () => {
  expect(taskState(TASK, stateOf([], { prs: ['open'], stages: [RUNS] }))).toBe('empty');
  expect(taskState(TASK, { workers: [], activities: [], activityRecords: stateOf([], { prs: ['open'] }).activityRecords, stages: [RUNS] })).toBe('new');
  expect(taskState(TASK, stateOf([], { prs: ['open'], stages: [GATE] }))).toBe('review'); // a manual gate holds no run: the PR is the user's
  expect(taskState({ ...TASK, auto: false }, stateOf([], { prs: ['open'], stages: [RUNS] }))).toBe('review'); // auto off: no worker takes it
  expect(taskState(TASK, stateOf([], { prs: ['open'], stages: [RUNS], live: { stopped: true } }))).toBe('review');
  expect(taskState(TASK, stateOf([], { approval: true, prs: ['open'], stages: [RUNS] }))).toBe('review'); // a held approval is not queued
});

test('a task outside the flow reads its status from its activity as any task does (#566)', () => {
  const { stage: _stage, ...outside } = TASK;
  expect(taskState(outside, { workers: [], activities: [], activityRecords: [] })).toBe('new');
  expect(taskState(outside, stateOf([]))).toBe('empty');
  expect(taskState(outside, stateOf([run('working')]))).toBe('working');
  expect(taskState(outside, stateOf([], { prs: ['open'] }))).toBe('review');
});

// #805: a worker whose pty stands in a Command Semaphore's line
const sem = (line: SemaphoreState['line'], runs: string[] = []): SemaphoreState => ({ runs, line });
const withSems = (workers: Worker[], semaphores: Record<string, SemaphoreState>) => ({ ...stateOf(workers), semaphores });

test('semaphoreWait: undefined with no place; the place on a semaphore; a turn beats a lower place; a captured session reads its terminal pty (#805)', () => {
  expect(semaphoreWait(TASK, withSems([run('working')], {}))).toBeUndefined();
  expect(semaphoreWait(TASK, stateOf([run('working')]))).toBeUndefined(); // no semaphores in the input
  expect(semaphoreWait(TASK, withSems([run('working')], { memory: sem([{ ptyId: 'other', place: 1 }]) }))).toBeUndefined();
  expect(semaphoreWait(TASK, withSems([run('working')], { memory: sem([{ ptyId: 's1', place: 2 }]) }))).toEqual({ semaphore: 'memory', ptyId: 's1', place: 2 });
  const turn = { ptyId: 's2', place: 0, turnUntil: '2026-10-01T10:02:00.000Z' };
  expect(semaphoreWait(TASK, withSems([run('working'), run('working', 2)], { memory: sem([{ ptyId: 's1', place: 1 }]), cpu: sem([turn]) })))
    .toEqual({ semaphore: 'cpu', ptyId: 's2', place: 0, turnUntil: turn.turnUntil });
  expect(semaphoreWait(TASK, withSems([run('working'), run('working', 2)], { a: sem([{ ptyId: 's1', place: 3 }]), b: sem([{ ptyId: 's2', place: 1 }]) }))?.semaphore).toBe('b');
  const captured: Worker = { ...run('working'), terminalId: 'T9' };
  expect(semaphoreWait(TASK, withSems([captured], { memory: sem([{ ptyId: 'T9', place: 1 }]) }))?.ptyId).toBe('T9');
});

test('a worker in a semaphore line reads backoff, but a question to the user still wins (#805)', () => {
  const line = { memory: sem([{ ptyId: 's1', place: 1 }]) };
  expect(taskState(TASK, withSems([run('working')], line))).toBe('backoff');
  expect(taskState(TASK, withSems([run('working')], {}))).toBe('working');
  expect(taskState(TASK, withSems([run('working'), run('waiting', 2)], line))).toBe('waiting');
});
