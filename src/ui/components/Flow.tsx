import { useRef, useState } from 'react';
import { activityOf } from '../../activities';
import { resolveWorkspace, sourceOf } from '../../tasks';
import type { Flow as FlowConfig, FilterRule, Stage, State, Task } from '../../types';
import { FlowChart } from '@/components/FlowChart';
import { FlowHeader } from '@/components/FlowHeader';
import type { SourcesNav } from '@/components/FlowSources';
import { displayProps } from '@/components/tasks/DisplayPopover';
import { FlowListPanel } from '@/components/FlowListPanel';
import { FlowNode } from '@/components/FlowNode';
import { FlowZoom } from '@/components/FlowZoom';
import { FocusTrail } from '@/components/FocusTrail';
import { useIsFlowShown } from '@/components/MainDock';
import { StageFilterDialog, useStageFilters } from '@/components/StageFilter';
import type { Dragging } from '@/components/task-drag';
import { MenuBoundaryContext } from '@/components/TaskMenu';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { type DisplayControls, useFlowView } from '@/hooks/use-flow-view';
import { useTreeFocus } from '@/hooks/use-tree-focus';
import { t } from '@/i18n';
import { matchesSearch } from '@/lib/flow-search';
import type { DisplayOptions } from '@/lib/flow-view';
import { visibleUnderFilter } from '@/lib/stage-filters';
import { focusTrail } from '@/lib/tree-focus';
import { hasTree, hiddenEpics } from '@/lib/tree-groups';

interface FlowProps { state: State; flow: FlowConfig; selectedId?: string; onOpen?(taskId: string): void; stageCaps?: Record<string, number>; display?: DisplayControls; sources?: SourcesNav } // display: Center's one value (#574); absent (a test harness): the stored options, nothing to change them; sources: the popover's rows (#574), absent: hive alone; flow: the one drawn (#571); selectedId: the detail panel's task (#542); stageCaps: the effective caps, which a node shows as n/cap (#727)

/** What the view leaves of `tasks` (#576 decisions 6, 7), before the stage filter and the search: a task of a source unchecked in exibir goes,
 * and so does an epic esconder epics hides, read off the whole list `all` so a child outside the flow still makes its parent an epic. */
export function viewedTasks(all: readonly Task[], tasks: readonly Task[], options: Pick<DisplayOptions, 'sourcesOff' | 'epics'>): Task[] {
  const hidden = hiddenEpics(all, options.epics);
  return tasks.filter((c) => !options.sourcesOff.includes(sourceOf(c)) && !hidden.has(c.item.itemId));
}

/** What a stage shows (#374, #542): its tasks of `tasks` (the viewed ones, #576) in the Hive's order, those the view filter lets through, and
 * those the search lets through after it. */
export function stageTasks(state: State, tasks: readonly Task[], stage: string, rules: FilterRule[], search: string): { all: Task[]; filtered: Task[]; tasks: Task[] } {
  const all = tasks.filter((c) => c.stage === stage);
  const filtered = visibleUnderFilter(all, rules);
  const shown = filtered.filter((c) => matchesSearch(c, activityOf(state, c.item.itemId)?.branch ?? '', search));
  return { all, filtered, tasks: shown };
}

// The workspaces the shown tasks resolve to, in the Comb's order: a legend of the colours the tasks carry, never a filter (the source is the
// flow's only one)
function shownWorkspaces(tasks: readonly Task[], state: Pick<State, 'workspaces' | 'sourceWorkspaces' | 'tasks'>): string[] {
  const used = new Set(tasks.map((c) => resolveWorkspace(c, state.workspaces, state.sourceWorkspaces, state.tasks)));
  return state.workspaces.filter((name) => used.has(name));
}

// #576 decision 9: the workspaces of the tasks the canvas draws, bottom right (the zoom sits bottom left). The list panel, rendered after it, covers it while open
function WorkspacesLegend({ state, tasks }: { state: State; tasks: readonly Task[] }) {
  const names = shownWorkspaces(tasks, state);
  if (names.length === 0) return null;
  return (
    <fieldset aria-label={t('tasks.legend.workspaces')} className="absolute right-2.5 bottom-2.5 flex flex-col gap-1 rounded-md border bg-card px-2 py-1.5 text-muted-foreground text-xs">
      {names.map((name) => <span key={name} className="flex items-center gap-1.5"><WorkspaceSquare name={name} />{name}</span>)}
    </fieldset>
  );
}

/** The flow (#134, 1b): a canvas that pans both ways, each stage a node holding its tasks, the transitions as arrows between them, and a node's
 * list panel over its right. Drag a task to reorder or, for a task canMoveToStage allows, onto another node (#366, #708); the ⋯ offers the
 * source's order back and the stage's view filter (#374). A parent's focus › dims all but its subtree, with a trail to climb back and leave
 * (#35). The canvas is the task menus' collision boundary. */
export function Flow({ state, flow: drawn, selectedId, onOpen, stageCaps, display, sources }: FlowProps) {
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
  const options = display?.options ?? chart.view;
  const isTree = options.tree ?? hasTree(state.tasks); // #34: until the first click, on when a tree exists in the whole task list
  const { itemId: focused, focus, focusOn, leave } = useTreeFocus(state.tasks, drawn.name, isShown); // #35: the focus on a subtree, never in flowView
  const shown = state.tasks.filter((c) => c.stage !== undefined && inFlow.has(c.stage)); // #566: a task outside the flow is on no flowchart
  const viewed = viewedTasks(state.tasks, shown, options); // #576: what the nodes, the list panel and the focus count read
  const counted = shown; // #574: the popover's counts stay before sourcesOff
  const of = (stage: string) => stageTasks(state, viewed, stage, filters.rulesOf(stage), search);
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
      <FlowHeader state={state} search={search} onSearch={setSearch} isShown={isShown} {...(display ? displayProps({ display, sources, tasks: counted, isTree, hasLoops: true }) : {})} />
      <MenuBoundaryContext.Provider value={canvas}>
        <section ref={setCanvas} aria-label={t('flow.chart')} className="relative min-h-0 flex-1 overflow-hidden bg-background">
          <FlowChart
            key={drawn.name} stages={drawn.stages} transitions={drawn.transitions} loops={options.loops} labels={options.labels} zoom={chart.view.zoom} pan={chart.view.pan}
            fitRequest={chart.fitRequest} onPan={chart.onPan} onFit={chart.onFit} onZoom={chart.zoomTo} renderNode={node}
          />
          <FlowZoom zoom={chart.view.zoom} onZoom={chart.zoomTo} onFit={chart.fit} />
          <WorkspacesLegend state={state} tasks={drawn.stages.flatMap((s) => of(s.name).tasks)} />
          {focus && focused !== undefined && <FocusTrail trail={focusTrail(state.tasks, focused)} count={viewed.filter((c) => focus.has(c.item.itemId)).length} onFocus={focusOn} onLeave={leave} />}
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
