/** What the main window's preload exposes as `window.hive` (contextBridge, #632): present only inside the Electron viewer; a
 * plain browser opens every run in the panel. Ambient on purpose: the preload (main-side tsc)
 * and src/ui/components/actions.ts (UI tsc) share it without either importing the other. */
interface HiveWindow {
  chooseFolder(): Promise<string | undefined>; // the settings form's "Choose…" (#202): the native folder picker; undefined when cancelled
  // the menu bar's worker lines (#192) and its Settings… (#195): each window:select main sends, the last one held until the page
  // subscribes; untrusted IPC, so the page checks its shape. A later call replaces the callback.
  onSelect(callback: (selection: unknown) => void): void;
  settingsChanged(): Promise<void>; // the settings form saved: the viewer re-reads onClose (#513) and adds or removes its menu bar icon
  // Main window only (#552): a center tab's move to its activity's detached window, built or reused, focused. It resolves once main sent the
  // tab there, and only then may the page close it; it rejects on a malformed tab, a page that failed to load, or a port with no secret
  moveToWindow(tab: import('./tab-carry.js').MovedTab): Promise<void>;
  // Main window only (#552): true when a detached window of the activity holds the tab `key` names (a split run tab's pane included), now focused
  focusTab(activity: string, key: string): Promise<boolean>;
  // Main window only (#552): every tab out in this main window's detached windows, by activity and ref, never a carry
  detachedTabs(): Promise<import('./tab-carry.js').MovedTab[]>;
  // Detached window only (#552): each window:open main sends, held until the page subscribes; untrusted IPC, so the page checks it with
  // parseMovedTab. A later call replaces the callback
  onOpen(callback: (tab: unknown) => void): void;
  // Detached window only (#552): the tab back to its main window's page, which opens it in its activity; rejects on a malformed tab or another
  // activity's, and the page keeps the tab
  dock(tab: import('./tab-carry.js').MovedTab): Promise<void>;
  // Detached window only (#552): the user closed this window while it holds tabs; the page docks them all, then calls closeWindow. One request
  // is held until the page subscribes
  onClosing(callback: () => void): void;
  // Detached window only (#552): a task reference's click; the main window comes forward on the task's panel (#588)
  openTask(taskId: string): Promise<void>;
  // Detached window only (#552): every tab the page holds, sent after each change; focusTab and detachedTabs answer from it
  tabsChanged(refs: import('./tab-carry.js').CenterTabRef[]): void;
  // a tab docked back from a detached window (#252, #552): each window:dock, now a MovedTab, held until the page subscribes; untrusted IPC, so the page checks its shape
  onDock(callback: (tab: unknown) => void): void;
  // Cmd+W / Window → Close on this main window (#358): the callback closes the shown panel tab, or does nothing; the close key never closes
  // the window (#612). Returns the unsubscribe.
  onCloseKey(callback: () => void): () => void;
  closeWindow(): Promise<void>; // the closeWindow shortcut on the page (#585): window:closeWindow, the only key that closes the main window
  // a Finder drop on the files sidebar (#594): the dropped file's absolute path, which contextIsolation hides from the page as File.path;
  // '' for a File the disk does not back
  pathForFile(file: File): string;
  // ⌘V in the files tree (#594) and in a panel tab's terminal (#843): the absolute paths of the files Finder put on the clipboard, read in main (a sandboxed preload has no clipboard); [] when none
  clipboardFiles(): Promise<string[]>;
  // ⌘C and ⌘X in the files tree (#818): the absolute paths onto the system pasteboard as Finder writes them; main refuses anything else
  writeClipboardFiles(paths: string[]): Promise<void>;
  // an untitled file's ⌘S (#818): the OS's save dialog from `defaultPath`; the chosen path, or undefined when cancelled
  saveDialog(defaultPath?: string): Promise<string | undefined>;
  // whether this main window is in full screen now (#295): the state at load, for a window restored there (#398)
  isFullScreen(): Promise<boolean>;
  // window:fullScreen on the window's enter-full-screen and leave-full-screen (#295); the preload drops a payload that is no boolean.
  // Returns the unsubscribe, which clears only its own callback.
  onFullScreen(callback: (on: boolean) => void): () => void;
  // every theme the page resolves (#648): main recolours Windows' caption buttons with it; sent, nothing to answer, a no-op off Windows
  themeResolved(theme: import('./ui/lib/theme.js').ResolvedTheme): void;
}

interface Window {
  hive?: HiveWindow;
}
