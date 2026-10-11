import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/orchestrator.js';
import { IDLE_POLL_INTERVAL_MS, isSourceQuota, POLL_INTERVAL_MS, QUOTA_RESERVE, shouldPoll } from '../src/polling.js';
import type { SourceQuota, State } from '../src/types.js';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const MINUTE_MS = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const TASK = { itemId: 'board:item1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
// `poll` stamps polledAt with the real clock; the tests pin it against NOW instead
const readAt = (state: State, ms: number, board = 'board'): State => ({ ...state, syncs: { ...state.syncs, [board]: { ...state.syncs[board], polledAt: iso(ms) } } });
const withQuota = (state: State, quota: SourceQuota, board = 'board'): State => ({ ...state, syncs: { ...state.syncs, [board]: { ...state.syncs[board], quota } } });
const free = readAt({ ...initialState(1), syncs: { board: {} } }, NOW - POLL_INTERVAL_MS); // one empty worker, read 30 s ago
const busy = readAt(reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, stages: [{ name: 'c', from: { board: ['Ready'] }, prompt: 'x' }] }, { type: 'poll', source: 'board', items: [{ item: TASK, column: 'Ready' }] }).state, NOW - POLL_INTERVAL_MS); // the only worker working
const quota = (remaining: number, resetsAt: number): SourceQuota => ({ limit: 5000, remaining, resetsAt: iso(resetsAt), at: iso(NOW) });

test('shouldPoll is true whenever a job could start, however fresh the source\'s last read', () => {
  assert.equal(POLL_INTERVAL_MS, 30_000);
  assert.equal(IDLE_POLL_INTERVAL_MS, 5 * MINUTE_MS);
  assert.equal(shouldPoll(free, 'board', NOW), true);
  assert.equal(shouldPoll(readAt(free, NOW), 'board', NOW), true, 'read this very instant: a free worker still wants the queue');
});

test('shouldPoll is false while nothing could start and the source\'s last read is recent; a stale or missing read polls anyway', () => {
  assert.equal(shouldPoll(busy, 'board', NOW), false, 'all occupied, read 30 s ago');
  assert.equal(shouldPoll(readAt(busy, NOW - IDLE_POLL_INTERVAL_MS), 'board', NOW), true, 'all occupied, read 5 min ago');
  assert.equal(shouldPoll(readAt(busy, NOW - IDLE_POLL_INTERVAL_MS + 1), 'board', NOW), false, 'one ms short of stale');
  assert.equal(shouldPoll({ ...busy, syncs: { board: {} } }, 'board', NOW), true, 'never read');
  assert.equal(shouldPoll({ ...busy, syncs: { board: { polledAt: 'garbage' } } }, 'board', NOW), true, 'an unparsable stamp reads as stale');
  assert.equal(shouldPoll({ ...free, signal: 'red' }, 'board', NOW), false, 'red with a free worker, read 30 s ago');
  assert.equal(shouldPoll({ ...free, signal: 'yellow' }, 'board', NOW), true, 'the default yellow (tree) could start a child: the fill decides which (#32)');
  assert.equal(shouldPoll(readAt({ ...free, signal: 'red' }, NOW - IDLE_POLL_INTERVAL_MS), 'board', NOW), true, 'red, but the queue is 5 min old');
  const broke: State = { ...free, budget: { maxTokensPerHour: 100 }, usage: [{ at: iso(NOW - MINUTE_MS), tokens: 100 }] };
  assert.equal(shouldPoll(broke, 'board', NOW), false, 'no token budget left');
});

test('shouldPoll is false inside the source\'s quota backoff whatever else holds, and true again once the reset has passed', () => {
  assert.equal(QUOTA_RESERVE, 500);
  const soon = NOW + MINUTE_MS;
  assert.equal(shouldPoll(withQuota(free, quota(QUOTA_RESERVE - 1, soon)), 'board', NOW), false, 'below the reserve with a free worker');
  const staleBusy = readAt(busy, NOW - IDLE_POLL_INTERVAL_MS);
  assert.equal(shouldPoll(withQuota(staleBusy, quota(0, soon)), 'board', NOW), false, 'a stale read does not break the backoff');
  assert.equal(shouldPoll(withQuota(free, quota(QUOTA_RESERVE, soon)), 'board', NOW), true, 'at the reserve is not below it');
  assert.equal(shouldPoll(withQuota(free, quota(QUOTA_RESERVE - 1, NOW - 1)), 'board', NOW), true, 'reset in the past: the backoff lifts by itself');
  assert.equal(shouldPoll(withQuota(free, quota(QUOTA_RESERVE - 1, NOW)), 'board', NOW), true, 'a reset right now counts as passed');
});

test('each source decides on its own: one in backoff is skipped while another is polled, and a stale source is polled when nothing can start (#180)', () => {
  const two = withQuota(readAt(free, NOW - POLL_INTERVAL_MS, 'notes'), quota(0, NOW + MINUTE_MS));
  assert.deepEqual([shouldPoll(two, 'board', NOW), shouldPoll(two, 'notes', NOW)], [false, true]);
  const stale = readAt(busy, NOW - IDLE_POLL_INTERVAL_MS, 'notes');
  assert.deepEqual([shouldPoll(stale, 'board', NOW), shouldPoll(stale, 'notes', NOW)], [false, true]);
});

test('isSourceQuota accepts the read shape and rejects anything else', () => {
  const valid = quota(4320, NOW + MINUTE_MS);
  assert.equal(isSourceQuota(valid), true);
  assert.equal(isSourceQuota({ ...valid, remaining: 0 }), true, 'zero is a count');
  assert.equal(isSourceQuota({ ...valid, remaining: -1 }), false);
  assert.equal(isSourceQuota({ ...valid, limit: Infinity }), false);
  assert.equal(isSourceQuota({ ...valid, limit: '5000' }), false);
  assert.equal(isSourceQuota({ limit: 5000, remaining: 1, at: iso(NOW) }), false, 'resetsAt missing');
  assert.equal(isSourceQuota({ ...valid, resetsAt: 7 }), false);
  assert.equal(isSourceQuota({ ...valid, at: undefined }), false);
  for (const value of [undefined, null, 'x', 5, []]) assert.equal(isSourceQuota(value), false, String(value));
});
