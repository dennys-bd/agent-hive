import { useRef, useState } from 'react';
import { activityOf } from '../../activities';
import type { Flow as FlowConfig, FilterRule, Stage, State, Task } from '../../types';
import { FlowChart } from '@/components/FlowChart';
import { FlowHeader } from '@/components/FlowHeader';
import { FlowListPanel } from '@/components/FlowListPanel';
import { FlowNode } from '@/components/FlowNode';
import { FlowZoom } from '@/components/FlowZoom';
import { FocusTrail } from '@/components/FocusTrail';
import { useIsFlowShown } from '@/components/MainDock';
import { StageFilterDialog, useStageFilters } from '@/components/StageFilter';
import type { Dragging } from '@/components/task-drag';
import { MenuBoundaryContext } from '@/components/TaskMenu';
import { useFlowView } from '@/hooks/use-flow-view';
import { useTreeFocus } from '@/hooks/use-tree-focus';
import { t } from '@/i18n';
import { matchesSearch } from '@/lib/flow-search';
import { visibleUnderFilter } from '@/lib/stage-filters';
import { focusTrail } from '@/lib/tree-focus';
import { hasTree } from '@/lib/tree-groups';

interface FlowProps { state: State; flow: FlowConfig; selectedId?: string; onOpen?(taskId: string): void; stageCaps?: Record<string, number> } // flow: the one drawn (#571); selectedId: the detail panel's task (#542); stageCaps: the effective caps, which a node shows as n/cap (#727)

/** What a stage shows (#374, #542): its tasks in the Hive's order, those the view filter lets through, and
 * those the search lets through after it. */
export function stageTasks(state: State, stage: string, rules: FilterRule[], search: string): { all: Task[]; filtered: Task[]; tasks: Task[] } {
  const all = state.tasks.filter((c) => c.stage === stage);
  const filtered = visibleUnderFilter(all, rules);
  const tasks = filtered.filter((c) => matchesSearch(c, activityOf(state, c.item.itemId)?.branch ?? '', search));
  return { all, filtered, tasks };
}

/** The flow (#134, 1b): a canvas that pans both ways, each stage a node holding its tasks, the transitions as arrows between them, and a node's
 * list panel over its right. Drag a task to reorder or, for a task canMoveToStage allows, onto another node (#366, #708); the ⋯ offers the
 * source's order back and the stage's view filter (#374). A parent's focus › dims all but its subtree, with a trail to climb back and leave
 * (#35). The canvas is the task menus' collision boundary. */
export function Flow({ state, flow: drawn, selectedId, onOpen, stageCaps }: FlowProps) {
  const drag = useRef<Dragging | undefined>(undefined);
  const filters = useStageFilters(state.stages.map((s) => s.name));
  const [editing, setEditing] = useState<string>(); // the stage whose filter dialog is open (#374)
  const [listed, setListed] = useState<string>(); // the node whose list panel is open (#134)
  // #571: Flow stays mounted across a flow switch, so a panel opened in one flow would reopen on coming back to it; the switch closes it
  const [listedIn, setListedIn] = useState(drawn.name);
  if (listedIn !== drawn.name) {
    setListedIn(drawn.name);
    setListed(undefined);
  }
  const [canvas, setCanvas] = useState<HTMLElement | null>(null);
  const [search, setSearch] = useState(''); // session-only: it survives a view switch on purpose, the flow stays mounted under Atividades (#596), and clears on an app reload (#542)
  const isShown = useIsFlowShown();
  const chart = useFlowView(isShown, drawn.name); // the flowchart's view (#909, #910, #571): loops and the drawn flow's canvas, kept in flowView
  const inFlow = new Set(drawn.stages.map((s) => s.name));
  const isTree = chart.view.tree ?? hasTree(state.tasks); // #34: until the first click, on when a tree exists in the whole task list
  const { itemId: focused, focus, focusOn, leave } = useTreeFocus(state.tasks, drawn.name, isShown); // #35: the focus on a subtree, never in flowView
  const shown = state.tasks.filter((c) => c.stage !== undefined && inFlow.has(c.stage)); // #566: a task outside the flow is on no flowchart
  const of = (stage: string) => stageTasks(state, stage, filters.rulesOf(stage), search);
  const node = (stage: Stage, maxHeight: number) => {
    const { all, filtered, tasks } = of(stage.name);
    return (
      <FlowNode
        stage={stage} state={state} tasks={tasks} order={all} shown={all.length} filteredOut={all.length - filtered.length} rules={filters.rulesOf(stage.name)} drag={drag}
        selectedId={selectedId} isListed={listed === stage.name} maxHeight={maxHeight} isTree={isTree} collapsed={chart.view.collapsed} onToggleGroup={chart.toggleGroup}
        cap={stageCaps !== undefined && Object.hasOwn(stageCaps, stage.name) ? stageCaps[stage.name] : undefined} onOpen={onOpen}
        onFilter={() => setEditing(stage.name)} onClearFilter={() => filters.set(stage.name, [])} onList={() => setListed(stage.name)} focus={focus} onFocusTree={focusOn}
      />
    );
  };
  const listedStage = drawn.stages.find((s) => s.name === listed);
  const listedTasks = listedStage && of(listedStage.name);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FlowHeader state={state} tasks={shown} search={search} onSearch={setSearch} isShown={isShown} loops={chart.view.loops} onLoops={chart.toggleLoops} tree={isTree} onTree={() => chart.toggleTree(isTree)} />
      <MenuBoundaryContext.Provider value={canvas}>
        <section ref={setCanvas} aria-label={t('flow.chart')} className="relative min-h-0 flex-1 overflow-hidden bg-background">
          <FlowChart
            key={drawn.name} stages={drawn.stages} transitions={drawn.transitions} loops={chart.view.loops} zoom={chart.view.zoom} pan={chart.view.pan}
            fitRequest={chart.fitRequest} onPan={chart.onPan} onFit={chart.onFit} onZoom={chart.zoomTo} renderNode={node}
          />
          <FlowZoom zoom={chart.view.zoom} onZoom={chart.zoomTo} onFit={chart.fit} />
          {focus && focused !== undefined && <FocusTrail trail={focusTrail(state.tasks, focused)} count={shown.filter((c) => focus.has(c.item.itemId)).length} onFocus={focusOn} onLeave={leave} />}
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
