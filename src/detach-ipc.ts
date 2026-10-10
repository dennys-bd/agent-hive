import type { IpcMainInvokeEvent } from 'electron';
import { UUID } from './orchestrator.js';
import type { Point } from './terminal-wire.js';

// A tab of the main window's terminal panel as a window of its own, and back (#252). The main-process half, kept out of main.ts (past its 400
// lines): the window:* handlers and the registry of detached windows that terminal-window.ts builds the BrowserWindows for. Electron only as
// types, so node:test drives all of it with fakes. Docking back is the window's dock button or its title menu, never a drop (#440).

/** A detached run's window as the registry drives it: a BrowserWindow in production. */
export interface DetachedWindow {
  focus(): void;
  destroy(): void; // Electron emits closed after it, which the builder reports as DetachedEvents.closed
  setPosition(x: number, y: number): void; // the title strip's drag (#377): a BrowserWindow already has it
}

/** What the window builder reports to the registry: the window made, before its load (#467); the title strip's drag (term:move, its raw
 * point, #377), a dock (term:dock from the page's button, or term:titleMenu's item, #340), a task reference's click (term:openTask, its raw task id, #588),
 * a file link's click (term:openFile, its raw payload, #717), the window gone. */
export interface DetachedEvents {
  created(win: DetachedWindow): void; // the window exists, its page not yet loaded: closeAll destroys it without waiting for the load (#467)
  moveTo(value: unknown): void;
  dock(): void;
  openTask(value: unknown): void;
  openFile(value: unknown): void;
  closed(): void;
}

/** A file link clicked in a detached window (#717), checked: its path and position, and the tab's task or workspace, which the main window
 * opens it in. */
export interface DetachedFile { path: string; line?: number; col?: number; task?: string; project?: string }

/** Builds and loads a run's window where the last terminal window closed; rejects when its page fails to load, with no window left behind. */
export type BuildDetached = (tab: DetachedTab, on: DetachedEvents) => Promise<DetachedWindow>;

/** One main window's side of a dock: where the tab goes back. */
export interface DockTarget {
  onDock(tab: DetachedTab): void;
}

export interface DetachedWindows {
  openTab(tab: DetachedTab): Promise<void>; // the run's or the terminal's window, or the one it already has, focused
  focusTab(ptyId: string): boolean; // true: the tab has a window, now focused
  ptys(): string[]; // the pty ids with a window, loading or shown (#400), focusing none
  closeAll(): void;
}

/** A main window as the handlers see it: its page. */
export interface MainWindowPage {
  webContents: { send(channel: string, ...args: unknown[]): void };
}

export interface DetachMainWindow {
  win: MainWindowPage;
  terminals: DetachedWindows;
}

export interface DetachIpcDeps {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void; // ipcMain.handle
  senderMainWindow(event: IpcMainInvokeEvent): DetachMainWindow; // throws for a sender that is not a main window showing its own daemon
}

export interface DetachHub {
  mainWindowDeps(win: MainWindowPage): DockTarget; // what createTerminalWindows gets for that main window
}

// Runs `use` once the window exists. A window whose page failed to load is already gone, and openTab reported it.
const whenBuilt = (pending: Promise<DetachedWindow>, use: (win: DetachedWindow) => void): void => void pending.then(use, () => undefined);

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const pointFrom = (value: unknown): Point | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const { x, y } = value as Record<string, unknown>;
  return isNumber(x) && isNumber(y) ? { x, y } : undefined;
};

const isPositiveInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

// The page's file link (#717), rebuilt from the known keys: untrusted IPC. A non-empty path, and a line and a column that are positive
// integers when present
function fileFrom(value: unknown): Pick<DetachedFile, 'path' | 'line' | 'col'> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { path, line, col } = value as Record<string, unknown>;
  if (!isText(path) || (line !== undefined && !isPositiveInt(line)) || (col !== undefined && !isPositiveInt(col))) return undefined;
  return { path, ...(line === undefined ? {} : { line }), ...(col === undefined ? {} : { col }) };
}

/** The detached windows of one main window (#252), by pty id: one per run, focused instead of doubled. The title strip's drag moves it (#377);
 * the page's dock button or the title menu docks it: the main window gets the tab back and the window goes. Moving it never docks (#440). Closing a
 * task run's window only closes that viewer; closing a project shell's stops the shell (#400). A task reference clicked in a window opens that
 * task on the main window (#588). */
