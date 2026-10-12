import { entryStage, stageOf } from './tasks.js';
import type { Stage, Task } from './types.js';

// #861: where a task of a deleted stage goes, shared by the reducer (setStages) and Settings' confirmation. Pure, and every name is post-rename:
// renameStages runs first, and the UI renames its saved stages before calling it.

/** The stage that pulls the task's column at its source; else the nearest stage before `deleted` in `oldStages` that `newStages` still has
 * (so adjacent deletions meet on one survivor); else the first after it; else the new flow's first. Undefined only with no stage at all. */
export function destinationOf(task: Pick<Task, 'item' | 'boardColumn'>, deleted: string, oldStages: readonly Pick<Stage, 'name'>[], newStages: Stage[]): Stage | undefined {
  const pulled = entryStage(newStages, task.item.source, task.boardColumn);
  if (pulled !== undefined) return pulled;
  const at = oldStages.findIndex((s) => s.name === deleted);
  const survivor = (list: readonly Pick<Stage, 'name'>[]): Stage | undefined => list.map((s) => stageOf(newStages, s.name)).find((s) => s !== undefined);
  const before = at < 0 ? undefined : survivor([...oldStages.slice(0, at)].reverse());
  return before ?? survivor(oldStages.slice(at + 1)) ?? newStages[0];
}
