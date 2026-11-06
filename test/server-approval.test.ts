import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { initialState } from '../src/orchestrator.js';
import { registerApprovalRoutes } from '../src/server-approval.js';
import type { TaskRouteDeps } from '../src/server-tasks.js';
import type { HiveEvent, Stage, State, Task, TaskApproval, Transition } from '../src/types.js';
import { activityIdOf, withWork } from './fixtures/work.js';
import { flowed } from './fixtures/main-flow.js';

// The approval routes (#268) alone over a hand-built state, as server-decomposition.test.ts registers them: every dispatched event is recorded
// rather than reduced.

const SINCE = '2026-11-06T10:00:00.000Z';
const TASK: Task = { item: { itemId: 'board:I1', id: '1', title: 'Pick the port', body: '', url: '' }, stage: 'Brainstorm', boardColumn: '', auto: true, workspace: 'hive' };
const STAGES: Stage[] = [{ name: 'Brainstorm', from: {}, prompt: '/brainstorm', approval: true, verdicts: ['spike', 'task'] }, { name: 'Spike', from: {}, prompt: '/spike' }];
// #693: only a routed verdict leaves Brainstorm; no approved transition
const ROUTED_ONLY: Transition[] = [{ from: 'Brainstorm', to: 'Spike', when: 'verdict', verdict: 'spike' }];

async function routes(t: TestContext, approval: TaskApproval) {
  const state: State = withWork({ ...initialState(0), ...flowed(STAGES, ROUTED_ONLY), tasks: [TASK] }, TASK.item.itemId, { approval });
  const events: HiveEvent[] = [];
  const app = express();
  app.use(express.json());
  const dispatch = async (event: HiveEvent): Promise<never[]> => { events.push(event); return []; };
  registerApprovalRoutes(app, { requireLive: (() => ({ state, runtime: { config: { comb: { sources: [] } } } })) as unknown as TaskRouteDeps['requireLive'], dispatch });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/activities/${encodeURIComponent(activityIdOf(TASK.item.itemId))}`;
  return { base, events };
}

const post = (url: string): Promise<Response> => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

test('approve answers ok on a stage with only routed verdicts and no approved transition when the approval holds a routed verdict; with none, or an unrouted one, 409 (#693)', async (t) => {
  const routed = await routes(t, { since: SINCE, verdict: 'spike' });
  const ok = await post(`${routed.base}/approve`);
  assert.deepEqual([ok.status, await ok.json(), routed.events.map((e) => e.type)], [200, { ok: true }, ['approve']]);
  for (const approval of [{ since: SINCE }, { since: SINCE, verdict: 'task' }]) {
    const stuck = await routes(t, approval);
    const res = await post(`${stuck.base}/approve`);
    assert.deepEqual([res.status, await res.json(), stuck.events], [409, { error: 'nenhuma transição sai desta etapa ao aprovar' }, []], JSON.stringify(approval));
  }
});
