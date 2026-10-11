import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { initialState } from '../src/orchestrator.js';
import { registerRetryRoute } from '../src/server-retry.js';
import type { TaskRouteDeps } from '../src/server-tasks.js';
import { transitionKey } from '../src/transitions.js';
import type { Activity, HiveEvent, Item, Stage, State, Task, Transition } from '../src/types.js';
import { withWork } from './fixtures/work.js';

// POST /tasks/:id/retry (#915) alone over a state: every dispatched event is recorded rather than reduced.

const ID = 'board:1';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const TASK: Task = { item, stage: 'checks', boardColumn: 'Checks', auto: true, workspace: 'hive' };
const STAGES: Stage[] = [
  { name: 'checks', from: { board: ['Checks'] }, action: 'commands', commands: ['build'] },
  { name: 'fix', from: { board: ['Fix'] }, prompt: '/fix {url}' },
];
const RETRY: Transition = { from: 'checks', to: 'fix', when: 'verdict', verdict: 'failed', maxTries: 3 };
const HALTED: Partial<Activity> = { stopped: true, error: 'tries out: verdict:failed · 3', tries: { [transitionKey(RETRY)]: 3 } };

interface Setup { work?: Partial<Activity>; transitions?: Transition[]; task?: Task }

async function route(t: TestContext, { work = HALTED, transitions = [RETRY], task = TASK }: Setup = {}) {
  const state: State = withWork({ ...initialState(0), stages: STAGES, transitions, tasks: [task] }, ID, work);
  const events: HiveEvent[] = [];
  const app = express();
  const dispatch = async (event: HiveEvent): Promise<never[]> => { events.push(event); return []; };
  registerRetryRoute(app, { requireLive: (() => ({ state })) as unknown as TaskRouteDeps['requireLive'], dispatch });
  const server = app.listen(0);
  t.after(() => server.close());
  const post = async (id: string): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST' });
    return { status: res.status, body: await res.json() };
  };
  return { post, events };
}

test('POST /tasks/:id/retry dispatches one retry for a task stopped with TRIES_OUT and answers ok (#915)', async (t) => {
  const { post, events } = await route(t);
  assert.deepEqual(await post(ID), { status: 200, body: { ok: true } });
  assert.deepEqual(events, [{ type: 'retry', taskId: ID }]);
});

test('POST /tasks/:id/retry answers 404 for an unknown task and 409 when it is missing, not out of tries, its transition is gone or a run holds it, dispatching nothing (#915)', async (t) => {
  const unknown = await route(t);
  assert.equal((await unknown.post('board:nope')).status, 404);
  assert.deepEqual(unknown.events, []);
  const cases: [string, Setup][] = [
    ['tarefa sumiu do source: feche ou mantenha', { task: { ...TASK, missing: true } }],
    ['tarefa não parou por falta de tentativas', { work: { ...HALTED, error: 'no transition: verdict:failed' } }],
    ['tarefa não parou por falta de tentativas', { work: {} }],
    ['a transição que esgotou as tentativas não existe mais', { transitions: [] }],
    ['tarefa já está executando', { work: { ...HALTED, workerId: 'w1' } }],
  ];
  for (const [error, setup] of cases) {
    const refused = await route(t, setup);
    assert.deepEqual(await refused.post(ID), { status: 409, body: { error } });
    assert.deepEqual(refused.events, []);
  }
});
