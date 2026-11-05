import { useId, useState } from 'react';
import { activityOf } from '../../../activities.js';
import { inFlow } from '../../../tasks.js';
import type { State, Task } from '../../../types.js';
import { viewedTasks, WorkspacesLegend } from '@/components/Flow';
import { FlowHeader } from '@/components/FlowHeader';
import type { SourcesNav } from '@/components/FlowSources';
import { useIsFlowShown } from '@/components/MainDock';
import { MenuBoundaryContext } from '@/components/TaskMenu';
import { displayProps } from '@/components/tasks/DisplayPopover';
import { OutsideCard } from '@/components/tasks/OutsideCard';
import type { DisplayControls } from '@/hooks/use-flow-view';
import { t } from '@/i18n';
import { matchesSearch } from '@/lib/flow-search';
import type { DisplayOptions } from '@/lib/flow-view';
import { taskState } from '@/lib/task-state';
import { hasTree } from '@/lib/tree-groups';

// Decisions 2, 3: the stageless tasks (counted: exibir's counts, before sourcesOff, as the flowchart's), then what the view and the search
// leave, in the Hive's order, split by the card's own new mark (#727), which is also what keeps a task past the listing (#568)
function outsideTasks(state: State, options: Pick<DisplayOptions, 'sourcesOff' | 'epics'>, search: string) {
  const counted = state.tasks.filter((c) => !inFlow(c));
  const shown = viewedTasks(state.tasks, counted, options).filter((c) => matchesSearch(c, activityOf(state, c.item.itemId)?.branch ?? '', search));
  const isNew = (c: Task): boolean => taskState(c, state) === 'new';
  return { counted, shown, started: shown.filter((c) => !isNew(c)), fresh: shown.filter(isNew) };
}

interface GroupProps { kind: 'started' | 'new'; tasks: readonly Task[]; state: State; selectedId?: string; onOpen?(taskId: string): void }

// Decision 4: the screen's .m-head, its name in 500, its count, its hint pushed right; decision 5: no card, no group
function Group({ kind, tasks, state, selectedId, onOpen }: GroupProps) {
  const id = useId();
  if (tasks.length === 0) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <h3 id={id} className="font-medium text-foreground">{t(`tasks.outside.${kind}`)}</h3>
        <span>{tasks.length}</span>
        <span className="ml-auto">{t(`tasks.outside.${kind}Hint`)}</span>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
        {tasks.map((c) => <OutsideCard key={c.item.itemId} task={c} state={state} isSelected={c.item.itemId === selectedId} onOpen={onOpen} />)}
      </ul>
    </section>
  );
}

interface OutsideFlowProps { state: State; selectedId?: string; onOpen?(taskId: string): void; display: DisplayControls; sources?: SourcesNav }

/** Tasks outside the flow (#578, handoff §7): the tasks header with exibir minus its voltas rows and the search, then the started and the new
 * tasks as two grids of cards, or one muted line with none; the workspaces legend bottom right. The grid is its card menus' collision boundary. */
export function OutsideFlow({ state, selectedId, onOpen, display, sources }: OutsideFlowProps) {
  const [search, setSearch] = useState(''); // session-only, as the flowchart's (#542)
  const [boundary, setBoundary] = useState<HTMLElement | null>(null);
  const isShown = useIsFlowShown();
  const { counted, shown, started, fresh } = outsideTasks(state, display.options, search);
  const isTree = display.options.tree ?? hasTree(state.tasks);
  const groupOf = (kind: GroupProps['kind'], tasks: readonly Task[]) => <Group kind={kind} tasks={tasks} state={state} selectedId={selectedId} onOpen={onOpen} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FlowHeader state={state} search={search} onSearch={setSearch} isShown={isShown} {...displayProps({ display, sources, tasks: counted, isTree, hasLoops: false })} />
      <MenuBoundaryContext.Provider value={boundary}>
        <section ref={setBoundary} aria-label={t('tasks.sidebar.outside')} className="relative flex min-h-0 flex-1 flex-col bg-background">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-3.5 py-3">
            {shown.length === 0 ? <p className="text-muted-foreground text-xs">{t('tasks.outside.empty')}</p> : <>{groupOf('started', started)}{groupOf('new', fresh)}</>}
          </div>
          <WorkspacesLegend state={state} tasks={shown} />
        </section>
      </MenuBoundaryContext.Provider>
    </div>
  );
}
