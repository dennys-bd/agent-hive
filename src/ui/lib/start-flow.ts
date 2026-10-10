// What the Start dialog's run-stages box says (redesign 11): the stages the task goes through from where it sits, and where it stops for the
// user. Derived from the stages as configured; nothing of it is stored.
import type { Stage } from '../../types.js';

/** The stages ahead of a task, its own first, up to the first that awaits approval (included), else to the last; `approval` says which. */
export interface StagePath { next: string[]; stop?: string; approval: boolean }

export function stagePath(stage: string, stages: Stage[]): StagePath {
  const from = stages.findIndex((s) => s.name === stage);
  if (from < 0) return { next: [], approval: false };
  const ahead = stages.slice(from);
  const gate = ahead.findIndex((s) => s.approval === true);
  const next = (gate < 0 ? ahead : ahead.slice(0, gate + 1)).map((s) => s.name);
  return { next, stop: next.at(-1), approval: gate >= 0 };
}

/** Whether executar etapas has anything to run for a task in `stage` (#774): some stage from its own onward, in the configured order, has a
 * prompt or an action. A stage the flow does not have answers true, so startMode alone decides, as before. */
export function hasStagesToRun(stage: string, stages: Stage[]): boolean {
  const from = stages.findIndex((s) => s.name === stage);
  return from < 0 || stages.slice(from).some((s) => s.prompt !== undefined || s.action !== undefined);
}
