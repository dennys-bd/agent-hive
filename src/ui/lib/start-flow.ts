// What the Start dialog's run-stages box says (redesign 11): the stages the task goes through from where it sits, and where it stops for the
// user. Derived from the stages as configured; nothing of it is stored.
import { runsAgent } from '../../stage-agent.js';
import { onSource } from '../../tasks.js';
import type { Flow, Stage, Task } from '../../types.js';

/** The stages ahead of a task, its own first, up to the first that awaits approval (included), else to the last; `approval` says which. */
export interface StagePath { next: string[]; stop?: string; approval: boolean }

export function stagePath(stage: string | undefined, stages: Stage[]): StagePath {
  const from = stages.findIndex((s) => s.name === stage);
  if (from < 0) return { next: [], approval: false };
  const ahead = stages.slice(from);
  const gate = ahead.findIndex((s) => s.approval === true);
  const next = (gate < 0 ? ahead : ahead.slice(0, gate + 1)).map((s) => s.name);
  return { next, stop: next.at(-1), approval: gate >= 0 };
}

/** Whether executar etapas has anything to run for a task in `stage` (#774): some stage from its own onward, in the configured order, has a
 * prompt or an action. A stage the flow does not have answers true; no stage at all answers false, so startMode alone decides, as before. */
export function hasStagesToRun(stage: string | undefined, stages: Stage[]): boolean {
  if (stage === undefined) return false; // #566: a task outside the flow has no stage to run
  const from = stages.findIndex((s) => s.name === stage);
  return from < 0 || stages.slice(from).some((s) => s.prompt !== undefined || s.action !== undefined);
}

/** executar etapas follows the flow, one prompt per stage; sessão livre opens the agent with no automatic prompt (redesign 11). Lives here, not in
 * StartFields, so the plain-node build can read it without the React component. */
export type StartMode = 'stages' | 'free';

/** Where the Start dialog sends a stageless task (#580): a flow, entering at its entry stage, or nowhere. */
export type Destination = { flow: string } | 'none';

/** A flow the destination block offers, with its entry stage. */
export interface DestinationFlow { flow: string; entry: string }

/** The flows a destination can name: each with a stage, entering at its first stage that runs an agent, else its first, so executar etapas
 * has something to run (decision 2, #710); on a source, only those whose entry reads one of its columns, since POST /tasks refuses a source
 * create in a stage that reads none (decision 4). */
export function destinationFlows(flows: readonly Flow[], source?: string): DestinationFlow[] {
  return flows.flatMap(({ name, stages }) => {
    const entry = stages.find(runsAgent) ?? stages[0];
    if (entry === undefined) return [];
    if (source !== undefined && (onSource(entry.from, source)?.length ?? 0) === 0) return [];
    return [{ flow: name, entry: entry.name }];
  });
}

/** Decision 5: a free session moves nothing unless asked; a held source entry needs a flow; otherwise the first flow. */
export function defaultDestination(offered: DestinationFlow[], mode: StartMode, isHeldSource: boolean): Destination {
  const first = offered[0];
  if (first === undefined || (mode === 'free' && !isHeldSource)) return 'none';
  return { flow: first.flow };
}

/** The stage the dialog reads for the task: its own, else the chosen flow's entry, else none (decision 10). */
export function effectiveStage(task: Pick<Task, 'stage'> | undefined, destination: Destination, offered: DestinationFlow[]): string | undefined {
  if (task?.stage !== undefined) return task.stage;
  return destination === 'none' ? undefined : offered.find((f) => f.flow === destination.flow)?.entry;
}
