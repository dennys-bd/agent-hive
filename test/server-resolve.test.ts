import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBasePrompt } from '../src/merge-prompt.js';
import type { Deliver } from '../src/review-deliver.js';
import { fakeSpawn } from './fakes.js';
import { SESSION_A, SESSION_B, send, startReviews } from './review-server.js';

const RESOLVE = '/tasks/local%3A1/resolve';
const BUSY = 'the session is showing a prompt';

// Task 1 of startReviews with session A resumed in a live run; deliver is a fake that records each call and refuses the sessions in `failing`
async function startLive(t: TestContext) {
  const delivered: { taskId: string; to: string; text: string }[] = [];
  const failing = new Set<string>();
  const deliverReview: Deliver = async (taskId, to, text) => {
    delivered.push({ taskId, to, text });
    return failing.has(to) ? { ok: false, reason: BUSY } : { ok: true, session: to };
  };
  const { spawn } = fakeSpawn();
  const hive = await startReviews(t, { launchPty: spawn, deliverReview });
  assert.equal((await send(hive.base, 'POST', '/tasks/local%3A1/open', { kind: 'claude', continueId: SESSION_A })).status, 200);
  assert.ok(hive.server.getState()!.workers.some((w) => w.sessionId === SESSION_A && w.status !== 'empty' && w.runId !== undefined), 'session A runs');
  return { ...hive, delivered, failing };
}

test('resolve pastes the merge-from-base text, rendered on the workspace\'s base remote, into the live session it names (#379)', async (t) => {
  const { base, delivered } = await startLive(t);
  const res = await send(base, 'POST', RESOLVE, { to: SESSION_A, promptBase: 'main' });
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(delivered, [{ taskId: 'local:1', to: SESSION_A, text: mergeBasePrompt('main') }]);
});

test('a delivery deliver refuses answers 409 with its reason (#379)', async (t) => {
  const { base, failing } = await startLive(t);
  failing.add(SESSION_A);
  const res = await send(base, 'POST', RESOLVE, { to: SESSION_A, promptBase: 'main' });
  assert.deepEqual([res.status, await res.json()], [409, { error: BUSY }]);
});

test('a stopped session, a new one, no session, a bad promptBase or an unknown task is refused and delivers nothing (#379)', async (t) => {
  const { base, delivered } = await startLive(t);
  const cases: [string, unknown, number][] = [
    [RESOLVE, { to: SESSION_B, promptBase: 'main' }, 400],
    [RESOLVE, { to: 'new', promptBase: 'main' }, 400],
    [RESOLVE, { promptBase: 'main' }, 400],
    [RESOLVE, { to: SESSION_A, promptBase: '-x' }, 400],
    ['/tasks/nope/resolve', { to: SESSION_A, promptBase: 'main' }, 404],
  ];
  for (const [path, body, status] of cases) assert.equal((await send(base, 'POST', path, body)).status, status, `${path} ${JSON.stringify(body)}`);
  assert.deepEqual(delivered, []);
});
