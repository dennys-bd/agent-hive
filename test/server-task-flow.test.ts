import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { initialState, reduce } from '../src/orchestrator.js';
import { leaveFlowRefusal, registerFlowRoutes } from '../src/server-task-flow.js';
import type { TaskRouteDeps } from '../src/server-tasks.js';
import type { Activity, Effect, HiveEvent, State, Task } from '../src/types.js';
import { flowed } from './fixtures/main-flow.js';
import { withWork } from './fixtures/work.js';

// POST /tasks/:id/leave-flow and the move-to back in (#566) over a state the real reducer moves: the effects a dispatch gave are kept, so a
// source write would show as a setColumn.

const ID = 'board:I1';
const TASK: Task = { item: { itemId: ID, id: '1', title: 'One', body: '', url: '', source: 'board' }, stage: 'fila', boardColumn: 'Ready', auto: true };
const at = (task: Task, work: Partial<Activity> = {}): State => withWork({ ...initialState(0), ...flowed([{ name: 'fila', from: { board: ['Ready'] }, prompt: 'x' }]), tasks: [task] }, ID, work);
const conflict = (error: string) => ({ status: 409, message: error });

test('leaveFlowRefusal answers 409 for a task outside the flow, a missing one, a show epic, one being deleted and one a stage run holds; none for a stopped task (#566)', () => {
  const { stage: _stage, ...outside } = TASK;
  assert.deepEqual(leaveFlowRefusal(at(outside), outside), conflict('already outside the flow'));
  const epic: Task = { ...TASK, item: { ...TASK.item, epic: { follows: 'behind', switchAt: 'fila' } } };
  assert.deepEqual(leaveFlowRefusal(at(epic), epic), conflict("an epic follows its children's stages"));
  assert.deepEqual(leaveFlowRefusal(at(TASK, { deleting: true }), TASK), conflict('atividade sendo excluída'));
  assert.deepEqual(leaveFlowRefusal(at(TASK, { workerId: 'w1' }), TASK), conflict('tarefa já está executando'));
  assert.equal(leaveFlowRefusal(at(TASK), TASK), undefined);
});

async function route(t: TestContext, initial: State) {
  let state = initial;
  const effects: Effect[] = [];
  const dispatch = async (event: HiveEvent): Promise<Effect[]> => {
    const next = reduce(state, event);
    state = next.state;
    effects.push(...next.effects);
    return next.effects;
  };
  const app = express();
  app.use(express.json());
  registerFlowRoutes(app, { requireLive: (() => ({ state })) as unknown as TaskRouteDeps['requireLive'], dispatch } as unknown as TaskRouteDeps);
  const server = app.listen(0);
  t.after(() => server.close());
  const post = async (id: string, action: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/tasks/${encodeURIComponent(id)}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json() };
  };
  return { post, effects, task: (): Task | undefined => state.tasks.find((c) => c.item.itemId === ID) };
}

test('POST /tasks/:id/leave-flow takes a stopped task out of the flow and writes nothing to the source; 404 unknown, 409 already outside or running (#566)', async (t) => {
  const { post, effects, task } = await route(t, at(TASK));
  assert.deepEqual(await post('nope', 'leave-flow'), { status: 404, body: { error: 'tarefa desconhecida' } });
  assert.deepEqual(await post(ID, 'leave-flow'), { status: 200, body: { ok: true } });
  assert.equal(task()?.stage, undefined);
  assert.deepEqual(effects, [], 'no source write');
  assert.deepEqual(await post(ID, 'leave-flow'), { status: 409, body: { error: 'already outside the flow' } });
  assert.deepEqual(await post(ID, 'move-to', { stage: 'fila' }), { status: 200, body: { ok: true } }); // back in from no stage (#566)
  assert.equal(task()?.stage, 'fila');
  const held = await route(t, at(TASK, { workerId: 'w1' }));
  assert.deepEqual(await held.post(ID, 'leave-flow'), { status: 409, body: { error: 'tarefa já está executando' } });
});
