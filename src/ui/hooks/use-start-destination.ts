import { useState } from 'react';
import { inFlow } from '../../tasks';
import type { State, Task } from '../../types';
import type { HeldTask } from '@/hooks/use-pending-task';
import { defaultDestination, type Destination, destinationFlows, effectiveStage, type StartMode } from '@/lib/start-flow';

/** The Start dialog's destination (#580): shown while its task has no stage or the create row holds a source entry. The choice is kept per
 * pick or held entry, so another one starts from decision 5's default (the dialog remembers no last destination, decision 6). `effective`
 * is the task as every stage reader sees it: its own stage, else the chosen flow's entry (decision 10). */
export function useStartDestination(state: State, task: Task | undefined, held: HeldTask | undefined, initialMode: StartMode) {
  const isHeld = held !== undefined;
  const isShown = isHeld || (task !== undefined && !inFlow(task));
  const offered = destinationFlows(state.flows, held?.source);
  const key = held === undefined ? task?.item.itemId : `${held.source}\n${held.title}`;
  const [chosen, setChosen] = useState<{ key?: string; destination: Destination }>();
  const destination = chosen !== undefined && chosen.key === key ? chosen.destination : defaultDestination(offered, initialMode, isHeld);
  const stage = isHeld ? undefined : effectiveStage(task, destination, offered);
  const effective = task === undefined || stage === task.stage ? task : { ...task, stage };
  return {
    isShown, offered, allowsNone: !isHeld, destination, effective,
    entry: effectiveStage(undefined, destination, offered), // the chosen flow's entry: the move-to's stage, the held entry's create stage
    isNone: isShown && !isHeld && destination === 'none', // a held entry with no flow to enter is not sem fluxo: it cannot start at all
    choose: (next: Destination): void => setChosen({ key, destination: next }),
  };
}
