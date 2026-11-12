// The hive target of the decomposition's routes (#783): what the preview answers of it and, below, the POST that writes the tree as hive
// tasks. server-decomposition.ts imports this file; it imports only types back, so there is no runtime cycle.
import { ORIGIN_TAKEN_MESSAGE } from './create-task.js';
import { recordedIssues } from './decomposition.js';
import { checkoutPreview, type DeliveryRead, OffGithubError } from './decomposition-deliver.js';
import { hiveEntries, originTaken, suggestedEntry } from './decomposition-write-hive.js';
import type { Goal } from './server-decomposition.js';
import type { DecompositionHive, State } from './types.js';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// decision 4: a hive goal is the root of its own tree; any other goal gets a root task made from it
const isHiveGoal = (goal: Goal): boolean => goal.task.item.source === undefined;

// Decision 5: no checkout, or one off GitHub, keeps the file local under the hive; its path is the one in the checkout off GitHub, else the
// one the result names. Every other refusal is the GitHub target's. Nothing once pr is recorded (read is then undefined)
function hiveDelivery(goal: Goal, read: DeliveryRead | undefined): Pick<DecompositionHive, 'delivery' | 'deliveryRefusal'> {
  if (read === undefined) return {};
  if ('delivery' in read) return checkoutPreview(read.delivery, recordedIssues(goal.result));
  if (read.error instanceof OffGithubError) return { delivery: { path: read.error.path ?? String(goal.result.decomposition), local: true } };
  return { deliveryRefusal: errorMessage(read.error) };
}

/** The preview's hive part (#783, decisions 1 to 5 and 9). */
export function hivePreview(state: State, goal: Goal, read: DeliveryRead | undefined): DecompositionHive {
  const nodes = goal.parsed.decomposition?.nodes;
  const entry = suggestedEntry(state, goal.task);
  return {
    entries: hiveEntries(state.flows), ...(entry === undefined ? {} : { entry }),
    tasks: nodes === undefined ? 0 : nodes.length + (isHiveGoal(goal) ? 0 : 1),
    ...(isHiveGoal(goal) ? { preselected: true as const } : {}),
    ...hiveDelivery(goal, read),
    ...(originTaken(state, goal.task, recordedIssues(goal.result)) ? { refusal: ORIGIN_TAKEN_MESSAGE } : {}),
  };
}
