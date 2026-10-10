// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx
import { expect, test } from 'vitest';
import { answerableActivity, taskState } from '@/lib/task-state';
import type { PrState, Task, Worker } from '../../src/types';
import { activityIdOf, taskPairOf } from '../fixtures/work';

const T0 = '2026-10-01T10:00:00.000Z';
const TASK: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'review', boardColumn: '', auto: true };
const run = (status: Worker['status'], n = 1): Worker => ({ id: `s${n}`, status, activityId: activityIdOf('I1'), runId: `W${n}` });
// The task's live activity and its record (#629): the approval is the activity's, the PRs the record's
const stateOf = (workers: Worker[], { approval = false, prs = [] }: { approval?: boolean; prs?: PrState[] } = {}) => {
  const made = { prs: prs.map((state, i) => ({ url: `https://github.com/o/r/pull/${i + 1}`, state })) };
  const { activity, record } = taskPairOf('I1', approval ? { approval: { since: T0 } } : {}, made);
  return { workers, activities: [activity], activityRecords: [record] };
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
  expect(taskState(TASK, { workers: [], activities: [], activityRecords: [] })).toBe('new');
  const kept = { workers: [], activities: [], activityRecords: [{ id: 'old', taskIds: ['I1'], sessions: [], prs: [{ url: 'https://github.com/o/r/pull/1', state: 'open' as const }] }] };
  expect(taskState(TASK, kept)).toBe('review');
  expect(taskState(TASK, stateOf([]))).toBe('empty'); // a live activity, nothing at work: stopped, not new
});
