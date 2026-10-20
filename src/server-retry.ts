import type { Express, Request, Response } from 'express';
import { activityOf } from './activities.js';
import { LEAVING_MESSAGE, MISSING_MESSAGE, type Refusal, refuse, RUNNING_MESSAGE, type TaskRouteDeps, UNKNOWN_TASK_MESSAGE } from './server-tasks.js';
import { canDismissError, canMoveToStage, type WorkersState } from './tasks.js';
import { retryTransition } from './transitions.js';
import { TRIES_OUT, type State, type Task } from './types.js';

// Retry on a task stopped with TRIES_OUT (#915) and the dismiss of a task's error (#354), out of server-tasks.ts, which is past 400 lines.
// The checks answer what the reducer would ignore in silence; a race between the check and the dispatch is a no-op there, never a move it
// should not make.

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const NOT_OUT_OF_TRIES_MESSAGE = 'tarefa não parou por falta de tentativas';
const TRANSITION_GONE_MESSAGE = 'a transição que esgotou as tentativas não existe mais';
const NO_ERROR_MESSAGE = 'tarefa não tem erro';

type Deps = Pick<TaskRouteDeps, 'requireLive' | 'dispatch'>;
type Check = (state: State, taskId: string) => Refusal | undefined;

const taskOf = (state: State, taskId: string): Task | undefined => state.tasks.find((c) => c.item.itemId === taskId);

// What both routes refuse first: unknown, gone from the source, held by a run or leaving. `canAct` is retry's canMoveToStage, as move-to
// asks, or the dismiss's canDismissError, which lets an epic through (#354)
function heldRefusal(state: State, task: Task | undefined, canAct: (task: Task, state: WorkersState) => boolean): Refusal | undefined {
  if (!task) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE };
  if (task.missing) return { status: HTTP_CONFLICT, message: MISSING_MESSAGE };
  if (!canAct(task, state)) return { status: HTTP_CONFLICT, message: task.leaving ? LEAVING_MESSAGE : RUNNING_MESSAGE };
  return undefined;
}

// A retry is also a no-op when the task is not halted with TRIES_OUT, or its transition was removed or renamed since
function retryRefusal(state: State, taskId: string): Refusal | undefined {
  const task = taskOf(state, taskId);
  const held = heldRefusal(state, task, canMoveToStage);
  if (held || !task) return held;
  const error = activityOf(state, taskId)?.error;
  if (retryTransition(state, task, error) !== undefined) return undefined;
  return { status: HTTP_CONFLICT, message: error?.startsWith(TRIES_OUT) === true ? TRANSITION_GONE_MESSAGE : NOT_OUT_OF_TRIES_MESSAGE };
}

// A dismiss is also a no-op on a task with no error
const dismissRefusal: Check = (state, taskId) => heldRefusal(state, taskOf(state, taskId), canDismissError)
  ?? (activityOf(state, taskId)?.error === undefined ? { status: HTTP_CONFLICT, message: NO_ERROR_MESSAGE } : undefined);

// A POST on one task, no body: refused as `check` says, else one event dispatched and `{ ok: true }`
function registerTaskPost(app: Express, { requireLive, dispatch }: Deps, action: string, check: Check, type: 'retry' | 'dismissError'): void {
  app.post(`/tasks/:id/${action}`, async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const taskId = req.params.id as string;
    const refusal = check(current.state, taskId);
    if (refusal) return refuse(res, refusal);
    await dispatch({ type, taskId });
    res.json({ ok: true });
  });
}

/** POST /tasks/:id/retry (#915): no body; one retry dispatched, `{ ok: true }`. */
export const registerRetryRoute = (app: Express, deps: Deps): void => registerTaskPost(app, deps, 'retry', retryRefusal, 'retry');

/** POST /tasks/:id/dismiss-error (#354): no body; one dismissError dispatched, `{ ok: true }`. */
export const registerDismissErrorRoute = (app: Express, deps: Deps): void => registerTaskPost(app, deps, 'dismiss-error', dismissRefusal, 'dismissError');
