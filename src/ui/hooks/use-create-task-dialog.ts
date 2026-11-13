import { createContext, createElement, type ReactNode, useState } from 'react';
import type { State } from '../../types.js';
import { CreateTaskDialog } from '@/components/CreateTaskDialog';

/** What the create-task dialog opens with (#774): ⌘P's term and the shown activity's workspace, or a source header's source. */
export interface CreateTaskRequest { title?: string; workspace?: string; source?: string }

/** How a source header opens the dialog (#774, decision 11): the header renders under the Dashboard's center, not as a dock child that takes
 * props. Undefined outside the dock (a header alone, a test): the header shows no button. */
export const CreateTaskOpenContext = createContext<((request: CreateTaskRequest) => void) | undefined>(undefined);

interface CreateTaskDialogArgs { workspaces: string[]; flows?: State['flows']; sourceWorkspaces?: Record<string, string>; onOpenTask(taskId: string): void }

const NO_FLOWS: State['flows'] = [];
const NO_SOURCE_WORKSPACES: Record<string, string> = {};

/** The create-task dialog's open state, beside the Start dialog's newIn (#774, decision 1), so MainDock stays under the file limit. provide()
 * wraps the dock's tree in the context and renders the dialog after it while open, built from the dock's own props (decision 2). */
export function useCreateTaskDialog({ workspaces, flows = NO_FLOWS, sourceWorkspaces = NO_SOURCE_WORKSPACES, onOpenTask }: CreateTaskDialogArgs): { open(request: CreateTaskRequest): void; provide(children: ReactNode): ReactNode } {
  const [request, setRequest] = useState<CreateTaskRequest>();
  const dialog = request && createElement(CreateTaskDialog, { ...request, state: { workspaces, flows, sourceWorkspaces }, onOpenTask, onClose: () => setRequest(undefined) });
  const provide = (children: ReactNode): ReactNode => createElement(CreateTaskOpenContext.Provider, { value: setRequest }, children, dialog);
  return { open: setRequest, provide };
}
