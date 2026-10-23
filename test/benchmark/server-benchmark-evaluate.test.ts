import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { evaluableTokens } from '../../src/benchmark/report.js';
import { registerBenchmarkEvaluateRoutes } from '../../src/server-benchmark-evaluate.js';
import type { BenchRunStatus, State } from '../../src/types.js';
import { fakeLog } from '../fakes.js';
import { tempDir } from '../temp-dir.js';
import { experiment, run, stateWith } from './fixtures.js';

const EXP = experiment({ rounds: [
  { n: 2, runs: [run('bbbb2', { round: 2, armId: 'a2', status: 'error' }), run('bbbb1', { round: 2, status: 'done' })] },
  { n: 1, runs: [run('aaaa2', { armId: 'a2', status: 'timeout' }), run('aaaa1', { status: 'done' }), run('aaaa3', { status: 'interrupted' })] },
  { n: 3, runs: [run('cccc1', { round: 3, status: 'running' })] },
] });

function routes(t: TestContext, state: State, busy: string[] = []) {
  const calls: [string, string[], boolean][] = [];
  const app = express();
  app.use(express.json());
  registerBenchmarkEvaluateRoutes(app, {
    requireLive: () => ({ state }), log: fakeLog().log,
    evaluator: { evaluate: async (id, tokens, markRounds = false) => { calls.push([id, [...tokens], markRounds]); }, isEvaluating: (token) => busy.includes(token) },
  });
  const server = app.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/benchmark/experiments`, calls };
}
const post = async (url: string): Promise<[number, unknown]> => {
  const res = await fetch(url, { method: 'POST' });
  return [res.status, await res.json()];
};

test('the run route answers 202 and starts the evaluation of an ended run (#474)', async (t) => {
  const h = routes(t, stateWith(EXP));
  assert.deepEqual(await post(`${h.base}/exp-1/runs/aaaa2/evaluate`), [202, { tokens: ['aaaa2'] }]);
  assert.deepEqual(h.calls, [['exp-1', ['aaaa2'], false]]);
});

test('the run route answers 409 while the run has not ended or is being evaluated, and 404 for an unknown experiment or token (#474)', async (t) => {
  for (const status of ['queued', 'running', 'waiting', 'sleeping'] as BenchRunStatus[]) {
    const h = routes(t, stateWith(experiment({ rounds: [{ n: 1, runs: [run('aaaa1', { status })] }] })));
    assert.deepEqual(await post(`${h.base}/exp-1/runs/aaaa1/evaluate`), [409, { error: 'the run has not ended' }], status);
    assert.deepEqual(h.calls, [], status);
  }
  const busy = routes(t, stateWith(EXP), ['aaaa1']);
  assert.deepEqual(await post(`${busy.base}/exp-1/runs/aaaa1/evaluate`), [409, { error: 'the run is being evaluated' }]);
  assert.deepEqual((await post(`${busy.base}/nope/runs/aaaa1/evaluate`))[0], 404);
  assert.deepEqual(await post(`${busy.base}/exp-1/runs/zzzz9/evaluate`), [404, { error: 'unknown run' }]);
  assert.deepEqual(busy.calls, []);
});

test('the experiment route evaluates every ended run in round then arm order, and answers 409 when one of them is being evaluated, 404 for an unknown id (#474)', async (t) => {
  assert.deepEqual(evaluableTokens(EXP), ['aaaa1', 'aaaa2', 'bbbb1', 'bbbb2']);
  const h = routes(t, stateWith(EXP));
  assert.deepEqual(await post(`${h.base}/exp-1/evaluate`), [202, { tokens: ['aaaa1', 'aaaa2', 'bbbb1', 'bbbb2'] }]);
  assert.deepEqual(h.calls, [['exp-1', ['aaaa1', 'aaaa2', 'bbbb1', 'bbbb2'], true]]);
  const busy = routes(t, stateWith(EXP), ['bbbb1']);
  assert.deepEqual(await post(`${busy.base}/exp-1/evaluate`), [409, { error: 'a run of this experiment is being evaluated' }]);
  assert.deepEqual(await post(`${busy.base}/nope/evaluate`), [404, { error: 'unknown experiment' }]);
  assert.deepEqual(busy.calls, []);
});

test('the experiment route with no ended run answers 202 with no token (#474)', async (t) => {
  const h = routes(t, stateWith(experiment()));
  assert.deepEqual(await post(`${h.base}/exp-1/evaluate`), [202, { tokens: [] }]);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('the screenshot route serves a listed png from the run\'s eval/screens and answers 404 for a name not listed, with / or .., a missing file or an unknown run (#466)', async (t) => {
  const home = await tempDir(t, 'shots-');
  const screens = join(home, 'eval', 'screens');
  await mkdir(screens, { recursive: true });
  await writeFile(join(screens, 'S1-1.png'), PNG);
  await writeFile(join(screens, 'S9-1.png'), PNG); // on disk but not listed: never served
  const evaluation = {
    at: '2026-10-21T03:30:00.000Z', collectors: [],
    scenarios: [{ id: 'S1', passed: 1, total: 1, screenshots: ['S1-1.png', 'S1-2.png'] }], // S1-2.png is listed but was never written
    judge: { agent: 'claude' as const, rubricHash: 'r'.repeat(64), scores: [] },
  };
  const h = routes(t, stateWith(experiment({ rounds: [{ n: 1, runs: [run('aaaa1', { status: 'done', home, evaluation })] }] })));
  const res = await fetch(`${h.base}/exp-1/runs/aaaa1/screens/S1-1.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  for (const path of [
    'exp-1/runs/aaaa1/screens/S9-1.png', // not listed
    'exp-1/runs/aaaa1/screens/..%2Feval%2Fscreens%2FS1-1.png', // a slash once decoded
    'exp-1/runs/aaaa1/screens/..png', // .. and not listed
    'exp-1/runs/aaaa1/screens/S1-2.png', // listed, missing on disk
    'exp-1/runs/zzzz9/screens/S1-1.png', // unknown run
  ]) assert.equal((await fetch(`${h.base}/${path}`)).status, 404, path);
  assert.deepEqual(await (await fetch(`${h.base}/nope/runs/aaaa1/screens/S1-1.png`)).json(), { error: 'unknown experiment' });
});
