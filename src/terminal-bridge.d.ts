/** What a detached run's window's preload exposes as `window.hiveTerminal` (contextBridge, #252): the page's side of its IPC messages.
 * Ambient on purpose: the preload (main-side tsc) and src/ui/terminal.ts (UI tsc) share it without either importing the other. */
interface HiveTerminal {
  dock(): void; // back to the main window's panel; main closes the window
  titleMenu(label: string): void; // the title's right-click menu, its one item labelled in the page's language (#340)
  moveTo(point: { x: number; y: number }): void; // term:move — the window's new top-left corner, in screen pixels (#377)
  openFile(file: { path: string; line?: number; col?: number }): void; // term:openFile — a file link's click (#717): main checks it, then the main window opens it in its editor pane
  openTask(taskId: string): void; // term:openTask — a task reference's click (#588): main brings the main window forward on that task's panel
  clipboardFiles(): Promise<string[]>; // term:clipboardFiles — a paste (#843): the absolute paths of the files Finder put on the clipboard, read in main (a sandboxed preload has no clipboard); [] when none
}

interface Window {
  hiveTerminal: HiveTerminal;
}
