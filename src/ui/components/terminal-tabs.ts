// The main window's terminal tabs as the rest of the page sees them (#251): what a tab is, and the panel's opener, provided by the Dashboard.
import { createContext, useContext } from 'react';
import { taskLabel } from '../../tasks';
import type { LiveRun, RunKind } from '../../task-runs';
import type { Task, DiffScope } from '../../types';
import { DIFF_SCOPE_KEY } from '@/components/DiffView';
import { type MessageKey, t } from '@/i18n';
import { localKey, type RunTarget } from '@/lib/activities';
import type { FileAt } from '@/lib/editor-models';

/** One run's terminal as the main window knows it: what the panel's tab shows and what focusRun routes on. */
export interface RunTab {
  ptyId: string;
  kind: RunKind;
  task?: string; // item.itemId: what the tab's file links open in (#258); absent: a workspace's run (#292, #590)
  project?: string; // a workspace's run (#292, #400, #590): the workspace's name, what its file links open in
  title: string; // taskLabel(task), or the project's name (#292)
}

export type OpenTab = (tab: PanelTab) => void; // a run's tab, or a task's diff (#270)

/** The Dashboard's panel opener; undefined outside a Dashboard (a component test, the first-run form). */
export const TerminalTabsContext = createContext<OpenTab | undefined>(undefined);

export const useOpenTab = (): OpenTab | undefined => useContext(TerminalTabsContext);

export type OpenRun = (tab: RunTab) => void; // a run the user opened: a task's goes to its activity in the center (#457)

/** The Dashboard's run opener (#457), what a run's terminal button and a started run reach through focusRun: a task's run becomes its
 * activity, the center showing it; a workspace's run its local activity (#590). Undefined outside a Dashboard, as TerminalTabsContext is. */
export const RunOpenerContext = createContext<OpenRun | undefined>(undefined);

export const useOpenRun = (): OpenRun | undefined => useContext(RunOpenerContext);

export type OpenStarted = (taskId: string) => void; // a start the server took: the task's run spawns later, maybe much later (#457)

/** The Dashboard's opener for a task Iniciar, Continuar or Reiniciar just started (#457): the task becomes the activity once its run shows,
 * unless the user moved on meanwhile. Undefined outside a Dashboard. */
export const StartedTaskContext = createContext<OpenStarted | undefined>(undefined);

export const useOpenStarted = (): OpenStarted | undefined => useContext(StartedTaskContext);

export type OpenDiff = (task: Task, scope: DiffScope, checkpoint?: number) => void; // a task's diff from its menu (#270)

/** The Dashboard's diff opener (#458): a running task's diff becomes a tab of its activity's center, any other task's a tab of the Terminal
 * panel, as before. Undefined outside a Dashboard, as TerminalTabsContext is. */
export const DiffOpenerContext = createContext<OpenDiff | undefined>(undefined);

export const useOpenDiff = (): OpenDiff | undefined => useContext(DiffOpenerContext);

/** Every way into a PR (#592, #758): its page under its repository, or GitHub when the Hive does not list the repository. */
export type OpenPr = (url: string) => void;

/** The Dashboard's PR opener (#758). Undefined outside a Dashboard: a PR link then opens GitHub as any link does. */
export const PrOpenerContext = createContext<OpenPr | undefined>(undefined);

export const useOpenPr = (): OpenPr | undefined => useContext(PrOpenerContext);

/** The Dashboard's issue opener (#895): the issue's page under its repository, or its URL when the Hive does not list the repository or the
 * item is not a GitHub issue. Undefined outside a Dashboard: the issue link then opens its URL as any link does. */
export const IssueOpenerContext = createContext<OpenPr | undefined>(undefined);

export const useOpenIssue = (): OpenPr | undefined => useContext(IssueOpenerContext);

/** How a file opens (#697): preview, a preview pane tab that renders it; changes (#668), a changes pane tab against its base; else the editor
 * pane. */
export interface OpenFileHow { preview?: boolean; changes?: boolean }

/** A file of an activity (#717): opened (or shown again) as an editor pane tab of the activity keyed `key` (activityKey), its cursor at `at`
 * when given, or as its preview pane tab with `how.preview` (#697), or its changes pane tab with `how.changes` (#668). true once it opened;
 * false when that activity is not listed. */
export type OpenFile = (key: string, path: string, at?: FileAt, how?: OpenFileHow) => boolean;

/** The Dashboard's file opener (#717). Undefined outside a Dashboard, as PrOpenerContext is. */
export const FileOpenerContext = createContext<OpenFile | undefined>(undefined);

export const useOpenFile = (): OpenFile | undefined => useContext(FileOpenerContext);

const CHANGES: OpenFileHow = { changes: true };

/** The changes pane of a file of the activity keyed `key` (#668): its tab, through the dock's file opener, in the focused group. Undefined
 * outside a Dashboard, as useOpenFile. */
export function useOpenChanges(key: string): ((path: string) => void) | undefined {
  const openFile = useOpenFile();
  return openFile && ((path: string): void => {
    openFile(key, path, undefined, CHANGES);
  });
}

const KIND_KEY: Record<RunKind, MessageKey> = { stage: 'terminal.panel.kind.stage', session: 'terminal.panel.kind.session', terminal: 'terminal.panel.kind.terminal' };

// The kind a tab's label names after the task (#251, #270)
function kindText(tab: PanelTab): string {
  if (tab.kind === 'diff') return t(DIFF_SCOPE_KEY[tab.scope], { n: tab.checkpoint ?? '' });
  return t(KIND_KEY[tab.kind]);
}

