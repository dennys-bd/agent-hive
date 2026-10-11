import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadActivity, savedPrs, savedWork } from '../src/state-guards.js';
import { FEEDBACK_MAX, type Activity, type Checkpoint } from '../src/types.js';

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

const CHECKPOINT: Checkpoint = {
  n: 1, stage: 'dev', start: 'a1b2c3d4', head: 'b2c3d4e5', commit: 'c3d4e5f6', branch: 'hive/1-x', at: '2026-10-10T10:00:00.000Z', ended: 'restart',
};

test('savedWork keeps checkpoints in their written shape and drops a malformed entry alone; none kept is no key (#619)', () => {
  assert.deepEqual(savedWork({ checkpoints: [CHECKPOINT] }).checkpoints, [CHECKPOINT]);
  const bad = [{ ...CHECKPOINT, n: 0 }, { ...CHECKPOINT, commit: '--exec=x' }, { ...CHECKPOINT, ended: 'crash' }, { ...CHECKPOINT, at: 'yesterday' }, { ...CHECKPOINT, stage: 1 }, 'x'];
  assert.deepEqual(savedWork({ checkpoints: [...bad, CHECKPOINT] }).checkpoints, [CHECKPOINT]);
  assert.equal('checkpoints' in savedWork({ checkpoints: bad }), false);
  assert.equal('checkpoints' in savedWork({ checkpoints: 'x' }), false);
  assert.deepEqual(savedWork({ checkpoints: [{ ...CHECKPOINT, extra: 'dropped' }] }).checkpoints, [CHECKPOINT], 'copied field by field');
});

test('an activity with checkpoints round-trips through state.json\'s shape (#619)', () => {
  const activity: Activity = { id: '00000000-0000-4000-8000-000000000001', kind: 'task', workspace: 'hive', slug: 'hive-1-x', worktree: '/wt', checkpoints: [CHECKPOINT] };
  assert.deepEqual(loadActivity(JSON.parse(JSON.stringify(activity))), activity);
});

test('savedPrs keeps the session that opened a PR across a load, only in the uuid shape a session id has (#62)', () => {
  const url = 'https://github.com/o/r/pull/7';
  const id = 'f9f0456a-1b2c-4d5e-8f90-123456789abc';
  assert.deepEqual(savedPrs([{ url, state: 'open', sessionId: id }], undefined), [{ url, state: 'open', sessionId: id }]);
  assert.deepEqual(savedPrs([{ url, state: 'open', sessionId: '--settings' }], undefined), [{ url, state: 'open' }]);
});
