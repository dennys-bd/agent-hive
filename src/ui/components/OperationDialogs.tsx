import { useState } from 'react';
import { openFeedbackSession } from '../../task-runs';
import type { Task, State } from '../../types';
import { FeedbackDialog } from '@/components/ApprovalActions';
import { deleteActivityMessage } from '@/components/DetailMenu';
import { DeleteActivity, taskDeletionUrl } from '@/components/DeleteActivity';
import { RestartDialog } from '@/components/RestartDialog';
import { SleepAllConfirm } from '@/components/SleepMenu';
import type { OperationDialog } from '@/lib/operations';
import { answerableActivity } from '@/lib/task-state';

// excluir atividade…'s confirm (#542), mounted past its own close as the menus keep it: a refusal opens DeleteActivity's second popup with
// git's words
function DeleteConfirm({ task, state }: { task: Task; state: State }) {
  const [isOpen, setIsOpen] = useState(true);
  return <DeleteActivity url={taskDeletionUrl(task, state)} message={deleteActivityMessage(task, state)} available confirm={{ open: isOpen, onOpenChange: setIsOpen }} />;
}

interface OperationDialogsProps { dialog: OperationDialog; state: State; onStarted?(taskId: string): void; onClose(): void }

/** The confirm an operation opens (#584): the same component its menu item opens, shown once the search has closed. */
export function OperationDialogs({ dialog, state, onStarted, onClose }: OperationDialogsProps) {
  if (dialog.kind === 'sleep') return <SleepAllConfirm activity={dialog.activity} runs={dialog.runs} onClose={onClose} />;
  const itemId = dialog.task.item.itemId;
  if (dialog.kind === 'restart') return <RestartDialog task={dialog.task} state={state} onStarted={() => onStarted?.(itemId)} onClose={onClose} />;
  if (dialog.kind === 'feedback') return <FeedbackDialog activity={answerableActivity(dialog.task, state)} openSession={openFeedbackSession(dialog.task, state) !== undefined} onClose={onClose} />;
  return <DeleteConfirm task={dialog.task} state={state} />;
}