/** What a tab is called (#251): the task, then the kind of run, or which diff it is (#270). */
export const tabLabel = (tab: PanelTab): string => `${tab.title} · ${kindText(tab)}`;

/** A task's live run as a tab (#251). */
export const runTab = (task: Task, run: LiveRun): RunTab =>
  ({ ptyId: run.ptyId, kind: run.kind, task: task.item.itemId, title: taskLabel(task) });

/** An activity's live run as a tab (#251, #590): a task's names the task; a local activity's names its workspace, whose checkout its file
 * links open in (#400). */
export const activityRunTab = (activity: RunTarget, run: LiveRun): RunTab =>
  (activity.kind === 'local' ? localRunTab(run.ptyId, activity.workspace, run.kind) : runTab(activity.task, run));

/** The drag type a footer chip carries its run under (#340): the Hive's own, so the main window's task drags and the terminal panel never take
 * each other's drops. */
export const RUN_MIME = 'application/x-hive-run';

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isKind = (value: unknown): value is RunKind => value === 'stage' || value === 'session' || value === 'terminal';

/** A workspace's run as a tab (#292, #590): no task, and the tab reads `<workspace> · <kind>`. Its workspace is what its file links
 * open in, and what its detached window carries (#400). */
export const localRunTab = (ptyId: string, project: string, kind: RunKind = 'terminal'): RunTab =>
  ({ ptyId, kind, project, title: project });

/** A window:dock payload as a tab (#252), or undefined for any other shape: main's message is IPC, checked like onSelect's. The label
 * main carried for the window's title is dropped: the panel names its tabs itself. Exactly one of task / project (#400): a workspace's run
 * comes back as localRunTab builds it. */
export function dockedTab(value: unknown): RunTab | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { ptyId, kind, task, project, title } = value as Record<string, unknown>;
  if (!isText(ptyId) || !isText(title) || !isKind(kind)) return undefined;
  if (project !== undefined) return task === undefined && isText(project) ? localRunTab(ptyId, project, kind) : undefined;
  if (!isText(task)) return undefined;
  return { ptyId, kind, task, title };
}

// A detached window's tab names its task or its workspace (#400): the activity's key either way (#590)
function keyOf(task: unknown, project: unknown): string | undefined {
  if (isText(task)) return task;
  return isText(project) ? localKey(project) : undefined;
}

const isLine = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

/** A window:openFile payload (#717): a detached window's file link as main forwarded it, checked like a dock's. Its activity's key, the
 * path and the position; undefined for any other shape. */
export function openedFile(value: unknown): { key: string; path: string; at?: FileAt } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { task, project, path, line, col } = value as Record<string, unknown>;
  const key = keyOf(task, project);
  if (key === undefined || !isText(path)) return undefined;
  if (!isLine(line)) return { key, path };
  return { key, path, at: { line, ...(isLine(col) ? { col } : {}) } };
}

/** A worker chip's drop payload as a tab (#340), checked like a dock's; undefined for anything that is not a task run's JSON. A chip is
 * always a task's run (#400): a foreign drag carrying a project opens no project shell. */
export function droppedTab(text: string): RunTab | undefined {
  try {
    const tab = dockedTab(JSON.parse(text));
    return tab?.task === undefined ? undefined : tab;
  } catch {
    return undefined; // not JSON: nothing the Hive wrote
  }
}

/** A project's live shell as the state lists it (#292): the panel gives each one a tab of its own. */
export interface LiveProjectShell { ptyId: string; project: string }

/** A task's diff as a tab of the panel (#270): drawn by DiffView, not a terminal, with no worker behind it. */
export interface DiffTab { kind: 'diff'; task: string; scope: DiffScope; checkpoint?: number; title: string } // task: item.itemId; title: taskLabel(task)

/** Every tab the panel holds (#270): a run's terminal or a task's diff. `kind` tells them apart: a RunTab's is a RunKind. */
export type PanelTab = RunTab | DiffTab;

/** A tab's identity in the panel (#270): a run's pty id, or its task and scope for a diff, so a second open of either selects the first. */
export const tabKey = (tab: PanelTab): string => (tab.kind === 'diff' ? `diff:${tab.task}:${tab.scope}${tab.checkpoint === undefined ? '' : `:${tab.checkpoint}`}` : tab.ptyId);

/** `tabs` with the one keyed `key` moved to `toIndex` (#359), clamped to the array's bounds: a drag reorder in the session list, or a no-op
 * when the key is unknown or already at `toIndex`. Always a new array, `tabs` itself never touched. */
export function moveTab(tabs: readonly PanelTab[], key: string, toIndex: number): PanelTab[] {
  const from = tabs.findIndex((tab) => tabKey(tab) === key);
  if (from === -1) return [...tabs];
  const clamped = Math.max(0, Math.min(tabs.length - 1, toIndex));
  if (clamped === from) return [...tabs];
  const without = tabs.filter((_, index) => index !== from);
  return [...without.slice(0, clamped), tabs[from], ...without.slice(clamped)];
}

/** A task's diff as a tab (#270), titled like its runs' tabs. */
export const diffTab = (task: Task, scope: DiffScope, checkpoint?: number): DiffTab => ({ kind: 'diff', task: task.item.itemId, scope, ...(checkpoint === undefined ? {} : { checkpoint }), title: taskLabel(task) });
