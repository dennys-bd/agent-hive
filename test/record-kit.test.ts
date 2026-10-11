import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prsOf } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import { liveRecord, withPr } from '../src/record-kit.js';
import type { Task } from '../src/types.js';
import { withWork } from './fixtures/work.js';

const URL = 'https://github.com/o/r/pull/7';
const TASK: Task = { item: { itemId: 'item1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const live = withWork({ ...initialState(0), tasks: [TASK] }, 'item1');

test('withPr stores the reporting session on a new PR; a later report of the url keeps the first session and still takes the slice; a report without one leaves it absent (#62)', () => {
  const opened = withPr(live, TASK, URL, undefined, 'session-a');
  assert.deepEqual(prsOf(opened, 'item1'), [{ url: URL, state: 'open', sessionId: 'session-a' }]);
  const sliced = withPr(opened, TASK, URL, { k: 2, type: 'stacked' }, 'session-b');
  assert.deepEqual(prsOf(sliced, 'item1'), [{ url: URL, state: 'open', sessionId: 'session-a', slice: { k: 2, type: 'stacked' } }], 'the first report\'s session stays');
  assert.equal(liveRecord(withPr(opened, TASK, URL, undefined, 'session-b'), TASK), liveRecord(opened, TASK), 'no slice and a known url: the same record');
  assert.deepEqual(prsOf(withPr(live, TASK, URL), 'item1'), [{ url: URL, state: 'open' }], 'no session: no key');
});
