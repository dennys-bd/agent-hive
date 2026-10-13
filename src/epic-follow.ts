import { activityOf } from './activities.js';
import { withColumnWrite } from './column-write.js';
import { none, type Reduced, settleEntries, shouldWrite, sourceWrites, withTask } from './reducer-kit.js';
import { allDone, depthOf, epicStage } from './task-tree.js';
import { enter, isDue, onSource, stageOf, taskId } from './tasks.js';
import { follow } from './transit.js';
import { exitOf, outgoing } from './transitions.js';
import { END, type Stage, type State, type Task } from './types.js';

// A show epic's stage follows its children (#31): one pass after every event, so whatever moved a child (a poll, a stage end, a move by hand,
// an item re-read) moves its epic in the same reduction. Out of orchestrator.ts, past 400 lines. Pure: a pass that moves nothing returns the
// state itself, which reduce's identity checks rely on.

// Into `target` as a move by hand enters it (moveToStage): the target's first door on the task's source written, marked until a poll shows it
// (#889), and the entry settled
function plainMove(state: State, task: Task, target: Stage): Reduced {
  const [entry] = onSource(target.from, task.item.source) ?? [];
  const write = shouldWrite(task, entry);
  const written = write ? withColumnWrite(task, entry, new Date().toISOString()) : task;
  return {
    state: settleEntries(state.tasks, withTask(state, enter(written, target))),
    effects: write ? [{ type: 'setColumn', itemId: taskId(task), column: entry }] : [],
  };
}

const placedOf = (state: State, task: Task): Task | undefined => state.tasks.find((t) => taskId(t) === taskId(task));

// One move from the epic's stage to `target`, as a child makes one (#213): the first transition configured straight there, in the config's
// order whatever its trigger, its sources written; none, a plain move. The stages in between are never walked. Then the target's onStart,
// which a child's run writes as it starts there and an epic never runs, after those writes (#515). A leaving action holds the epic where it
// was, with no onStart
function moved(state: State, task: Task, target: Stage): Reduced {
  const direct = outgoing(state.transitions, task.stage).find((t) => t.to === target.name);
  const went: Reduced = direct === undefined ? plainMove(state, task, target) : follow(state, task, direct);
  const placed = placedOf(went.state, task);
  if (placed === undefined || placed.stage !== target.name) return went;
  const started = sourceWrites(placed, onSource(target.onStart, placed.item.source));
  return { state: withTask(went.state, started.task), effects: [...went.effects, ...started.effects] };
}

// Out through the last stage's done exit to end once that stage is due (#213): the epic waits its `after` there as any task does. isDue is
// checked on each reduction, not scheduled: the polls keep reductions coming. The stage's own action never runs for it (#31). No such exit, or not due yet: the state itself
function ended(state: State, task: Task, last: Stage): Reduced {
  const exit = exitOf(state, last.name, 'done');
  return exit === undefined || exit.to !== END || !isDue(task, last, Date.now()) ? none(state) : follow(state, task, exit);
}

// Every child done (#213): into the last stage by the same move as any other (In Review → Done writes its move Done), then, in the same
// pass, out through its end once due. Without such an exit it sits in the last stage
function finished(state: State, task: Task, last: Stage): Reduced {
  const into = task.stage === last.name ? none(state) : moved(state, task, last);
  const placed = placedOf(into.state, task);
  if (placed === undefined || placed.stage !== last.name || placed.leaving) return into;
  const out = ended(into.state, placed, last);
  return out.state === into.state ? into : { state: out.state, effects: [...into.effects, ...out.effects] };
}

function followed(state: State, task: Task): Reduced {
  const last = state.stages.at(-1);
  if (last === undefined) return none(state);
  if (allDone(state.tasks, taskId(task), last.name)) return finished(state, task, last);
  const name = epicStage(state.tasks, state.stages, task);
  const target = name === undefined || name === task.stage ? undefined : stageOf(state.stages, name);
  return target === undefined ? none(state) : moved(state, task, target);
}

// A leaving epic waits for its source's answer, a missing one for the user, and one whose source action failed keeps its error: taking the
// exit again would write the same refused action after every event
const follows = (state: State, task: Task): boolean =>
  task.item.epic !== undefined && !task.leaving && !task.missing && activityOf(state, taskId(task))?.error === undefined;

/** Every show epic moved where its children put it (#31), deepest first, so a parent epic reads its sub-epics already moved. reduce runs it
 * after every event. */
export function followEpics(state: State): Reduced {
  const epics = state.tasks.filter((t) => follows(state, t));
  if (epics.length === 0) return none(state);
  const deepestFirst = epics.sort((a, b) => depthOf(state.tasks, taskId(b)) - depthOf(state.tasks, taskId(a))); // `epics` is filter's own copy
  return deepestFirst.reduce<Reduced>((acc, epic) => {
    const current = acc.state.tasks.find((t) => taskId(t) === taskId(epic));
    if (current === undefined) return acc;
    const next = followed(acc.state, current);
    return next.state === acc.state ? acc : { state: next.state, effects: [...acc.effects, ...next.effects] };
  }, none(state));
}
