import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedWork } from '../src/state-guards.js';
import { FEEDBACK_MAX } from '../src/types.js';

// #134: a state file is read back, never trusted: the routing keys, a pending handoff and its feedback, and a handover's prompt are capped on load
test('savedWork keeps via, handoffPending, handoffFeedback and a handover within their caps and drops any longer one (#134)', () => {
  const key = '["spec","done",null]';
  const kept = { via: key, handoffPending: key, handoffFeedback: 'split it', handover: { prompt: 'p' } };
  assert.deepEqual(savedWork(kept), kept);
  const long = 'x'.repeat(FEEDBACK_MAX + 1);
  assert.deepEqual(savedWork({ via: long, handoffPending: long, handoffFeedback: long, handover: { prompt: 'x'.repeat(1024 * 1024) } }), {});
  assert.deepEqual(savedWork({ handoffFeedback: 7 }), {});
});
