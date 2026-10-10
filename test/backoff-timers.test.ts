import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackoffTimers } from '../src/backoff-timers.js';
import type { Worker } from '../src/types.js';

const PTY = '1a2b3c4d-1111-4111-8111-111111111111';
const OTHER = '2b3c4d5e-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const waiting = (until: string, runId = PTY): Worker => ({ id: runId, runId, status: 'backoff', backoff: { error: 'overloaded', until } });

test('a wait arms one timer for its until, which dispatches retryDue with that very string once; syncing the same wait again arms no second (#805)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const due: [string, string][] = [];
  const timers = createBackoffTimers((ptyId, until) => due.push([ptyId, until]));
  const until = iso(NOW + 60_000);
  timers.sync([waiting(until)]);
  timers.sync([waiting(until)]);
  t.mock.timers.tick(59_999);
  assert.deepEqual(due, []);
  t.mock.timers.tick(1);
  assert.deepEqual(due, [[PTY, until]]);
  t.mock.timers.tick(600_000);
  assert.equal(due.length, 1, 'once');
});

test('a wait whose until moved replaces its timer, one that ended clears it, and close clears every timer (#805)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const due: [string, string][] = [];
  const timers = createBackoffTimers((ptyId, until) => due.push([ptyId, until]));
  const first = iso(NOW + 60_000);
  const later = iso(NOW + 120_000);
  timers.sync([waiting(first), waiting(first, OTHER)]);
  timers.sync([waiting(later), waiting(first, OTHER)]);
  timers.sync([waiting(later), { id: OTHER, runId: OTHER, status: 'working' }]);
  t.mock.timers.tick(60_000);
  assert.deepEqual(due, [], 'the first until was replaced and the other run no longer waits');
  t.mock.timers.tick(60_000);
  assert.deepEqual(due, [[PTY, later]]);
  timers.sync([waiting(iso(NOW + 300_000))]);
  timers.close();
  t.mock.timers.tick(600_000);
  assert.deepEqual(due, [[PTY, later]], 'closed: nothing fires');
});
