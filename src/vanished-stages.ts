import { activityOf, withActivity } from './activities.js';
import { releaseRun, releaseWorker, withTask } from './reducer-kit.js';
import { haltCi } from './stage-ci.js';
import { destinationOf } from './stage-delete.js';
import { enter, inAction, stageOf, taskId } from './tasks.js';
import { haltGone } from './transit.js';
import type { Activity, Effect, Stage, State, Task, Worker } from './types.js';

// The tasks of the stages a setStages removes (#861), placed before the new stages land: out of orchestrator.ts, which is past 400 lines.
// Pure: new objects only.

/** The state with every task of a vanished stage placed; `before`, what settleEntries compares against, so a held task's plain rewrite reads as
 * no entry; and the effects a held Stop's end emits. */
export interface Placed { state: State; before: Task[]; effects: Effect[] }

// A Stop held for approval (#268) already came: its run ends now with no decision, as approvalExpired ends one, and the task halts
function endHold(state: State, moved: Task, live: Activity, worker: Worker & { runId: string }, gone: string): Pick<Placed, 'state' | 'effects'> {
  const { workerId: _workerId, approval: _approval, ...rest } = live;
  const freed = releaseRun({ ...withActivity(state, rest), workers: releaseWorker(state.workers, worker) }, worker, Date.now());
  return { state: haltGone(freed, moved, gone).state, effects: [{ type: 'release', ptyId: worker.runId }, { type: 'kill', slug: live.slug ?? '', ptyId: worker.runId }] };
}

// A task a worker or a stage action holds: a plain rewrite of its stage and entry, no enter, so no gate, action or onStart fires mid-run. A
// worker's run is marked stageGone and halts at its Stop; a wait for CI holds no process and its stage is gone, so it halts now
function placeHeld(acc: Placed, task: Task, to: Stage): Placed {
  const moved: Task = { ...task, stage: to.name, enteredAt: new Date().toISOString() };
  const before = acc.before.map((c) => (taskId(c) === taskId(task) ? moved : c));
  const state = withTask(acc.state, moved);
  const live = activityOf(state, taskId(task));
  if (live === undefined) return { ...acc, state, before };
  if (live.ci !== undefined) return { ...acc, before, state: haltGone(haltCi(state, live.id), moved, task.stage).state };
  const worker = state.workers.find((w) => w.id === live.workerId);
  if (worker?.status === 'approval' && worker.runId !== undefined) {
    const ended = endHold(state, moved, live, { ...worker, runId: worker.runId }, task.stage);
    return { before, state: ended.state, effects: [...acc.effects, ...ended.effects] };
  }
  return { ...acc, before, state: withActivity(state, { ...live, stageGone: task.stage }) };
}

/** Every task whose stage `stages` lacks, placed in destinationOf's stage (#861): a stopped one enters it as a move by hand would, keeping its
 * activity (setStages' settleEntries and gates follow); a held one through placeHeld. The old stages are still `state.stages`. With no stage at
 * all the task is left where it is: the save refuses an empty flow. */
export function placeVanished(state: State, stages: Stage[]): Placed {
  return state.tasks.reduce<Placed>((acc, task) => {
    if (stageOf(stages, task.stage) !== undefined) return acc;
    const to = destinationOf(task, task.stage, state.stages, stages);
    if (to === undefined) return acc;
    const live = activityOf(acc.state, taskId(task));
    const isHeld = live?.workerId !== undefined || inAction(live);
    return isHeld ? placeHeld(acc, task, to) : { state: withTask(acc.state, enter(task, to)), before: acc.before, effects: acc.effects };
  }, { state, before: state.tasks, effects: [] });
}