export function createDetachedWindows({ build, onDock, onOpenTask, onOpenFile, stopShell }: DockTarget & { build: BuildDetached; onOpenTask(taskId: string): void; onOpenFile(file: DetachedFile): void; stopShell(ptyId: string): void }): DetachedWindows {
  const windows = new Map<string, Promise<DetachedWindow>>(); // the build itself: a second detach during the load finds it
  const made = new Set<DetachedWindow>(); // every window created and not yet closed, loaded or not: what closeAll destroys at once (#467)
  let closingAll = false; // the main window is going, or the viewer quitting (#400): its windows close with it, and their shells go on
  // Only this window's entry: a newer window of the same run may have replaced it
  const forget = (ptyId: string, pending: Promise<DetachedWindow>): void => {
    if (windows.get(ptyId) === pending) windows.delete(ptyId);
  };

  // A task reference's click (#588): the page's task id is untrusted IPC, so only a non-empty string goes on; the main window checks it is a task
  const openTask = (value: unknown): void => {
    if (isText(value)) onOpenTask(value);
  };

  // A file link's click (#717): checked, then handed to the main window with what the tab is of, its task or its workspace
  const fileOpener = (tab: DetachedTab) => (value: unknown): void => {
    const file = fileFrom(value);
    if (file) onOpenFile({ ...file, ...(tab.project === undefined ? { task: tab.task } : { project: tab.project }) });
  };

  function openTab(tab: DetachedTab): Promise<void> {
    const live = windows.get(tab.ptyId);
    if (live) return live.then((win) => win.focus());
    let docked = false;
    let loaded = false; // a page that failed to load is destroyed by its builder: no user closed that window
    const dock = (): void => {
      if (docked) return; // the button and the title menu's item in one gesture: one dock
      docked = true;
      forget(tab.ptyId, pending); // at once: a detach or a terminal button before the destroy lands opens a tab, not this window
      onDock(tab);
      whenBuilt(pending, (win) => win.destroy());
    };
    // The strip's drag (#377): the point is the page's, so it is checked; after the dock the window is being destroyed, and setPosition on a
    // destroyed BrowserWindow throws
    const moveTo = (value: unknown): void => {
      const point = pointFrom(value);
      if (!point || docked) return;
      whenBuilt(pending, (win) => win.setPosition(Math.round(point.x), Math.round(point.y)));
    };
    let win: DetachedWindow | undefined;
    // A main window going (or the viewer moving ports) cannot wait for a load: the old port may hold it open forever, and a page loading there
    // sends the session's cookie of the new port (#467). A destroyed window aborts its load.
    const created = (built: DetachedWindow): void => {
      win = built;
      if (closingAll) built.destroy();
      else made.add(built);
    };
    // A project shell has no task whose terminal button could reach it again (#400): the user closing its window stops it. A dock, the main window
    // going (or a quit) and a failed load are no user's close. The shell's own end closes its window too; that stop is refused, and dropped.
    const closed = (): void => {
      if (win) made.delete(win);
      forget(tab.ptyId, pending);
      if (tab.project !== undefined && loaded && !docked && !closingAll) stopShell(tab.ptyId);
    };
    const pending: Promise<DetachedWindow> = build(tab, { created, moveTo, dock, openTask, openFile: fileOpener(tab), closed });
    windows.set(tab.ptyId, pending);
    return pending.then(() => { loaded = true; }, (err: unknown) => {
      forget(tab.ptyId, pending);
      if (closingAll && win !== undefined) return; // closeAll destroyed it, aborting its load: no failure to toast, the main window is going
      throw err;
    });
  }

  function focusTab(ptyId: string): boolean {
    const pending = windows.get(ptyId);
    if (pending) whenBuilt(pending, (win) => win.focus());
    return pending !== undefined;
  }

  return {
    openTab,
    focusTab,
    ptys: () => [...windows.keys()],
    closeAll: () => {
      closingAll = true; // before the destroys: each one reports closed
      for (const win of made) {
        made.delete(win); // before the destroy: Electron's closed may come later, and a second closeAll must not destroy it twice
        win.destroy();
      }
    },
  };
}

const isKind = (value: unknown): value is DetachedTab['kind'] => value === 'stage' || value === 'session' || value === 'terminal';

// What a tab is of (#400): a task (a task's run) or a project (a project's shell), exactly one, each a non-empty string. Both or neither is
// no tab the Hive writes.
function targetOf(task: unknown, project: unknown): { task: string } | { project: string } | undefined {
  if (project === undefined) return isText(task) ? { task } : undefined;
  return task === undefined && isText(project) ? { project } : undefined;
}

// The page's tab, rebuilt from the known keys: untrusted IPC, and its pty id rides the window's URL. undefined for any other shape.
function parseDetachedTab(value: unknown): DetachedTab | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { ptyId, kind, task, project, title, label } = value as Record<string, unknown>;
  if (typeof ptyId !== 'string' || !UUID.test(ptyId) || !isKind(kind)) return undefined;
  if (!isText(title) || !isText(label)) return undefined;
  const target = targetOf(task, project);
  if (!target) return undefined;
  return { ptyId, kind, ...target, title, label };
}

/**
 * The main window's detach calls (#252). window:detach opens (or focuses) a run's window, window:focusDetached answers whether it has one, and
 * window:detachedPtys which runs have one (#400). Everything from the page is checked before use, and the sender must be a main window
 * (senderMainWindow). A rejection reaches the page's toast, in Portuguese like main.ts's own.
 */
export function registerDetachIpc({ handle, senderMainWindow }: DetachIpcDeps): DetachHub {
  handle('window:detach', (event, value) => {
    const tab = parseDetachedTab(value);
    if (!tab) throw new Error('aba inválida');
    return senderMainWindow(event).terminals.openTab(tab);
  });
  handle('window:focusDetached', (event, ptyId) => {
    if (typeof ptyId !== 'string' || !UUID.test(ptyId)) throw new Error(`aba inválida: ${String(ptyId)}`);
    return senderMainWindow(event).terminals.focusTab(ptyId);
  });
  // Read-only (#400): after a reload the panel leaves a project shell that has a window to it, without raising it as focusDetached would
  handle('window:detachedPtys', (event) => senderMainWindow(event).terminals.ptys());
  return { mainWindowDeps: (win) => ({ onDock: (tab) => win.webContents.send('window:dock', tab) }) };
}
