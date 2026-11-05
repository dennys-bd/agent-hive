// Where a new task enters (#670): its source's entry property among the stages that accept its column, else the column's door. Out of tasks.ts,
// past 400 lines. Pure. tasks.ts imports this module and this one imports tasks.ts: neither calls the other at load time, as out-of-listing.ts does
import type { WorkState } from './activities.js';
import { flatten } from './flows.js';
import { enter, entryStage, inFlow, isStarted, leave, onSource } from './tasks.js';
import type { Flow, SourceItem, Stage, Task } from './types.js';

const accepts = (stage: Stage, seen: SourceItem): boolean => onSource(stage.from, seen.item.source)?.includes(seen.column) === true;

/** The stage a listed item enters (#670): undefined when its column is no door (no task), null for outside the flow, the entry's stage (a flow
 * alone: its first) when that stage's `from` cites the column, else the column's door. An item with no entry (a local one) gets the door. */
export function entryFor(flows: readonly Flow[], seen: SourceItem): Stage | null | undefined {
  const door = entryStage(flatten(flows).stages, seen.item.source, seen.column);
  if (door === undefined) return undefined; // the column stays the door (decision 4): outside the flow needs one too
  const { entry } = seen.item;
  if (entry === null) return null;
  if (entry === undefined) return door;
  const flow = flows.find((f) => f.name === entry.flow);
  const picked = entry.stage === undefined ? flow?.stages[0] : flow?.stages.find((s) => s.name === entry.stage);
  return picked !== undefined && accepts(picked, seen) ? picked : door;
}

/** A task the entry property still places (#670, decisions 8–9): new (no activity), not placed by hand, not created in the Hive (its stage was
 * explicit), not orphan or leaving, and not an epic (followEpics owns its stage). */
export const placesAgain = (task: Task, runs: WorkState): boolean =>
  !isStarted(runs, task) && !task.placedByHand && !task.created && !task.orphan && !task.leaving && task.item.epic === undefined;

/** A new task placed again (#670): another stage enters it, null takes it out of the flow, undefined (no door now) keeps it where it is. */
export function placed(task: Task, entry: Stage | null | undefined): Task {
  if (entry === undefined) return task;
  if (entry === null) return inFlow(task) ? leave(task) : task;
  return entry.name === task.stage ? task : enter(task, entry);
}
