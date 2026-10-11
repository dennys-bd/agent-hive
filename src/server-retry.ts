import type { Express, Request, Response } from 'express';
import { activityOf } from './activities.js';
import { LEAVING_MESSAGE, MISSING_MESSAGE, type Refusal, refuse, RUNNING_MESSAGE, type TaskRouteDeps, UNKNOWN_TASK_MESSAGE } from './server-tasks.js';
import { canMoveToStage } from './tasks.js';
import { retryTransition } from './transitions.js';
import { TRIES_OUT, type State } from './types.js';

// Retry on a task stopped with TRIES_OUT (#915), out of server-tasks.ts, which is past 400 lines. The checks answer what the reducer would
// ignore in silence; a race between the check and the dispatch is a no-op there, never a move it should not make.

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const NOT_OUT_OF_TRIES_MESSAGE = 'tarefa não parou por falta de tentativas';
const TRANSITION_GONE_MESSAGE = 'a transição que esgotou as tentativas não existe mais';

// Why a retry would be a no-op in the reducer: unknown, gone from the source, held by a run or leaving (as move-to refuses it), not halted
// with TRIES_OUT, or its transition removed or renamed since
function retryRefusal(state: State, taskId: string): Refusal | undefined {
  const task = state.tasks.find((c) => c.item.itemId === taskId);
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  if (task.missing) return { status: HTTP_CONFLICT, message: MISSING_MESSAGE };
  if (!canMoveToStage(task, state)) return { status: HTTP_CONFLICT, message: task.leaving ? LEAVING_MESSAGE : RUNNING_MESSAGE };
  const error = activityOf(state, taskId)?.error;
  if (retryTransition(state, task, error) === undefined) {
    return { status: HTTP_CONFLICT, message: error?.startsWith(TRIES_OUT) === true ? TRANSITION_GONE_MESSAGE : NOT_OUT_OF_TRIES_MESSAGE };
  }
  return undefined;
}

/** POST /tasks/:id/retry (#915): no body; one retry dispatched, `{ ok: true }`. */
export function registerRetryRoute(app: Express, { requireLive, dispatch }: Pick<TaskRouteDeps, 'requireLive' | 'dispatch'>): void {
  app.post('/tasks/:id/retry', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const taskId = req.params.id as string;
    const refusal = retryRefusal(current.state, taskId);
    if (refusal) return refuse(res, refusal);
    await dispatch({ type: 'retry', taskId });
    res.json({ ok: true });
  });
}
