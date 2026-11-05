// The tasks sidebar (#572, ui.tasks.sidebar): which of its four sections are closed and the height each open one keeps. Per viewer, in the
// view state (#484), never a setting. Each field is read on its own, as flowView's are, so one bad height never resets the rest. And what the
// tasks section counts: every task, each flow's, the ones in no flow, and of them how many wait for the user.
import { flowOf } from '../../flows.js';
import type { State, Task } from '../../types.js';
import type { TaskState } from './status.js';
import { taskState } from './task-state.js';
import { readView, writeView } from './view-state.js';

export type SidebarSection = 'automation' | 'tasks' | 'sources' | 'repos';
export const SECTIONS: readonly SidebarSection[] = ['automation', 'tasks', 'sources', 'repos'];
export interface TasksSidebarView { closed: Record<SidebarSection, boolean>; heights: Record<SidebarSection, number> }
export const SECTION_MIN = 60;
export const SECTION_MAX = 560;
const HEIGHTS: Record<SidebarSection, number> = { automation: 200, tasks: 150, sources: 200, repos: 240 }; // handoff §4

// One value per section, built field by field so no cast is needed
const bySection = <T>(of: (section: SidebarSection) => T): Record<SidebarSection, T> =>
  ({ automation: of('automation'), tasks: of('tasks'), sources: of('sources'), repos: of('repos') });

export const SIDEBAR_DEFAULTS: TasksSidebarView = { closed: bySection(() => false), heights: bySection((s) => HEIGHTS[s]) };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const clampHeight = (h: number): number => Math.min(SECTION_MAX, Math.max(SECTION_MIN, Math.round(h)));

/** The stored layout, field by field: a flag or a height that fails falls back to its default alone; a height out of bounds is clamped. */
export function readTasksSidebar(): TasksSidebarView {
  const stored = readView('tasksSidebar');
  const value = isRecord(stored) ? stored : {};
  const closed = isRecord(value.closed) ? value.closed : {};
  const heights = isRecord(value.heights) ? value.heights : {};
  return {
    closed: bySection((s) => {
      const flag = closed[s];
      return typeof flag === 'boolean' ? flag : SIDEBAR_DEFAULTS.closed[s];
    }),
    heights: bySection((s) => {
      const h = heights[s];
      return typeof h === 'number' && Number.isFinite(h) ? clampHeight(h) : HEIGHTS[s];
    }),
  };
}

/** The whole value: a toggle never loses a height, a drag never loses a flag. */
export function writeTasksSidebar(view: TasksSidebarView): void {
  writeView('tasksSidebar', view);
}

/** Decision 3: the open section that takes what is left, flex 1 1 0; none with every section closed. */
export const lastOpen = (view: TasksSidebarView): SidebarSection | undefined => [...SECTIONS].reverse().find((s) => !view.closed[s]);

export const withResize = (view: TasksSidebarView, section: SidebarSection, height: number): TasksSidebarView =>
  ({ ...view, heights: { ...view.heights, [section]: clampHeight(height) } });

export const withToggle = (view: TasksSidebarView, section: SidebarSection): TasksSidebarView =>
  ({ ...view, closed: { ...view.closed, [section]: !view.closed[section] } });

export interface EntryCount { total: number; needsYou: number }

// Decision 9: "needs you" is a session waiting for the user or an approval to answer
const NEEDS_YOU: ReadonlySet<TaskState> = new Set<TaskState>(['waiting', 'approval']);
/** Whether the task waits for the user (decision 9): the sidebar's counts and the list's group headers (#577) read this one rule. */
export const needsYou = (task: Task, state: State): boolean => NEEDS_YOU.has(taskState(task, state));
const countOf = (tasks: readonly Task[], state: State): EntryCount =>
  ({ total: tasks.length, needsYou: tasks.filter((c) => needsYou(c, state)).length });

/** The tasks section's counts (decisions 9, 10): every task, each flow's by its stage, and the ones in no flow: no stage, or a stage of no
 * flow, as centerOfTask reads it, so a count agrees with where goTo sends the task. sourcesOff is not read: it filters only the center. */
export function entryCounts(state: State): { all: EntryCount; flows: Record<string, EntryCount>; outside: EntryCount } {
  const flowName = (task: Task): string | undefined => flowOf(state.flows, task.stage)?.name;
  return {
    all: countOf(state.tasks, state),
    flows: Object.fromEntries(state.flows.map((f) => [f.name, countOf(state.tasks.filter((c) => flowName(c) === f.name), state)])),
    outside: countOf(state.tasks.filter((c) => flowName(c) === undefined), state),
  };
}
