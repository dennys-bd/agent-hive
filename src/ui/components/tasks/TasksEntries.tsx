import { InboxIcon, ListIcon, WaypointsIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Flow, State } from '../../../types.js';
import type { TasksCenter, TasksView } from '@/hooks/use-tasks-center';
import { t } from '@/i18n';
import { type EntryCount, entryCounts } from '@/lib/tasks-sidebar';

export interface TasksEntriesProps { state: State; center: TasksCenter; show(next: TasksCenter): void }

const ROW = 'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-accent/50 data-[selected]:bg-muted';
const ICON = 'size-4 shrink-0 text-muted-foreground';
const NONE: EntryCount = { total: 0, needsYou: 0 };

interface EntryProps { icon: ReactNode; label: string; count: EntryCount; isSelected: boolean; onClick(): void }

// A row (handoff §4b): the entry's icon, its name, ● N in the waiting colour when some of its tasks wait for the user, and its total
function Entry({ icon, label, count, isSelected, onClick }: EntryProps) {
  return (
    <button type="button" className={ROW} data-selected={isSelected ? '' : undefined} aria-pressed={isSelected} onClick={onClick}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count.needsYou > 0 && <span className="text-signal-yellow text-xs tabular-nums">{`● ${count.needsYou}`}</span>}
      <span className="w-6 text-right text-muted-foreground text-xs tabular-nums">{count.total}</span>
    </button>
  );
}

// Decision 11: a flow center with no flow named shows the first flow, so that row is the selected one
const isFlowShown = (center: TasksCenter, flows: readonly Flow[], name: string): boolean =>
  center.kind === 'tasks' && center.view === 'flow' && (center.flow ?? flows[0]?.name) === name;

/** The tasks section (#572, decision 8): todas em lista, one row per flow in the state's order, sem fluxo, each opening its view. */
export function TasksEntries({ state, center, show }: TasksEntriesProps) {
  const counts = entryCounts(state);
  const isView = (view: TasksView): boolean => center.kind === 'tasks' && center.view === view;
  return (
    <div className="flex flex-col gap-0.5">
      <Entry icon={<ListIcon aria-hidden="true" className={ICON} />} label={t('tasks.sidebar.list')} count={counts.all} isSelected={isView('list')} onClick={() => show({ kind: 'tasks', view: 'list' })} />
      {state.flows.map((flow) => (
        <Entry
          key={flow.name} icon={<WaypointsIcon aria-hidden="true" className={ICON} />} label={flow.name} count={counts.flows[flow.name] ?? NONE}
          isSelected={isFlowShown(center, state.flows, flow.name)} onClick={() => show({ kind: 'tasks', view: 'flow', flow: flow.name })}
        />
      ))}
      <Entry icon={<InboxIcon aria-hidden="true" className={ICON} />} label={t('tasks.sidebar.outside')} count={counts.outside} isSelected={isView('outside')} onClick={() => show({ kind: 'tasks', view: 'outside' })} />
    </div>
  );
}
