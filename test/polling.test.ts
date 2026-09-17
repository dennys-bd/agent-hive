import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/orchestrator.js';
import { IDLE_POLL_INTERVAL_MS, isBoardQuota, POLL_INTERVAL_MS, QUOTA_RESERVE, shouldPoll } from '../src/polling.js';
import type { BoardQuota, State } from '../src/types.js';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const MINUTE_MS = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const TASK = { itemId: 'item1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1' };
// `poll` stamps lastPolledAt with the real clock; the tests pin it against NOW instead
const readAt = (state: State, ms: number): State => ({ ...state, lastPolledAt: iso(ms) });
const free = readAt(initialState(1), NOW - POLL_INTERVAL_MS); // one empty slot, read 30 s ago
const busy = readAt(reduce({ ...initialState(1), columns: [{ name: 'c', weight: 1, from: ['Ready'], prompt: 'x' }] }, { type: 'poll', cards: [{ task: TASK, column: 'Ready' }] }).state, NOW - POLL_INTERVAL_MS); // the only slot working
const quota = (remaining: number, resetsAt: number): BoardQuota => ({ limit: 5000, remaining, resetsAt: iso(resetsAt), at: iso(NOW) });

test('shouldPoll is true whenever a job could start, however fresh the last read', () => {
  assert.equal(POLL_INTERVAL_MS, 30_000);
  assert.equal(IDLE_POLL_INTERVAL_MS, 5 * MINUTE_MS);
  assert.equal(shouldPoll(free, NOW), true);
  assert.equal(shouldPoll(readAt(free, NOW), NOW), true, 'read this very instant: a free slot still wants the queue');
});

test('shouldPoll is false while nothing could start and the last read is recent; a stale or missing read polls anyway', () => {
  assert.equal(shouldPoll(busy, NOW), false, 'all occupied, read 30 s ago');
  assert.equal(shouldPoll(readAt(busy, NOW - IDLE_POLL_INTERVAL_MS), NOW), true, 'all occupied, read 5 min ago');
  assert.equal(shouldPoll(readAt(busy, NOW - IDLE_POLL_INTERVAL_MS + 1), NOW), false, 'one ms short of stale');
  assert.equal(shouldPoll({ ...busy, lastPolledAt: undefined }, NOW), true, 'never read');
  assert.equal(shouldPoll({ ...busy, lastPolledAt: 'garbage' }, NOW), true, 'an unparsable stamp reads as stale');
  assert.equal(shouldPoll({ ...free, signal: 'red' }, NOW), false, 'red with a free slot, read 30 s ago');
  assert.equal(shouldPoll({ ...free, signal: 'yellow' }, NOW), false);
  assert.equal(shouldPoll(readAt({ ...free, signal: 'red' }, NOW - IDLE_POLL_INTERVAL_MS), NOW), true, 'red, but the queue is 5 min old');
  const broke: State = { ...free, budget: { maxTokensPerHour: 100 }, usage: [{ at: iso(NOW - MINUTE_MS), tokens: 100 }] };
  assert.equal(shouldPoll(broke, NOW), false, 'no token budget left');
});

test('shouldPoll is false inside a quota backoff whatever else holds, and true again once the reset has passed', () => {
  assert.equal(QUOTA_RESERVE, 500);
  const soon = NOW + MINUTE_MS;
  assert.equal(shouldPoll({ ...free, boardQuota: quota(QUOTA_RESERVE - 1, soon) }, NOW), false, 'below the reserve with a free slot');
  const staleBusy = readAt(busy, NOW - IDLE_POLL_INTERVAL_MS);
  assert.equal(shouldPoll({ ...staleBusy, boardQuota: quota(0, soon) }, NOW), false, 'a stale read does not break the backoff');
  assert.equal(shouldPoll({ ...free, boardQuota: quota(QUOTA_RESERVE, soon) }, NOW), true, 'at the reserve is not below it');
  assert.equal(shouldPoll({ ...free, boardQuota: quota(QUOTA_RESERVE - 1, NOW - 1) }, NOW), true, 'reset in the past: the backoff lifts by itself');
  assert.equal(shouldPoll({ ...free, boardQuota: quota(QUOTA_RESERVE - 1, NOW) }, NOW), true, 'a reset right now counts as passed');
});

test('isBoardQuota accepts the read shape and rejects anything else', () => {
  const valid = quota(4320, NOW + MINUTE_MS);
  assert.equal(isBoardQuota(valid), true);
  assert.equal(isBoardQuota({ ...valid, remaining: 0 }), true, 'zero is a count');
  assert.equal(isBoardQuota({ ...valid, remaining: -1 }), false);
  assert.equal(isBoardQuota({ ...valid, limit: Infinity }), false);
  assert.equal(isBoardQuota({ ...valid, limit: '5000' }), false);
  assert.equal(isBoardQuota({ limit: 5000, remaining: 1, at: iso(NOW) }), false, 'resetsAt missing');
  assert.equal(isBoardQuota({ ...valid, resetsAt: 7 }), false);
  assert.equal(isBoardQuota({ ...valid, at: undefined }), false);
  for (const value of [undefined, null, 'x', 5, []]) assert.equal(isBoardQuota(value), false, String(value));
});
