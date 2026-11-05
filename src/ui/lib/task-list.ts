// The tasks center's list (#577, todas em lista): what the display options and the search leave of every task, one group per flow in config
// order and sem fluxo last, each in its flow's stage order or as trees (#34), and where a group's page ends. Pure: TaskList renders it.
import { activityOf } from '../../activities.js';
import { flowOf } from '../../flows.js';
import { progress, type TreeCount } from '../../task-tree.js';
import { sourceOf } from '../../tasks.js';
import type { Flow, State, Task } from '../../types.js';
import { matchesSearch } from './flow-search.js';
import type { DisplayOptions } from './flow-view.js';
import { needsYou } from './tasks-sidebar.js';
import { groupTasks, hasTree, hiddenEpics } from './tree-groups.js';

/** A row (#577 decision 6): the task, its depth in its tree, its tree's root id while the tree toggle is on (so a page never splits a tree), and
 * an epic's direct children done over all of them. */
export interface ListRow { task: Task; depth: number; tree?: string; children?: TreeCount }
/** A group (decisions 2, 3): a flow's, keyed by its name, or sem fluxo's, keyed ''; needsYou counts its rows that wait for the user. */
export interface ListGroup { key: string; flow?: Flow; rows: ListRow[]; needsYou: number }

export const LIST_PAGE = 25; // decision 7: rows a page shows
export const OUTSIDE_GROUP = ''; // no flow is named '' (isFlowName)

/** What the view leaves of `tasks` (#576 decisions 6, 7), before the stage filter and the search: a task of a source unchecked in exibir goes,
 * and so does an epic esconder epics hides, read off the whole list `all` so a child outside the flow still makes its parent an epic. The
 * flowchart and the list (#577) read it. */
export function viewedTasks(all: readonly Task[], tasks: readonly Task[], options: Pick<DisplayOptions, 'sourcesOff' | 'epics'>): Task[] {
  const hidden = hiddenEpics(all, options.epics);
  return tasks.filter((c) => !options.sourcesOff.includes(sourceOf(c)) && !hidden.has(c.item.itemId));
}

// Decision 5: by the stage's place in its flow; sort is stable, so a stage keeps the Hive's order
function byStage(flow: Flow, tasks: readonly Task[]): Task[] {
  const at = (task: Task): number => flow.stages.findIndex((s) => s.name === task.stage);
  return [...tasks].sort((a, b) => at(a) - at(b));
}

// Decision 6: #34's grouping, each tree where its root first sat and the loose tasks after; an epic counts its direct children as the
// flowchart card does (TreeProgress)
function treeRows(state: State, tasks: readonly Task[]): ListRow[] {
  const lastStage = state.stages.at(-1)?.name ?? '';
  return groupTasks(state.tasks, tasks).flatMap((group) => group.tasks.map(({ task, depth }): ListRow => ({
    task,
    depth,
    ...(group.root === undefined ? {} : { tree: group.root.item.itemId }),
    ...((task.item.children ?? []).length === 0 ? {} : { children: progress(state.tasks, task.item.itemId, lastStage) }),
  })));
}

/** The list's groups (decisions 1-6): sourcesOff, esconder epics and the search, as the flowchart reads them; a group per flow in config
 * order and sem fluxo last, a task in a stage of no flow included as the sidebar counts it; a group with no row left is dropped. */
export function listGroups(state: State, display: DisplayOptions, search: string): ListGroup[] {
  const isTree = display.tree ?? hasTree(state.tasks); // #34: until the first click, on when a tree exists
  const shown = viewedTasks(state.tasks, state.tasks, display).filter((c) => matchesSearch(c, activityOf(state, c.item.itemId)?.branch ?? '', search));
  const keyOf = (task: Task): string => flowOf(state.flows, task.stage)?.name ?? OUTSIDE_GROUP;
  const group = (key: string, tasks: Task[], flow?: Flow): ListGroup => ({
    key,
    ...(flow === undefined ? {} : { flow }),
    rows: isTree ? treeRows(state, tasks) : tasks.map((task) => ({ task, depth: 0 })),
    needsYou: tasks.filter((c) => needsYou(c, state)).length,
  });
  const flows = state.flows.map((flow) => group(flow.name, byStage(flow, shown.filter((c) => keyOf(c) === flow.name)), flow));
  return [...flows, group(OUTSIDE_GROUP, shown.filter((c) => keyOf(c) === OUTSIDE_GROUP))].filter((g) => g.rows.length > 0);
}

/** Where a page of `rows` ends (decision 7): at `shown`, or past the last row of the tree the cut would split, so a ↳ never waits on the next page. */
export function pageCut(rows: readonly ListRow[], shown: number): number {
  const cut = Math.min(shown, rows.length);
  const crossing = cut > 0 ? rows[cut - 1].tree : undefined;
  if (crossing === undefined || cut === rows.length) return cut;
  const end = rows.findIndex((row, i) => i >= cut && row.tree !== crossing);
  return end === -1 ? rows.length : end;
}
