/** A panel tab on its way to a window of its own and back (#252): the panel's RunTab plus its label, the window's title. main checks it
 * (detach-ipc.ts) before any use: untrusted IPC. A task's run carries its task; a project's shell (#292, #400) its project, never both. */
interface DetachedTab {
  ptyId: string;
  kind: 'stage' | 'session' | 'terminal';
  task?: string; // exactly one of task / project
  project?: string;
  title: string;
  label: string;
}

/** What the main window's preload exposes as `window.hive` (contextBridge, #632): present only inside the Electron viewer; a
 * plain browser opens every run in the panel. Ambient on purpose, as terminal-bridge.d.ts: the preload (main-side tsc)
 * and src/ui/components/actions.ts (UI tsc) share it without either importing the other. */
interface HiveWindow {
  chooseFolder(): Promise<string | undefined>; // the settings form's "Choose…" (#202): the native folder picker; undefined when cancelled
  // the menu bar's worker lines (#192) and its Settings… (#195): each window:select main sends, the last one held until the page
  // subscribes; untrusted IPC, so the page checks its shape. A later call replaces the callback.
  onSelect(callback: (selection: unknown) => void): void;
  settingsChanged(): Promise<void>; // the settings form saved: the viewer re-reads onClose (#513) and adds or removes its menu bar icon
  detach(tab: DetachedTab): Promise<void>; // opens (or focuses) the run's window (#252), where the last terminal window closed (#440)
  focusDetached(ptyId: string): Promise<boolean>; // true when the run has a detached window, now focused (#252)
  detachedPtys(): Promise<string[]>; // window:detachedPtys — the pty ids that have a detached window of this main window, focusing none
  // a detached window docked back (#252): each window:dock held until the page subscribes; untrusted IPC, so the page checks its shape
  onDock(callback: (tab: unknown) => void): void;
  // Cmd+W / Window → Close on this main window (#358): the callback closes the shown panel tab, or does nothing; the close key never closes
  // the window (#612). Returns the unsubscribe.
  onCloseKey(callback: () => void): () => void;
  // a detached window's file link (#717): window:openFile, sent once main focused this window; untrusted IPC, so the page checks its shape.
  // Returns the unsubscribe.
  onOpenFile(callback: (file: unknown) => void): () => void;
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
}

interface Window {
  hive?: HiveWindow;
}
