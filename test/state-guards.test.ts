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

// #915: the try log, read back like the tries it explains
test('savedWork keeps a try log in its written shape for a counted key and drops any other record alone (#915)', () => {
  const key = '["checks","verdict","failed"]';
  const record = { transition: key, n: 1, max: 3, cause: 'build (1)', error: 'boom', at: '2026-10-10T10:00:00.000Z', stage: 'fix' };
  const resumed = { ...record, n: 2, sessionId: '11111111-1111-4111-8111-111111111111' };
  const tries = { [key]: 2 };
  assert.deepEqual(savedWork({ tries, tryLog: [record, resumed] }), { tries, tryLog: [record, resumed] });
  const malformed = [{ ...record, n: 0 }, { ...record, at: 'never' }, { ...record, cause: 7 }, 'x', { ...record, transition: '["other","done",null]' }];
  assert.deepEqual(savedWork({ tries, tryLog: [record, ...malformed] }), { tries, tryLog: [record] });
  assert.deepEqual(savedWork({ tries, tryLog: [{ ...resumed, sessionId: '--settings' }] }).tryLog, [{ ...record, n: 2 }], 'a session id only in uuid shape');
  assert.deepEqual(savedWork({ tryLog: [record] }), {}, 'no saved tries: no log');
});
