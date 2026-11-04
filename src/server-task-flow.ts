import type { Express, Request, Response } from 'express';
import { UNKNOWN_STAGE_MESSAGE } from './create-task.js';
import { beforeRefusal, MISSING_MESSAGE, type Refusal, refuse, RUNNING_MESSAGE, type TaskRouteDeps, UNKNOWN_TASK_MESSAGE } from './server-tasks.js';
import { canMoveToStage, stageOf } from './tasks.js';
import type { HiveEvent, State, Task } from './types.js';

// A task's place in the flows by hand (#164, #366, #566): move-to and leave-flow. Out of server-tasks.ts, past 400 lines.

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_BAD_REQUEST = 400;
const DROP_MESSAGE = 'drop precisa ser um objeto, com before em texto'; // #366: a drag's placement on move-to
const SAME_STAGE_MESSAGE = 'tarefa já está nessa etapa';

/** Why a move to `stage` would be a no-op in the reducer (#164, #366); the task and the stage already exist. A drop's `before` must be a
 * task of that stage: the drop line only ever shows between the target's tasks. */
function moveToRefusal(state: State, task: Task, stage: string, before?: string): Refusal | undefined {
  if (task.missing) return { status: HTTP_CONFLICT, message: MISSING_MESSAGE };
  if (!canMoveToStage(task, state)) return { status: HTTP_CONFLICT, message: RUNNING_MESSAGE }; // its stage run holds it, or it is leaving (#286)
  if (stage === task.stage) return { status: HTTP_CONFLICT, message: SAME_STAGE_MESSAGE };
  return before === undefined ? undefined : beforeRefusal(state, before, stage);
}

/** A drag's placement on move-to (#366). */
type Drop = NonNullable<Extract<HiveEvent, { type: 'moveToStage' }>['drop']>;

// The body's `drop`: undefined for right-click → move to, else an object whose `before`, when present, is a task id; `false` when malformed.
// Rebuilt from the checked fields, so nothing else in the body reaches the reducer.
function dropOf(raw: unknown): Drop | undefined | false {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const { before } = raw as { before?: unknown };
  if (before === undefined) return {};
  return typeof before === 'string' ? { before } : false;
}

export function registerFlowRoutes(app: Express, { requireLive, dispatch }: TaskRouteDeps): void {
  app.post('/tasks/:id/move-to', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const taskId = req.params.id as string;
    const { stage, drop: raw } = (req.body ?? {}) as { stage?: unknown; drop?: unknown };
    const task = current.state.tasks.find((c) => c.item.itemId === taskId);
    if (!task) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_TASK_MESSAGE });
    if (typeof stage !== 'string' || stageOf(current.state.stages, stage) === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: UNKNOWN_STAGE_MESSAGE });
    const drop = dropOf(raw);
    if (drop === false) return refuse(res, { status: HTTP_BAD_REQUEST, message: DROP_MESSAGE });
    const refusal = moveToRefusal(current.state, task, stage, drop?.before);
    if (refusal) return refuse(res, refusal);
    await dispatch({ type: 'moveToStage', taskId, stage, ...(drop ? { drop } : {}) });
    res.json({ ok: true });
  });
}
