import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { type CenterTabRef, type MovedTab, parseMovedTab, parseTabRef, refKey, runsOf } from './tab-carry.js';
import type { IpcSender, WindowScope } from './window-ipc.js';

// The main process's side of detached windows (#252, #552): one main window's registry of them, one per activity, and the window:* handlers
// about detaching. Kept out of main.ts (past its 400 lines), and Electron only as types, so node:test drives all of it with fakes;
// detached-window.ts builds the BrowserWindows. A tab crosses as a message through main, checked with parseMovedTab, never a drop (#440, #534).

/** A detached window as the registry drives it: a BrowserWindow in production. */
export interface DetachedWindow {
  focus(): void;
  close(): void; // a plain close: the page's beforeunload and guardUnsavedEdits still run
  destroy(): void; // Electron emits closed after it, which the builder reports as DetachedEvents.closed
  webContents: { send(channel: string, ...args: unknown[]): void };
}

/** What the builder reports to the registry. */
export interface DetachedEvents {
  created(win: DetachedWindow): void; // the window exists, its page not yet loaded: closeAll destroys it without waiting for the load (#467)
  closing(event: { preventDefault(): void }): void; // the window's own close: a user's, or closeWithMain's
  kept(): void; // the unsaved-edits dialog was cancelled: the window stays
  closed(): void;
}

/** Builds and loads an activity's window where the last detached window closed; rejects when its page fails to load, with no window left behind. */
export type BuildDetached = (activity: string, on: DetachedEvents) => Promise<DetachedWindow>;

/** One main window's side of a dock: where the tab goes back. */
export interface DockTarget {
  onDock(tab: MovedTab): void;
}

export interface DetachedWindows {
  openTab(tab: MovedTab): Promise<void>; // the activity's window, built or reused, gets window:open with the tab, carry included, focused
  focusTab(activity: string, key: string): boolean; // true: a listed tab of the activity holds `key`, its window now focused
  detachedTabs(): MovedTab[]; // every listed tab, never a carry
  dock(sender: unknown, value: unknown): void; // throws on a malformed tab or another activity's
  tabsChanged(sender: unknown, value: unknown): void; // the page's report of what it holds
  openTask(taskId: string): void; // a task reference clicked in a window (#588): the main window opens it
  closeWindow(sender: unknown): void; // destroys that window
  owns(sender: unknown): boolean; // a detached window's webContents
  closeWithMain(): Promise<boolean>; // true once every window closed, false as soon as one was kept
  closeAll(): void; // a quit or a port change: destroyed at once (#467)
  size(): number;
}

// One window's bookkeeping, the registry's alone: the window once created, the tabs it holds as main last heard, whether it is gone, and
// whether closeWithMain is closing it, so its close is never turned into window:closing
interface Held { win?: DetachedWindow; refs: readonly CenterTabRef[]; isGone: boolean; isPlainClose: boolean }
interface Entry { activity: string; held: Held; pending: Promise<DetachedWindow> }
// One main window's detached windows by activity key (a second tab during the load finds the build), a quit or port change under way, and
// the closeWithMain calls still waiting
interface Registry { entries: Map<string, Entry>; isClosingAll: boolean; waiting: ((isClosed: boolean) => void)[] }

// What the page reports it holds (#552): only refs parseTabRef reads, an untitled one included; anything else is dropped
const parsedRefs = (value: unknown[]): CenterTabRef[] => value.flatMap((item) => {
  const ref = parseTabRef(item, { untitled: true });
  return ref === undefined ? [] : [ref];
});

// A listed tab holds `key`: its own key, or one of a split run tab's panes (#641)
const holds = (ref: CenterTabRef, key: string): boolean => refKey(ref) === key || runsOf(ref).includes(key);

function settle(reg: Registry, isClosed: boolean): void {
  const due = reg.waiting;
  reg.waiting = [];
  for (const resolve of due) resolve(isClosed);
}

// Only this window's entry: a newer window of the same activity may have replaced it. The last one gone settles a closeWithMain as closed
function drop(reg: Registry, activity: string, held: Held): void {
  held.isGone = true;
  if (reg.entries.get(activity)?.held === held) reg.entries.delete(activity);
  if (reg.entries.size === 0) settle(reg, true);
}

