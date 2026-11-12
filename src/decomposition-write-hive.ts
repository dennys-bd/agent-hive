// A decomposition written as hive tasks (#783): what the route asks of the hive target (the entries `entra em` offers, the suggested one, the
// stage an entry names, an origin already taken), and the write itself. Pure of Node and GitHub: the route checks the body and delivers.
import { ROOT_KEY } from './decomposition.js';
import { flowOf } from './flows.js';
import { exitOf } from './transitions.js';
import { END, type Flow, type State, type Task, type TaskEntry } from './types.js';

/** What `entra em` offers (#783, decision 2): outside the flow, then each flow followed by each of its stages. */
export const hiveEntries = (flows: readonly Flow[]): TaskEntry[] =>
  [null, ...flows.flatMap((f): TaskEntry[] => [{ flow: f.name }, ...f.stages.map((s) => ({ flow: f.name, stage: s.name }))])];

/** The suggested entry (#783, decision 3): the goal moves by its approve, and an epic follows only children of its own flow, so the children
 * start in the flow its approved exit leads to; that exit being END or absent, the goal's own flow; a goal outside the flow, the first. */
export function suggestedEntry(state: Pick<State, 'flows' | 'stages' | 'transitions'>, goal: Pick<Task, 'stage'>): TaskEntry | undefined {
  const exit = goal.stage === undefined ? undefined : exitOf(state, goal.stage, 'approved');
  const landing = exit === undefined || exit.to === END ? undefined : flowOf(state.flows, exit.to);
  const flow = landing ?? flowOf(state.flows, goal.stage) ?? state.flows[0];
  return flow === undefined ? undefined : { flow: flow.name };
}

/** The stage an entry names (#783, decision 7): createTask takes a stage name. */
export const entryStage = (flows: readonly Flow[], entry: TaskEntry): string | undefined =>
  (entry === null ? undefined : entry.stage ?? flows.find((f) => f.name === entry.flow)?.stages[0]?.name);

/** Whether a GitHub goal's root task would point at an item a hive task already holds (#783, decision 9): adopting it, or a second task on
 * the same item, would both go unseen. Skipped once root is recorded, so the write resumes. */
export const originTaken = (state: Pick<State, 'tasks'>, goal: Task, recorded: Readonly<Record<string, number>>): boolean =>
  goal.item.source !== undefined && recorded[ROOT_KEY] === undefined && state.tasks.some((t) => t.item.origin === goal.item.itemId);
