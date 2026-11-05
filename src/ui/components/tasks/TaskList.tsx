import { useState } from 'react';
import type { State } from '../../../types.js';
import { FlowHeader } from '@/components/FlowHeader';
import type { SourcesNav } from '@/components/FlowSources';
import { useIsFlowShown } from '@/components/MainDock';
import { displayProps } from '@/components/tasks/DisplayPopover';
import { TaskListGroup } from '@/components/tasks/TaskListGroup';
import { LIST_COLUMNS } from '@/components/tasks/TaskListRow';
import type { DisplayControls } from '@/hooks/use-flow-view';
import { type MessageKey, t } from '@/i18n';
import { readFlowView, toggleListGroup } from '@/lib/flow-view';
import { listGroups } from '@/lib/task-list';
import { hasTree } from '@/lib/tree-groups';

const COLUMNS: readonly MessageKey[] = ['tasks.list.col.task', 'tasks.list.col.stage', 'tasks.list.col.status', 'tasks.list.col.source', 'tasks.list.col.action'];

export interface TaskListProps { state: State; display: DisplayControls; sources?: SourcesNav }

/** todas em lista (#577, handoff §6): the tasks header with exibir minus its voltas rows and buscar tarefas, then one table with a group per
 * flow and sem fluxo. The search is session-only, as the flowchart's; the collapsed groups persist in flowView (decision 4). */
export function TaskList({ state, display, sources }: TaskListProps) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState(() => readFlowView().listCollapsed);
  const isShown = useIsFlowShown();
  const isTree = display.options.tree ?? hasTree(state.tasks);
  const groups = listGroups(state, display.options, search);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FlowHeader state={state} search={search} onSearch={setSearch} isShown={isShown} {...displayProps({ display, sources, tasks: state.tasks, isTree, hasLoops: false })} />
      <div className="m-3.5 flex min-h-0 flex-1 flex-col overflow-auto rounded-[10px] border">
        <table aria-label={t('tasks.sidebar.list')} className="block w-full">
          <thead className="sticky top-0 z-10 block">
            <tr className="grid h-[34px] items-center gap-3 border-b bg-card px-3 text-muted-foreground text-xs" style={{ gridTemplateColumns: LIST_COLUMNS }}>
              {COLUMNS.map((key) => <th key={key} className="min-w-0 truncate text-left font-normal">{t(key)}</th>)}
            </tr>
          </thead>
          {groups.map((group) => (
            <TaskListGroup
              key={`group:${group.key}`} group={group} state={state} isCollapsed={collapsed.includes(group.key)}
              onToggle={() => setCollapsed(toggleListGroup(group.key))}
            />
          ))}
        </table>
      </div>
    </div>
  );
}