const entryOf = (reg: Registry, sender: unknown): Entry | undefined =>
  [...reg.entries.values()].find(({ held }) => !held.isGone && held.win !== undefined && held.win.webContents === sender);

function eventsOf(reg: Registry, activity: string, held: Held): DetachedEvents {
  return {
    created: (win) => {
      held.win = win;
      if (reg.isClosingAll) win.destroy(); // a port change cannot wait for a load the old port may hold open (#467)
      else if (held.isPlainClose) win.close(); // created while its main window closes: it goes with the others
    },
    // A user's close of a window still holding tabs (spec decision 7): the page docks them, then calls closeWindow. An empty one closes at once
    closing: (event) => {
      if (reg.isClosingAll || held.isPlainClose || held.refs.length === 0) return;
      event.preventDefault();
      held.win?.webContents.send('window:closing');
    },
    kept: () => {
      held.isPlainClose = false; // the window stays: its next close is the user's again
      settle(reg, false);
    },
    closed: () => drop(reg, activity, held),
  };
}

function start(reg: Registry, build: BuildDetached, activity: string): Entry {
  const held: Held = { refs: [], isGone: false, isPlainClose: false };
  const entry: Entry = { activity, held, pending: build(activity, eventsOf(reg, activity, held)) };
  if (!held.isGone) reg.entries.set(activity, entry); // a build that already closed its window leaves nothing to find
  entry.pending.catch(() => drop(reg, activity, held)); // a page that failed to load: no window and no tab left listed
  return entry;
}

// Spec decision 3: the carry crosses once, in window:open, and main lists the tab without it from that moment
async function openTab(reg: Registry, build: BuildDetached, tab: MovedTab): Promise<void> {
  const { held, pending } = reg.entries.get(tab.activity) ?? start(reg, build, tab.activity);
  const win = await pending.catch((err: unknown) => {
    if (reg.isClosingAll) return undefined;
    throw err;
  });
  if (win === undefined || held.isGone) {
    if (reg.isClosingAll) return; // closeAll destroyed it, aborting its load: the main window is going, no toast for it (#467)
    throw new Error('a janela destacada fechou'); // closed while it loaded: the tab stays in the main window
  }
  win.webContents.send('window:open', tab);
  win.focus();
  held.refs = [...held.refs.filter((ref) => refKey(ref) !== refKey(tab.ref)), tab.ref];
}

function focusTab(reg: Registry, activity: string, key: string): boolean {
  const held = reg.entries.get(activity)?.held;
  if (held?.win === undefined || !held.refs.some((ref) => holds(ref, key))) return false;
  held.win.focus();
  return true;
}

// Spec decision 6: checked before any use, and only a tab of the window's own activity
function dock(reg: Registry, onDock: DockTarget['onDock'], sender: unknown, value: unknown): void {
  const entry = entryOf(reg, sender);
  const tab = parseMovedTab(value);
  if (entry === undefined || tab === undefined || tab.activity !== entry.activity) throw new Error('aba inválida');
  entry.held.refs = entry.held.refs.filter((ref) => refKey(ref) !== refKey(tab.ref));
  onDock(tab);
}

// Spec decision 7: the page docked everything, or its last tab went; destroying skips a second beforeunload it has nothing left to guard
function closeWindow(reg: Registry, sender: unknown): void {
  const entry = entryOf(reg, sender);
  if (entry === undefined) return;
  const { win } = entry.held;
  drop(reg, entry.activity, entry.held); // at once: a move meanwhile builds a new window instead of reaching this one
  win?.destroy();
}

// Spec decision 8: a plain close per window, never window:closing, so nothing docks into a page that is unloading
function closeWithMain(reg: Registry): Promise<boolean> {
  if (reg.entries.size === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    reg.waiting = [...reg.waiting, resolve];
    for (const { held } of [...reg.entries.values()]) {
      held.isPlainClose = true;
      held.win?.close();
    }
  });
}

function closeAll(reg: Registry): void {
  reg.isClosingAll = true; // before the destroys: a window created later is destroyed as it appears (#467)
  for (const { activity, held } of [...reg.entries.values()]) {
    const { win } = held;
    drop(reg, activity, held); // before the destroy: Electron's closed may come later, and a second closeAll must not destroy it twice
    win?.destroy();
  }
}

