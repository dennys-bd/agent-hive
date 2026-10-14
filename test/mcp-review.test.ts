import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localActivityId } from '../src/activities.js';
import { type ReplyReviews, type ReviewAccess, workerReview } from '../src/mcp-review.js';
import { initialState } from '../src/orchestrator.js';
import { EMPTY_REVIEW } from '../src/review-store.js';
import type { Task, Worker } from '../src/types.js';
import { activityIdOf, withWork } from './fixtures/work.js';

const TASK: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'T', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true };
const STORE = (): ReviewAccess => ({ read: async () => EMPTY_REVIEW, update: async () => EMPTY_REVIEW });
const worker = (activityId?: string): Worker => ({ id: 'w', runId: 'p', status: 'working', ...(activityId === undefined ? {} : { activityId }) });

test('a task\'s worker answers in its task\'s review, a local one in its workspace\'s local review, any other in none (#591, #344)', () => {
  const calls: string[] = [];
  const deps: ReplyReviews = { reviews: STORE(), notifyReview: (id) => { calls.push(`task ${id}`); }, localReviews: STORE(), notifyLocalReview: (ws) => { calls.push(`local ${ws}`); } };
  const state = withWork({ ...initialState(0), tasks: [TASK] }, 'local:1');
  const onTask = workerReview(deps, state, worker(activityIdOf('local:1')));
  const onLocal = workerReview(deps, state, worker(localActivityId('hive')));
  assert.deepEqual([onTask?.store === deps.reviews, onTask?.key, onLocal?.store === deps.localReviews, onLocal?.key], [true, 'local:1', true, 'hive']);
  onTask?.notify();
  onLocal?.notify();
  assert.deepEqual(calls, ['task local:1', 'local hive']);
  assert.equal(workerReview(deps, state, worker()), undefined);
});
