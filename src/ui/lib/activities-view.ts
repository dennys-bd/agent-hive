// A workspace's view of the Activities tab (#586): how it groups, whether the worktree line shows, which groups are collapsed, and whether
// the workspace itself is open. Kept in the daemon's view state (#484, #779) under activitiesView, one entry per workspace name, so a restart
// and a new port keep it; sessionStorage died with the window. A removed workspace's entry stays: a few bytes, and pruning would need the
// workspace list here.
import { useEffect, useState } from 'react';
import { DONE_KEY, GROUP_MODES, type GroupMode } from '@/lib/activity-groups';
import { readView, writeView } from '@/lib/view-state';

export interface WorkspaceView { mode: GroupMode; showWorktree: boolean; collapsed: string[]; isOpen: boolean }

export const DEFAULT_VIEW: WorkspaceView = { mode: 'stage', showWorktree: true, collapsed: [DONE_KEY], isOpen: true }; // done starts collapsed

type Views = Record<string, unknown>;

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((key) => typeof key === 'string');
const isViews = (value: unknown): value is Views => typeof value === 'object' && value !== null && !Array.isArray(value);

// The stored JSON is not trusted: anything but a plain object reads as no views at all
function readAll(): Views {
  const stored = readView('activitiesView');
  return isViews(stored) ? stored : {};
}

// Field by field, since the stored JSON is not trusted: a value of the wrong shape falls back to its default rather than breaking the tab
function viewOf(saved: unknown): WorkspaceView {
  if (!isViews(saved)) return DEFAULT_VIEW;
  const { mode, showWorktree, collapsed, isOpen } = saved;
  return {
    mode: GROUP_MODES.includes(mode as GroupMode) ? (mode as GroupMode) : DEFAULT_VIEW.mode,
    showWorktree: typeof showWorktree === 'boolean' ? showWorktree : DEFAULT_VIEW.showWorktree,
    collapsed: isStrings(collapsed) ? collapsed : DEFAULT_VIEW.collapsed,
    isOpen: typeof isOpen === 'boolean' ? isOpen : DEFAULT_VIEW.isOpen,
  };
}

export const readWorkspaceView = (workspace: string): WorkspaceView => viewOf(readAll()[workspace]);

/** The workspace's view into the one record of every workspace; view-state.ts debounces the post and flushes it on pagehide. */
export function writeWorkspaceView(workspace: string, view: WorkspaceView): void {
  writeView('activitiesView', { ...readAll(), [workspace]: view });
}

/** The workspace's view and how to change part of it; every change is saved right after it renders. */
export function useWorkspaceView(workspace: string): [WorkspaceView, (patch: Partial<WorkspaceView>) => void] {
  const [view, setView] = useState(() => readWorkspaceView(workspace));
  useEffect(() => writeWorkspaceView(workspace, view), [workspace, view]); // saved after each change, outside the updater, which stays pure
  const update = (patch: Partial<WorkspaceView>): void => setView((current) => ({ ...current, ...patch }));
  return [view, update];
}