/** The detached windows of one main window (#552), by activity key: one per activity, focused instead of doubled. The page reports what it
 *  holds, and focusTab and detachedTabs answer from that report. A dock goes back to the main window's page. A user's close asks the page to
 *  dock first; the main window's close, a quit and a Restart close plainly (closeWithMain); a port change destroys (closeAll). */
export function createDetachedWindows({ build, onDock, onOpenTask }: DockTarget & { build: BuildDetached; onOpenTask(taskId: string): void }): DetachedWindows {
  const reg: Registry = { entries: new Map(), isClosingAll: false, waiting: [] };
  return {
    openTab: (tab) => openTab(reg, build, tab),
    focusTab: (activity, key) => focusTab(reg, activity, key),
    detachedTabs: () => [...reg.entries.values()].flatMap(({ activity, held }) => held.refs.map((ref) => ({ activity, ref }))),
    dock: (sender, value) => dock(reg, onDock, sender, value),
    tabsChanged: (sender, value) => {
      const entry = entryOf(reg, sender);
      if (entry !== undefined && Array.isArray(value)) entry.held.refs = parsedRefs(value); // spec decision 4: the page's report replaces the list
    },
    openTask: onOpenTask,
    closeWindow: (sender) => closeWindow(reg, sender),
    owns: (sender) => entryOf(reg, sender) !== undefined,
    closeWithMain: () => closeWithMain(reg),
    closeAll: () => closeAll(reg),
    size: () => reg.entries.size,
  };
}

/** A main window as the handlers see it: its page. */
export interface MainWindowPage {
  webContents: { send(channel: string, ...args: unknown[]): void };
}

export interface DetachIpcDeps {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void; // ipcMain.handle
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void; // ipcMain.on: window:tabs is sent, never invoked
  senderWindow(event: IpcSender, scope: WindowScope): { entry: { detached: DetachedWindows } }; // window-ipc.ts's: throws for a sender out of scope
}

export interface DetachHub {
  mainWindowDeps(win: MainWindowPage): DockTarget; // what createDetachedWindowsFor gets for that main window
}

/**
 * The detach channels (spec decision 17). Main-only: window:moveToWindow, window:focusTab, window:detachedTabs. Detached-only: window:dock,
 * window:openTask, window:tabs. Every payload is checked before use; a refusal reaches the page's toast, in Portuguese like main.ts's own.
 * window:detach, window:focusDetached and window:detachedPtys are no longer handled: a call rejects (#552; their callers left in #554).
 */
export function registerDetachIpc({ handle, on, senderWindow }: DetachIpcDeps): DetachHub {
  handle('window:moveToWindow', (event, value) => {
    const tab = parseMovedTab(value);
    if (tab === undefined) throw new Error('aba inválida'); // before any build
    return senderWindow(event, 'main').entry.detached.openTab(tab);
  });
  handle('window:focusTab', (event, activity, key) => {
    if (typeof activity !== 'string' || typeof key !== 'string') throw new Error('aba inválida');
    return senderWindow(event, 'main').entry.detached.focusTab(activity, key);
  });
  handle('window:detachedTabs', (event) => senderWindow(event, 'main').entry.detached.detachedTabs());
  handle('window:dock', (event, value) => senderWindow(event, 'detached').entry.detached.dock(event.sender, value));
  // A task reference clicked in a detached window (#588, spec decision 18): the owning main window comes forward on the task's panel
  handle('window:openTask', (event, taskId) => {
    const { detached } = senderWindow(event, 'detached').entry;
    if (typeof taskId !== 'string' || taskId === '') throw new Error('tarefa inválida');
    detached.openTask(taskId);
  });
  on('window:tabs', (event, refs) => {
    try {
      senderWindow(event, 'detached').entry.detached.tabsChanged(event.sender, refs);
    } catch {
      // a sender that is no detached window of ours: a sent message has no caller to refuse to, and a throw here is main's uncaught error
    }
  });
  return { mainWindowDeps: (win) => ({ onDock: (tab) => win.webContents.send('window:dock', tab) }) };
}
