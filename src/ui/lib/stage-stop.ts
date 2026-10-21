import type { Activity } from '../../types.js';

/** Where a stage run's Stop posts (#755, #834, #877): a commands stage's command through its pty; a wait for CI and an evaluation, which hold
 * none, through their own routes. Undefined with no stage run in flight. One rule for the running block, the card's menu and the bar. */
export function stageStopPath(activity: Activity): string | undefined {
  const id = encodeURIComponent(activity.id);
  if (activity.commands !== undefined) return `/ptys/${encodeURIComponent(activity.commands.ptyId)}/stop`;
  if (activity.ci !== undefined) return `/activities/${id}/ci/stop`;
  return activity.evaluate === undefined ? undefined : `/activities/${id}/evaluate/stop`;
}
