import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import type { RunningDaemon } from '../../src/benchmark/daemon.js';
import { readMarker, writeMarker } from '../../src/benchmark/run-mode.js';
import type { DaemonAddress } from '../../src/daemon.js';
import { type BenchmarkRunRoutes, registerBenchmarkRunRoutes } from '../../src/server-benchmark-run.js';
import type { BenchRunStatus } from '../../src/types.js';
import { fakeLog } from '../fakes.js';
import { tempDir } from '../temp-dir.js';
import { experiment, fakeChild, run, runMarker, stateWith } from './fixtures.js';

const RUN_SECRET = 'b'.repeat(64);
const LIVE_SECRET = 'c'.repeat(64);
const LIVE_PORT = 5000;

interface Harness { base: string; routes: BenchmarkRunRoutes; homes: Record<string, string>; booted: { home: string; frozen?: boolean }[]; stopped: string[]; lines: string[] }

// The open route alone on a bare express app. Each run's home is a temp folder holding its marker. `up` lists the runs whose daemon answers;
// boot records the marker as the daemon would read it and answers ports from 6001 on
async function harness(t: TestContext, statuses: Record<string, BenchRunStatus>, opts: { up?: string[]; failBoot?: boolean } = {}): Promise<Harness> {
  const dir = await tempDir(t, 'bench-runs-');
  const homes: Record<string, string> = Object.fromEntries(Object.keys(statuses).map((token) => [token, join(dir, token)]));
  for (const [token, home] of Object.entries(homes)) {
    await mkdir(home);
    await writeMarker(home, runMarker({ token }));
  }
  const runs = Object.entries(statuses).map(([token, status]) => run(token, { status, home: homes[token] }));
  const state = stateWith(experiment({ status: 'running', rounds: [{ n: 1, runs }] }));
  const up = new Map<string, DaemonAddress>((opts.up ?? []).map((token) => [homes[token], { port: LIVE_PORT, secret: LIVE_SECRET }]));
  const booted: Harness['booted'] = [];
  const stopped: string[] = [];
  let port = 6000;
  const { log, lines } = fakeLog();
  const app = express();
  const routes = registerBenchmarkRunRoutes(app, {
    getState: () => state, log,
    address: async (home) => up.get(home),
    boot: async (home): Promise<RunningDaemon> => {
      booted.push({ home, frozen: (await readMarker(home))?.frozen });
      if (opts.failBoot) throw new Error('the daemon exited with 1');
      port += 1;
      return { home, address: { port, secret: RUN_SECRET }, child: fakeChild().child };
    },
    stop: async (daemon) => { stopped.push(daemon.home); },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, routes, homes, booted, stopped, lines };
}

async function open(h: Harness, token: string, id = 'exp-1'): Promise<{ status: number; body: unknown; cookie: string | null }> {
  const res = await fetch(`${h.base}/benchmark/experiments/${id}/runs/${token}/open`, { method: 'POST' });
  return { status: res.status, cookie: res.headers.get('set-cookie'), body: await res.json() };
}
const attributes = (cookie: string | null): Set<string> => new Set((cookie ?? '').split('; '));

test('an ended run with no daemon is flipped to frozen, booted, and answered with its port and the run port\'s cookie on the same answer (#475)', async (t) => {
  const h = await harness(t, { aaaa1: 'done' });
  const answer = await open(h, 'aaaa1');
  assert.deepEqual([answer.status, answer.body], [200, { port: 6001 }]);
  assert.deepEqual(h.booted, [{ home: h.homes.aaaa1, frozen: true }], 'the marker is frozen before the daemon reads it');
  assert.deepEqual(attributes(answer.cookie), new Set([`hive_secret_6001=${RUN_SECRET}`, 'Path=/', 'HttpOnly', 'SameSite=Strict']), 'host-only: no Domain');
});

test('a run whose daemon answers gets that port and secret without a boot, whatever its status (#475)', async (t) => {
  const h = await harness(t, { aaaa1: 'running', bbbb1: 'done' }, { up: ['aaaa1', 'bbbb1'] });
  for (const token of ['aaaa1', 'bbbb1']) {
    const answer = await open(h, token);
    assert.deepEqual([answer.status, answer.body], [200, { port: LIVE_PORT }], token);
    assert.ok(attributes(answer.cookie).has(`hive_secret_${LIVE_PORT}=${LIVE_SECRET}`));
  }
  assert.deepEqual([h.booted, (await readMarker(h.homes.bbbb1))?.frozen], [[], false]);
});

test('opening a second ended run stops the frozen daemon held for the first; close() stops the one still held (#475)', async (t) => {
  const h = await harness(t, { aaaa1: 'done', bbbb1: 'timeout' });
  assert.equal((await open(h, 'aaaa1')).status, 200);
  assert.deepEqual(h.stopped, []);
  assert.deepEqual((await open(h, 'bbbb1')).body, { port: 6002 });
  assert.deepEqual(h.stopped, [h.homes.aaaa1]);
  await h.routes.close();
  assert.deepEqual(h.stopped, [h.homes.aaaa1, h.homes.bbbb1]);
  await h.routes.close();
  assert.equal(h.stopped.length, 2, 'a second close stops nothing twice');
});

test('a queued run is 409 not-started, a live status with no daemon 409 unreachable, an unknown or malformed experiment or token 404; none boots (#475)', async (t) => {
  const h = await harness(t, { aaaa1: 'queued', bbbb1: 'running', cccc1: 'waiting', dddd1: 'sleeping' });
  assert.deepEqual([(await open(h, 'aaaa1')).status, (await open(h, 'aaaa1')).body], [409, { error: 'not-started' }]);
  for (const token of ['bbbb1', 'cccc1', 'dddd1']) assert.deepEqual((await open(h, token)).body, { error: 'unreachable' }, token);
  assert.deepEqual(await open(h, 'aaaa1', 'nope'), { status: 404, cookie: null, body: { error: 'no such experiment' } });
  assert.deepEqual(await open(h, 'Bad%20Id', 'exp-1'), { status: 404, cookie: null, body: { error: 'no such run in this experiment' } });
  assert.deepEqual((await open(h, 'zzzz9')).body, { error: 'no such run in this experiment' });
  assert.deepEqual(h.booted, []);
});

test('a boot that fails answers 502 boot with no cookie and logs the experiment and the error (#475)', async (t) => {
  const h = await harness(t, { aaaa1: 'error' }, { failBoot: true });
  assert.deepEqual(await open(h, 'aaaa1'), { status: 502, cookie: null, body: { error: 'boot' } });
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /^ERROR benchmark exp-1: .*the daemon exited with 1/);
});
