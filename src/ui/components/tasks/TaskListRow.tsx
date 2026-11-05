import { resolveWorkspace, sourceOf, taskLabel } from '../../../tasks.js';
import type { State, Task } from '../../../types.js';
import { ListingLine } from '@/components/FlowTask';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { statusText, t } from '@/i18n';
import { STATUS_DOT, STATUS_TEXT } from '@/lib/status';
import type { ListRow } from '@/lib/task-list';
import { taskState } from '@/lib/task-state';

/** The list's columns (handoff §6): tarefa takes what is left; etapa, status, source and ação fixed. The header row shares it. */
export const LIST_COLUMNS = 'minmax(0,1fr) 140px 160px 120px 96px';
const INDENT_PX = 20; // per tree level, the handoff's (§5 Hierarquia)

export interface TaskListRowProps { row: ListRow; state: State }

// tarefa (decisions 6, 8): the workspace square, ↳ for a child indented by its depth, the title, ⑂ on an epic and the ◌ hint
function TitleCell({ row, state }: TaskListRowProps) {
  const { task, depth, children } = row;
  const workspace = resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks);
  return (
    <td className="flex min-w-0 items-center gap-1.5" style={depth > 0 ? { paddingLeft: depth * INDENT_PX } : undefined}>
      {workspace !== undefined && <WorkspaceSquare name={workspace} title={workspace} />}
      {depth > 0 && <span aria-hidden="true" className="font-mono text-muted-foreground">↳</span>}
      <span className="min-w-0 truncate" title={taskLabel(task)}>{taskLabel(task)}</span>
      {children && <span className="shrink-0 text-muted-foreground text-xs">{`⑂ ${t('flow.tree.children', { n: children.total, done: children.done })}`}</span>}
      <ListingLine task={task} />
    </td>
  );
}

// status (decision 8): the dot and the word in the status colour, new and empty muted
function StatusCell({ task, state }: { task: Task; state: State }) {
  const status = taskState(task, state);
  return (
    <td className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
      <span className={`truncate ${STATUS_TEXT[status]}`}>{statusText(status)}</span>
    </td>
  );
}

/** One row of the list (#577 decision 8): tarefa, etapa (or sem fluxo), status, source and the action. Not draggable: moving between stages
 * stays the flowchart's and the menu's (decision 10). */
export function TaskListRow({ row, state }: TaskListRowProps) {
  const { task } = row;
  return (
    <tr data-task-id={task.item.itemId} style={{ gridTemplateColumns: LIST_COLUMNS }} className="grid h-10 items-center gap-3 border-b px-3 text-[13px] hover:bg-muted">
      <TitleCell row={row} state={state} />
      <td className="min-w-0 truncate text-muted-foreground">{task.stage ?? t('tasks.sidebar.outside')}</td>
      <StatusCell task={task} state={state} />
      <td className="min-w-0 truncate text-muted-foreground">{sourceOf(task)}</td>
      <td />
    </tr>
  );
}
