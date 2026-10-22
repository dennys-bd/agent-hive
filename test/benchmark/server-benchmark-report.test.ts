import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { aggregate } from '../../src/benchmark/report.js';
import { renderReport, writeReport } from '../../src/benchmark/report-md.js';
import { registerBenchmarkReportRoutes } from '../../src/server-benchmark-report.js';
import type { HiveEvent } from '../../src/types.js';
import { fakeLog } from '../fakes.js';
import { tempDir } from '../temp-dir.js';
import { experiment, run, stateWith } from './fixtures.js';

const PATH = '/benchmark/experiments/exp-1';
const NO_EXPERIMENT = { error: 'no such experiment' };
const NO_RUN = { error: 'no such run in this experiment' };
const INTERVENTION = { at: '2026-10-21T11:00:00.000Z', action: 'POST /tasks', detail: '', by: 'user' as const };
const EXP = experiment({ status: 'done', rounds: [{ n: 1, runs: [run('aaaa1', { status: 'done' }), run('bbbb1', { armId: 'a2', status: 'done', interventions: [INTERVENTION] })] }] });

interface Harness { base: string; dispatched: HiveEvent[]; written: [string, string][]; lines: string[] }
// The report routes alone on a bare express app, as test/server-blockers.test.ts builds its own: the state injected, every event in
// `dispatched`, writeReport recorded, or failing as a disk would
function routes(t: TestContext, failWrite = false): Harness {
  const dispatched: HiveEvent[] = [];
  const written: [string, string][] = [];
  const { log, lines } = fakeLog();
  const app = express();
  app.use(express.json());
  registerBenchmarkReportRoutes(app, {
    getState: () => stateWith(EXP),
    dispatch: async (event) => { dispatched.push(event); },
    hiveDir: '/hive',
    writeReport: async (dir, e) => {
      if (failWrite) throw new Error(`EACCES: permission denied, open '${dir}/report.md'`);
      written.push([dir, e.id]);
    },
    log,
  });
  const server = app.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dispatched, written, lines };
}

async function call(base: string, path: string, init?: RequestInit): Promise<[number, unknown]> {
  const res = await fetch(`${base}${path}`, init);
  return [res.status, res.status === 204 ? undefined : await res.json()];
}

test('GET …/report answers the aggregate, in by default and out when asked; another filter is a 400, an unknown or malformed id a 404 (#476)', async (t) => {
  const h = routes(t);
  const [status, body] = await call(h.base, `${PATH}/report`);
  assert.equal(status, 200);
  assert.deepEqual(body, JSON.parse(JSON.stringify(aggregate(EXP, 'in', Date.now()))));
  const [outStatus, out] = await call(h.base, `${PATH}/report?filter=out`);
  assert.deepEqual([outStatus, (out as { filter: string }).filter, (out as { intervened: { inMedian: boolean }[] }).intervened[0].inMedian], [200, 'out', false]);
  for (const query of ['?filter=all', '?filter=in&filter=out']) assert.deepEqual(await call(h.base, `${PATH}/report${query}`), [400, { error: 'filter must be in or out' }], query);
  assert.deepEqual(await call(h.base, '/benchmark/experiments/nope/report'), [404, NO_EXPERIMENT]);
  assert.deepEqual(await call(h.base, '/benchmark/experiments/Bad%20Id/report'), [404, NO_EXPERIMENT]);
  assert.deepEqual(h.dispatched, []);
});

test('GET …/report.md writes report.md into the experiment folder through writeReport and answers its text as a markdown download; unknown is a 404 that writes nothing (#476)', async (t) => {
  const h = routes(t);
  const res = await fetch(`${h.base}${PATH}/report.md`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="report.md"');
  assert.equal(await res.text(), renderReport(EXP, aggregate(EXP, 'in', Date.now())));
  assert.deepEqual(h.written, [[join('/hive', 'benchmark', 'exp-1'), 'exp-1']]);
  assert.deepEqual(await call(h.base, '/benchmark/experiments/nope/report.md'), [404, NO_EXPERIMENT]);
  assert.equal(h.written.length, 1);
});

test('a report.md that cannot be written answers 500 and logs the experiment id, never the report (#476)', async (t) => {
  const h = routes(t, true);
  assert.deepEqual(await call(h.base, `${PATH}/report.md`), [500, { error: 'report.md could not be written' }]);
  assert.ok(h.lines.some((l) => l.startsWith('ERROR') && l.includes('exp-1')), 'the experiment id reaches hive.log');
  assert.equal(h.lines.some((l) => l.includes('aaaa1') || l.includes('bbbb1')), false, 'no token of the report does');
});

test('PATCH …/runs/:token with { inMedian } dispatches benchmarkRunChanged and answers 204; another body is a 400, an unknown experiment or token a 404, and none dispatches (#476)', async (t) => {
  const h = routes(t);
  const patch = (path: string, body: unknown) => call(h.base, path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepEqual(await patch(`${PATH}/runs/bbbb1`, { inMedian: false }), [204, undefined]);
  assert.deepEqual(await patch(`${PATH}/runs/aaaa1`, { inMedian: true }), [204, undefined]);
  assert.deepEqual(h.dispatched, [
    { type: 'benchmarkRunChanged', id: 'exp-1', token: 'bbbb1', patch: { inMedian: false } },
    { type: 'benchmarkRunChanged', id: 'exp-1', token: 'aaaa1', patch: { inMedian: true } },
  ]);
  for (const body of [{}, { inMedian: 'yes' }, { inMedian: null }, { inMedian: true, status: 'done' }, [true]]) {
    assert.deepEqual(await patch(`${PATH}/runs/aaaa1`, body), [400, { error: 'the body must be { inMedian: boolean }' }], JSON.stringify(body));
  }
  assert.deepEqual(await patch('/benchmark/experiments/nope/runs/aaaa1', { inMedian: true }), [404, NO_EXPERIMENT]);
  assert.deepEqual(await patch(`${PATH}/runs/zzzz9`, { inMedian: true }), [404, NO_RUN]);
  assert.deepEqual(await patch(`${PATH}/runs/AAAA1`, { inMedian: true }), [404, NO_RUN], 'a token BENCH_TOKEN refuses names no run');
  assert.equal(h.dispatched.length, 2);
});

// writeReport's own I/O, here and not in report.test.ts, which stays free of I/O
test('writeReport writes <dir>/report.md whole, as renderReport renders the aggregate with in (#476)', async (t) => {
  const dir = await tempDir(t, 'bench-report-');
  const now = Date.parse('2026-10-22T09:00:00.000Z');
  await writeReport(dir, EXP, now);
  assert.equal(await readFile(join(dir, 'report.md'), 'utf8'), renderReport(EXP, aggregate(EXP, 'in', now)));
});
