import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { StartAnswer } from '../../src/benchmark/runner.js';
import type { WakeDeadline } from '../../src/benchmark/runner-sleep.js';
import { registerBenchmarkControlRoutes } from '../../src/server-benchmark-control.js';
import type { BenchmarkEvent, Experiment, ExperimentStatus } from '../../src/types.js';
import { fakeLog } from '../fakes.js';
import { experiment, run, stateWith } from './fixtures.js';

function routes(t: TestContext, exp: Experiment, stub: { live?: boolean; answer?: StartAnswer; leak?: string } = {}) {
  const calls: unknown[][] = [];
  const events: BenchmarkEvent[] = [];
  const app = express();
  app.use(express.json());
  registerBenchmarkControlRoutes(app, {
    requireLive: () => ({ state: stateWith(exp) }), dispatch: async (event) => { events.push(event); }, log: fakeLog().log,
    runner: {
      run: async (id) => { calls.push(['run', id]); return stub.answer ?? 'started'; },
      sleep: async (id, reason, wakeAt) => { calls.push(['sleep', id, reason, wakeAt]); },
      wake: async (id, deadline) => { calls.push(['wake', id, deadline]); },
      isLive: () => stub.live ?? false,
      blindness: async (e) => { calls.push(['blindness', e.pace.pairs]); return stub.leak; },
    },
  });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/benchmark/experiments`;
  const post = async (path: string, body: unknown = {}): Promise<[number, unknown]> => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  return { post, calls, events };
}
const codeOf = ([status, body]: [number, unknown]): [number, string] => [status, (body as { error: string }).error];
const NOTHING_MISSING = experiment({ status: 'done', pace: { ...experiment().pace, pairs: 1 }, rounds: [
  { n: 1, runs: [run('aaaa1', { status: 'done' }), run('aaaa2', { armId: 'a2', status: 'done' })] },
] });

test('run on a draft, or on a done experiment with missing runs, checks the blindness and starts the runner: 202; an unknown experiment is 404 (#472)', async (t) => {
  for (const status of ['draft', 'done'] as ExperimentStatus[]) {
    const h = routes(t, experiment({ status }));
    assert.deepEqual(await h.post('/exp-1/run'), [202, { ok: true }], status);
    assert.deepEqual(h.calls, [['blindness', 3], ['run', 'exp-1']], status);
  }
  const h = routes(t, experiment());
  assert.deepEqual(codeOf(await h.post('/nope/run')), [404, 'unknown_experiment']);
  assert.deepEqual(h.calls, []);
});

test("each route answers 409 when the experiment's status refuses it, and nothing reaches the runner or the state (#472)", async (t) => {
  const cases: [ExperimentStatus, string, unknown][] = [
    ['running', '/run', {}], ['sleeping', '/run', {}], ['draft', '/sleep', { reason: 'night' }], ['sleeping', '/sleep', { reason: 'night' }],
    ['running', '/wake', {}], ['draft', '/wake', {}], ['done', '/wake', {}], ['draft', '/more-rounds', { pairs: 1 }],
    ['draft', '/stop-after-round', {}], ['done', '/stop-after-round', {}],
  ];
  for (const [status, path, body] of cases) {
    const h = routes(t, experiment({ status }));
    assert.deepEqual(codeOf(await h.post(`/exp-1${path}`, body)), [409, 'status'], `${path} while ${status}`);
    assert.deepEqual([h.calls, h.events], [[], []], `${path} while ${status}`);
  }
});

test('run answers 409 with nothing missing, while this Hive runs the experiment, and when another Hive holds its lock (#472)', async (t) => {
  assert.deepEqual(codeOf(await routes(t, NOTHING_MISSING).post('/exp-1/run')), [409, 'nothing_missing']);
  const live = routes(t, experiment(), { live: true });
  assert.deepEqual(codeOf(await live.post('/exp-1/run')), [409, 'live']);
  assert.deepEqual(live.calls, []);
  assert.deepEqual(codeOf(await routes(t, experiment(), { answer: 'locked' }).post('/exp-1/run')), [409, 'locked']);
});

test('a bad body answers 400 and reaches nothing (#472)', async (t) => {
  const cases: [ExperimentStatus, string, unknown][] = [
    ['running', '/more-rounds', {}], ['running', '/more-rounds', { pairs: 0 }], ['running', '/more-rounds', { pairs: 1.5 }], ['running', '/more-rounds', { pairs: '2' }],
    ['running', '/sleep', {}], ['running', '/sleep', { reason: 3 }], ['running', '/sleep', { reason: 'x', wakeAt: '7:00' }], ['running', '/sleep', { reason: 'x', wakeAt: '24:00' }],
    ['sleeping', '/wake', { deadline: 'later' }], ['sleeping', '/wake', { deadline: { until: '25:00' } }],
  ];
  for (const [status, path, body] of cases) {
    const h = routes(t, experiment({ status }));
    assert.deepEqual(codeOf(await h.post(`/exp-1${path}`, body)), [400, 'bad_body'], JSON.stringify(body));
    assert.deepEqual([h.calls, h.events], [[], []], JSON.stringify(body));
  }
});

test('run with a blindness hit answers 422 with the word and where, and starts nothing (#472)', async (t) => {
  const h = routes(t, experiment(), { leak: 'blindness: "benchmark" in task T1' });
  assert.deepEqual(await h.post('/exp-1/run'), [422, { error: 'blindness', message: 'blindness: "benchmark" in task T1' }]);
  assert.deepEqual(h.calls, [['blindness', 3]]);
});

test('stop-after-round dispatches it: 200; more-rounds adds pairs to a live experiment (200) and starts a done one as run does (202) (#472)', async (t) => {
  for (const status of ['running', 'sleeping'] as ExperimentStatus[]) {
    const h = routes(t, experiment({ status }));
    assert.deepEqual(await h.post('/exp-1/stop-after-round'), [200, { ok: true }]);
    assert.deepEqual(h.events, [{ type: 'benchmarkStopAfterRound', id: 'exp-1', on: true }]);
  }
  const running = routes(t, experiment({ status: 'running' }));
  assert.deepEqual(await running.post('/exp-1/more-rounds', { pairs: 2 }), [200, { ok: true }]);
  assert.deepEqual(running.events, [{ type: 'benchmarkEdited', id: 'exp-1', patch: { pace: { ...experiment().pace, pairs: 5 } } }]);
  assert.deepEqual(running.calls, []);
  const done = routes(t, NOTHING_MISSING);
  assert.deepEqual(await done.post('/exp-1/more-rounds', { pairs: 2 }), [202, { ok: true }]);
  assert.deepEqual(done.events, [{ type: 'benchmarkEdited', id: 'exp-1', patch: { pace: { ...NOTHING_MISSING.pace, pairs: 3 } } }]);
  assert.deepEqual(done.calls, [['blindness', 3], ['run', 'exp-1']]);
  const leaking = routes(t, NOTHING_MISSING, { leak: 'blindness: "x" in seed/ref.md' });
  assert.equal((await leaking.post('/exp-1/more-rounds', { pairs: 2 }))[0], 422);
  assert.deepEqual(leaking.events, []);
});

test('sleep hands the reason and wakeAt to the runner: 200; wake hands each deadline, absent included: 202 (#472)', async (t) => {
  const sleeping = routes(t, experiment({ status: 'running' }));
  assert.deepEqual(await sleeping.post('/exp-1/sleep', { reason: 'night', wakeAt: '07:00' }), [200, { ok: true }]);
  assert.deepEqual(await sleeping.post('/exp-1/sleep', { reason: '' }), [200, { ok: true }]);
  assert.deepEqual(sleeping.calls, [['sleep', 'exp-1', 'night', '07:00'], ['sleep', 'exp-1', '', undefined]]);
  const deadlines: (WakeDeadline | undefined)[] = ['finish-round', { until: '09:30' }, 'none', undefined];
  for (const deadline of deadlines) {
    const h = routes(t, experiment({ status: 'sleeping' }));
    assert.deepEqual(await h.post('/exp-1/wake', deadline === undefined ? {} : { deadline }), [202, { ok: true }]);
    assert.deepEqual(h.calls, [['wake', 'exp-1', deadline]]);
  }
});
