import { flowOf } from './flows.js';
import { entryStage, stageOf } from './tasks.js';
import type { Flow, Stage, Task } from './types.js';

// #861: where a task of a deleted stage goes, shared by the reducer (setStages) and Settings' confirmation. Pure, and every name is post-rename:
// renameStages runs first, and the UI renames its saved stages before calling it. #565: only inside the deleted stage's own flow, so a save never
// moves a task into another flow.

/** In the new flow that keeps a stage of the deleted one's old flow: the stage that pulls the task's column at its source; else the nearest
 * surviving stage before `deleted`, so adjacent deletions meet on one survivor; else the first after it. Undefined when no stage of that flow
 * survives, or when no old flow holds `deleted`. */
export function destinationOf(task: Pick<Task, 'item' | 'boardColumn'>, deleted: string, oldFlows: readonly Flow[], newFlows: readonly Flow[]): Stage | undefined {
  const old = flowOf(oldFlows, deleted)?.stages ?? [];
  const flow = old.map((s) => flowOf(newFlows, s.name)).find((f) => f !== undefined); // by its surviving stages: a renamed flow is the same flow
  if (flow === undefined) return undefined;
  const pulled = entryStage(flow.stages, task.item.source, task.boardColumn);
  if (pulled !== undefined) return pulled;
  const at = old.findIndex((s) => s.name === deleted);
  const survivor = (list: readonly Stage[]): Stage | undefined => list.map((s) => stageOf(flow.stages, s.name)).find((s) => s !== undefined);
  return survivor([...old.slice(0, at)].reverse()) ?? survivor(old.slice(at + 1));
}
