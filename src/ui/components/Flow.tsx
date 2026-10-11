import { useRef, useState } from 'react';
import { activityOf } from '../../activities';
import { sourceOf } from '../../tasks';
import type { FilterRule, Stage, State, Task } from '../../types';
import { FlowChart } from '@/components/FlowChart';
import { FlowHeader, type SourceTabs } from '@/components/FlowHeader';
import { FlowListPanel } from '@/components/FlowListPanel';
import { FlowNode } from '@/components/FlowNode';
import { useIsFlowShown } from '@/components/MainDock';
import { StageFilterDialog, useStageFilters } from '@/components/StageFilter';
import type { Dragging } from '@/components/task-drag';
import { MenuBoundaryContext } from '@/components/TaskMenu';
import { t } from '@/i18n';
import { matchesSearch } from '@/lib/flow-search';
import { type FlowView, readFlowView, writeFlowView } from '@/lib/flow-view';
import { visibleUnderFilter } from '@/lib/stage-filters';

interface FlowProps { state: State; source?: string; selectedId?: string; onOpen?(taskId: string): void; tabs?: SourceTabs; stageCaps?: Record<string, number> } // source: the flow sidebar's pick (redesign 09); selectedId: the detail panel's task (#542); tabs: the source header's, with an external source picked (#756); stageCaps: the effective caps, which a node shows as n/cap (#727)

/** What a stage shows (#374, #542, #665): its tasks in the Hive's order, those of the picked source, those the view filter lets through, and
 * those the search lets through after it. */
export function stageTasks(state: State, stage: string, source: string | undefined, rules: FilterRule[], search: string): { all: Task[]; ofSource: Task[]; filtered: Task[]; tasks: Task[] } {
  const all = state.tasks.filter((c) => c.stage === stage);
  const ofSource = source === undefined ? all : all.filter((c) => sourceOf(c) === source);
  const filtered = visibleUnderFilter(ofSource, rules);
  const tasks = filtered.filter((c) => matchesSearch(c, activityOf(state, c.item.itemId)?.branch ?? '', search));
  return { all, ofSource, filtered, tasks };
}

// The loops toggle flipped and kept in the view state (#909), so a reload shows the flow as it was left; zoom and pan ride along untouched
function withLoopsToggled(view: FlowView): FlowView {
  const next = { ...view, loops: !view.loops };
  writeFlowView(next);
  return next;
}

/** The flow (#134, 1b): a canvas that pans both ways, each stage a node holding its tasks, the transitions as arrows between them, and a node's
 * list panel over its right. Drag a task to reorder or, for a task canMoveToStage allows, onto another node (#366, #708); the ⋯ offers the
 * source's order back and the stage's view filter (#374). The canvas is the task menus' collision boundary. */
export function Flow({ state, source, selectedId, onOpen, tabs, stageCaps }: FlowProps) {
  const drag = useRef<Dragging | undefined>(undefined);
  const [view, setView] = useState(readFlowView); // the flowchart's view (#909): the loops toggle today, zoom and pan with #910
  const filters = useStageFilters(state.stages.map((s) => s.name));
  const [editing, setEditing] = useState<string>(); // the stage whose filter dialog is open (#374)
  const [listed, setListed] = useState<string>(); // the node whose list panel is open (#134)
  const [canvas, setCanvas] = useState<HTMLElement | null>(null);
  // session-only: it survives a view switch on purpose, the flow stays mounted under Atividades (#596), and clears on an app reload (#542)
  const [search, setSearch] = useState('');
  const isShown = useIsFlowShown();
  const shown = source === undefined ? state.tasks : state.tasks.filter((c) => sourceOf(c) === source);
  const of = (stage: string) => stageTasks(state, stage, source, filters.rulesOf(stage), search);
  const node = (stage: Stage, maxHeight: number) => {
    const { all, ofSource, filtered, tasks } = of(stage.name);
    return (
      <FlowNode
        stage={stage} state={state} tasks={tasks} order={all} shown={ofSource.length} filteredOut={ofSource.length - filtered.length} rules={filters.rulesOf(stage.name)} drag={drag}
        selectedId={selectedId} isListed={listed === stage.name} maxHeight={maxHeight}
        cap={stageCaps !== undefined && Object.hasOwn(stageCaps, stage.name) ? stageCaps[stage.name] : undefined} onOpen={onOpen}
        onFilter={() => setEditing(stage.name)} onClearFilter={() => filters.set(stage.name, [])} onList={() => setListed(stage.name)}
      />
    );
  };
  const listedStage = state.stages.find((s) => s.name === listed);
  const listedTasks = listedStage && of(listedStage.name);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FlowHeader state={state} source={source} tasks={shown} search={search} onSearch={setSearch} isShown={isShown} tabs={tabs} loops={view.loops} onLoops={() => setView(withLoopsToggled(view))} />
      <MenuBoundaryContext.Provider value={canvas}>
        <section ref={setCanvas} aria-label={t('flow.chart')} className="relative min-h-0 flex-1 overflow-hidden bg-background">
          <FlowChart stages={state.stages} transitions={state.transitions} loops={view.loops} renderNode={node} />
          {listedStage && listedTasks && (
            <FlowListPanel stage={listedStage} state={state} tasks={listedTasks.tasks} order={listedTasks.all} drag={drag} selectedId={selectedId} onOpen={onOpen} onClose={() => setListed(undefined)} />
          )}
        </section>
      </MenuBoundaryContext.Provider>
      {editing !== undefined && (
        <StageFilterDialog
          stage={editing} tasks={state.tasks.filter((c) => c.stage === editing)} rules={filters.rulesOf(editing)}
          onApply={(rules) => filters.set(editing, rules)} onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
