import type { PrData, State, Task } from '../../types';
import { PrBlock } from '@/components/PrBlock';
import { PrWithoutActivity } from '@/components/PrWithoutActivity';
import { TaskPrList } from '@/components/TaskPrList';

const BLOCK = 'flex flex-col gap-4 text-xs'; // #64: a block of the details panel's slot, which draws the frame

export interface PrPropertiesProps {
  pr: PrData; task?: Task; state: State;
  drafts: number; // #68: the review popover's pending drafts, as the tab bar's
  onGoTo(taskId: string): void; // #68: in the flow's task ›
  onReloaded(): void; // #68: the page reads the PR again after a review is sent
  onOpenIssue(url: string): void; // #66: a closing issue's page, or GitHub
  onOpenPr(url: string): void; // #66: another PR of the task's page, or GitHub
}

/** The PR page's properties (#758, handoff 03), a block of the details panel's slot (#64): a task PR shows the this PR box and the task's other
 * PRs (#66); a PR no task holds, the PR without activity (#68). The task issue's own fields are the issue page's (#65), never the PR's. */
export function PrProperties({ pr, task, state, drafts, onGoTo, onReloaded, onOpenIssue, onOpenPr }: PrPropertiesProps) {
  if (task === undefined) return <PrWithoutActivity pr={pr} state={state} drafts={drafts} onReloaded={onReloaded} onGoTo={onGoTo} onOpenIssue={onOpenIssue} />;
  return (
    <div className={BLOCK}>
      <PrBlock pr={pr} task={task} state={state} onOpenIssue={onOpenIssue} />
      <TaskPrList task={task} state={state} except={pr.url} onOpenPr={onOpenPr} />
    </div>
  );
}
