import type { Express, Request, Response } from 'express';
import { resultOf } from './activities.js';
import { activityParam, taskTarget } from './activity-routes.js';
import { answerable } from './transitions.js';
import { taskWorkspace } from './config.js';
import { workspaceBase } from './fork.js';
import { PROMPT_MESSAGE, promptText } from './merge-prompt.js';
import { decompositionPending } from './decomposition.js';
import { withoutControls } from './pty-paste.js';
import type { TaskRouteDeps, Refusal } from './server-tasks.js';
import { type Config, type Task, FEEDBACK_MAX, type HiveEvent, type State, type Trigger } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
export const NOT_AWAITING_MESSAGE = 'tarefa não aguarda aprovação';
const NOT_HELD_MESSAGE = 'aprovação sem sessão aberta';
const FEEDBACK_MESSAGE = `feedback precisa ser texto de 1 a ${FEEDBACK_MAX} caracteres`;
const START_MESSAGE = 'start precisa ser true ou false';
// #134: an answer no transition takes would leave the task with nowhere to go; the reducer keeps it awaiting, the route says why
type UserTrigger = Extract<Trigger, 'approved' | 'feedback'>;
const NO_EXIT_MESSAGE: Record<UserTrigger, string> = { approved: 'nenhuma transição sai desta etapa ao aprovar', feedback: 'nenhuma transição sai desta etapa com feedback' };
/** Start, Continue and Restart on a task awaiting approval (#268): the user approves or sends feedback instead. */
export const AWAITING_MESSAGE = 'tarefa aguarda aprovação: aprove ou envie feedback';
/** Aprovar on a task whose decomposition is not on GitHub yet (#865): criar issues writes it and ends the stage itself. */
export const DECOMPOSITION_MESSAGE = 'a decomposição ainda não foi escrita no GitHub: use criar issues';

const refuse = (res: Response, refusal: Refusal): void => {
  res.status(refusal.status).json({ error: refusal.message });
};

// The task a route acts on (#268): a live task activity's (#629), awaiting approval, and with a held session when `held` asks for one.
function awaiting(state: State, activityId: string, held: boolean): Task | Refusal {
  const target = taskTarget(state, activityId);
  if ('status' in target) return target;
  const { approval } = target.activity;
  if (!approval) return { status: HTTP_CONFLICT, message: NOT_AWAITING_MESSAGE };
  return held && approval.until === undefined ? { status: HTTP_CONFLICT, message: NOT_HELD_MESSAGE } : target.task;
}

// The feedback the body asks for, or why not: its text, or the prompt a key names (#379: mergeBase, rendered on the task's base remote as
// the open route renders it), never both; without control characters, trimmed, 1 to FEEDBACK_MAX characters; start a boolean. Every task
// awaiting approval takes it, manual gates included (#685).
function feedbackEvent(activityId: string, body: unknown, task: Task, _state: State, config: Pick<Config, 'comb' | 'baseBranch'>): HiveEvent | Refusal {
  const { text, prompt, promptBase, start } = (body ?? {}) as Record<string, unknown>;
  const asked = promptText(prompt, promptBase, workspaceBase(config, taskWorkspace(config, task)).remote);
  if ('refused' in asked || (asked.text !== undefined && text !== undefined)) return { status: HTTP_BAD_REQUEST, message: PROMPT_MESSAGE };
  const given = asked.text ?? text;
  const trimmed = typeof given === 'string' ? withoutControls(given).trim() : '';
  if (trimmed === '' || trimmed.length > FEEDBACK_MAX) return { status: HTTP_BAD_REQUEST, message: FEEDBACK_MESSAGE };
  if (typeof start !== 'boolean') return { status: HTTP_BAD_REQUEST, message: START_MESSAGE };
  return { type: 'feedback', activityId, text: trimmed, start };
}

// Aprovar (#268), unless the stage's decomposition still has to be written (#865): approving would end it with nothing on GitHub, from
// whichever door the approve came (the detail, a menu, the flow's button, the search). With no GitHub source there is nowhere to write it
function approveEvent(activityId: string, task: Task, state: State, config: Pick<Config, 'comb'>): HiveEvent | Refusal {
  const hasGithub = config.comb.sources.some((s) => s.type === 'github');
  if (hasGithub && decompositionPending(resultOf(state, task.item.itemId))) return { status: HTTP_CONFLICT, message: DECOMPOSITION_MESSAGE };
  return { type: 'approve', activityId };
}

/** Aprovar, feedback and Estender on a task awaiting approval (#268): checked here, decided by the reducer (a held worker answers its Stop). */
export function registerApprovalRoutes(app: Express, { requireLive, dispatch }: Pick<TaskRouteDeps, 'requireLive' | 'dispatch'>): void {
  type Answer = (activityId: string, body: unknown, task: Task, state: State, config: Pick<Config, 'comb' | 'baseBranch'>) => HiveEvent | Refusal;
  const route = (path: string, held: boolean, event: Answer, trigger?: UserTrigger): void => {
    app.post(`/activities/:id/${path}`, async (req: Request, res: Response) => {
      const current = requireLive(res);
      if (!current) return;
      const activityId = activityParam(req);
      const checked = awaiting(current.state, activityId, held);
      if ('status' in checked) return refuse(res, checked);
      if (trigger !== undefined && !answerable(current.state, checked, trigger)) return refuse(res, { status: HTTP_CONFLICT, message: NO_EXIT_MESSAGE[trigger] });
      const next = event(activityId, req.body, checked, current.state, current.runtime.config);
      if ('status' in next) return refuse(res, next);
      await dispatch(next);
      res.json({ ok: true });
    });
  };
  route('approve', false, (activityId, _body, task, state, config) => approveEvent(activityId, task, state, config), 'approved');
  route('feedback', false, feedbackEvent, 'feedback');
  route('approval/extend', true, (activityId) => ({ type: 'extendApproval', activityId }));
}
