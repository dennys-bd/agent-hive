import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadActivity, loadRecord, savedPrs, savedWork } from '../src/state-guards.js';
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

test('a saved usage keeps its valid parts; one saved before the breakdown loads as one part with no stage and no agent; an invalid part is dropped, never the record, and what it held joins the part before the breakdown (#617)', () => {
  const total = { tokens: 30, ms: 600, waitingMs: 60 };
  const spec = { stage: 'spec', agent: 'claude', tokens: 20, ms: 400, waitingMs: 40 };
  const free = { agent: 'codex', tokens: 10, ms: 100, waitingMs: 10 };
  const checks = { stage: 'checks', tokens: 0, ms: 100, waitingMs: 10 };
  const saved = (usage: unknown) => loadRecord({ id: 'r', taskIds: ['I1'], sessions: [], usage })?.usage;
  assert.deepEqual(saved({ ...total, parts: [spec, free, checks] }), { ...total, parts: [spec, free, checks] });
  assert.deepEqual(saved(total), { ...total, parts: [total] }, 'before the breakdown: the whole total, neither stage nor agent');
  const bad = [{ ...spec, tokens: -1 }, { ...spec, ms: '5' }, { ...spec, stage: 7 }, { ...spec, agent: 'gpt' }, null, 'x'];
  assert.deepEqual(saved({ ...total, parts: [spec, ...bad] }), { ...total, parts: [spec, { tokens: 10, ms: 200, waitingMs: 20 }] }, 'what the dropped parts held reads as before the breakdown, so the parts add up to the total');
  assert.deepEqual(saved({ tokens: 0, ms: 0, waitingMs: 0 }), { tokens: 0, ms: 0, waitingMs: 0, parts: [] }, 'nothing recorded: no empty line');
});

test('savedWork keeps a run pick only in the shape the start route writes: a malformed field drops alone, none left is no pick (#290)', () => {
  const SESSION = 'aaaaaaaa-1111-4111-8111-111111111111';
  const pick = { agent: 'codex', resume: SESSION, launch: { model: 'gpt-5.6-terra', args: ['--verbose'] } };
  assert.deepEqual(savedWork({ runPick: pick }).runPick, pick);
  assert.deepEqual(savedWork({ runPick: { resume: null } }).runPick, { resume: null });
  assert.deepEqual(savedWork({ runPick: { agent: 'codex', resume: '--settings' } }).runPick, { agent: 'codex' }, 'a resume that is not a uuid never reaches --resume');
  assert.equal('runPick' in savedWork({ runPick: { agent: 'gemini', launch: { model: '-x' } } }), false);
  assert.equal('runPick' in savedWork({ runPick: 'x' }), false);
});

test('savedWork keeps a failed setup\'s rows only in the shape the reducer writes, field by field; one malformed row drops them all (#390)', () => {
  const rows = [
    { kind: 'worktree', status: 'done', durationMs: 900 }, { kind: 'branch', status: 'done', branch: 'hive/1-x', base: 'origin/main' },
    { kind: 'step', status: 'failed', label: 'pnpm install', header: 'RUN pnpm install', durationMs: 40, code: '1' },
  ];
  const lastSetup = { consoleId: 'setup:board:1', rows };
  assert.deepEqual(savedWork({ lastSetup }).lastSetup, lastSetup);
  assert.deepEqual(savedWork({ lastSetup: { ...lastSetup, rows: [{ ...rows[0], extra: 'x' }] } }).lastSetup?.rows, [rows[0]], 'an unknown key is not copied');
  for (const bad of [{ ...rows[0], kind: 'deploy' }, { ...rows[0], status: 'skipped' }, { ...rows[0], durationMs: -1 }, { ...rows[2], code: 1 }, { ...rows[0], startedAt: 'yesterday' }, 'x']) {
    assert.equal('lastSetup' in savedWork({ lastSetup: { ...lastSetup, rows: [bad, ...rows.slice(1)] } }), false, JSON.stringify(bad));
  }
  assert.equal('lastSetup' in savedWork({ lastSetup: { rows } }), false, 'no console id');
  assert.equal('lastSetup' in savedWork({ lastSetup: { consoleId: 'setup:board:1', rows: [] } }), false, 'no rows');
});

test('an evaluation in flight round-trips so the boot can stop it; a malformed one reads as none (#877)', () => {
  const evaluate = { stage: 'eval', runId: 'r1', workerId: 'w1', startedAt: '2026-10-21T10:00:00.000Z', phase: 'judging' as const };
  assert.deepEqual(savedWork({ evaluate }).evaluate, evaluate);
  assert.equal(savedWork({ evaluate: { ...evaluate, phase: 'sleeping' } }).evaluate, undefined);
  assert.equal(savedWork({ evaluate: { stage: 'eval' } }).evaluate, undefined);
  assert.equal(savedWork({ evaluate: { ...evaluate, startedAt: 'yesterday' } }).evaluate, undefined);
});
