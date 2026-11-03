// The IPC every Hive page shares (#552): a main window's, and a detached window's, since both load the one preload (window-preload.cts) and
// the scope is checked here, never by which preload loaded. Out of main.ts, past its 400 lines. Electron's dialog and clipboard come in as
// deps, so node:test drives it with fakes. Every handler resolves its sender first: a page the daemon redirected elsewhere keeps the preload
// but gets nothing.
import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { clipboardFilesPlist, isClipboardPathList, parseClipboardFiles } from './clipboard-files.js';
import type { DetachedWindows } from './detach-ipc.js';

/** Which pages may call a channel (#552): a main window's, a detached window's, or either. */
export type WindowScope = 'main' | 'detached' | 'shared';

/** What an IPC event, invoked or sent, says of its sender: its page and the frame that sent it. */
export type IpcSender = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;

/** A main window and its detached windows (#252, #552), keyed by the daemon's port: one main window per Hive. */
export interface MainWindow { win: BrowserWindow; detached: DetachedWindows }

/** The main window that owns the sender, and the window that sent it: a sheet belongs on the window that asked (#552). */
export interface WindowSender { entry: MainWindow; win: BrowserWindow }

export type SenderWindow = (event: IpcSender, scope: WindowScope) => WindowSender;

/** Electron's dialog as the handlers use it: sheets on a window. */
export interface WindowDialogs {
  showOpenDialog(win: BrowserWindow, options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(win: BrowserWindow, options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
}

/** Electron's clipboard as the handlers use it: the sandboxed preload has none, so main reads and writes it. */
export interface WindowClipboard { read(format: string): string; writeBuffer(format: string, buffer: Buffer): void }

export interface WindowIpcDeps {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void; // ipcMain.handle
  mainWindows: ReadonlyMap<number, MainWindow>;
  dialog: WindowDialogs;
  clipboard: WindowClipboard;
  settingsChanged(): Promise<void>; // the viewer re-reads onClose (#513) and rebuilds the app menu with the saved shortcuts (#449)
}

// The sender's main window, on its own port: a page the daemon redirected elsewhere keeps the preload but gets nothing. A main window's page
// only, until detached senders are found through their registry (#552)
function senderWindow({ mainWindows }: Pick<WindowIpcDeps, 'mainWindows'>, event: IpcSender, scope: WindowScope): WindowSender {
  for (const [port, entry] of mainWindows) {
    if (entry.win.webContents !== event.sender) continue;
    if (scope === 'detached' || !event.senderFrame?.url.startsWith(`http://127.0.0.1:${port}/`)) break;
    return { entry, win: entry.win };
  }
  throw new Error('janela não encontrada');
}

// ⌘V in the files tree (#594) and a terminal (#843), ⌘C and ⌘X in the tree (#818)
function registerClipboard(handle: WindowIpcDeps['handle'], sender: SenderWindow, clipboard: WindowClipboard): void {
  // The files Finder put on the clipboard
  handle('window:clipboardFiles', (event) => {
    sender(event, 'shared');
    return parseClipboardFiles(clipboard.read('NSFilenamesPboardType'), clipboard.read('public.file-url'));
  });
  // The files on the pasteboard as Finder's ⌘C writes them, so they paste in Finder and back in the tree. Only NSFilenamesPboardType: each
  // writeBuffer replaces the pasteboard, so a public.file-url written after it would erase it, and both Finder's paste and
  // parseClipboardFiles read the plist first. Absolute paths only, checked here: IPC is untrusted.
  handle('window:writeClipboardFiles', (event, paths: unknown) => {
    sender(event, 'shared');
    if (!isClipboardPathList(paths)) {
      throw new Error('clipboard files must be absolute paths without control characters, and not too many');
    }
    clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(clipboardFilesPlist(paths), 'utf8'));
  });
}

/** The shared handlers (#202, #295, #513, #585, #594, #818), each scoped `shared` (spec decision 17); answers the sender check for the
 *  handlers of detach-ipc.ts. */
export function registerWindowIpc(deps: WindowIpcDeps): SenderWindow {
  const { handle, dialog } = deps;
  const sender: SenderWindow = (event, scope) => senderWindow(deps, event, scope);
  // The settings form's "Choose…" (#202): the native folder picker, as a sheet on the window that asked
  handle('window:chooseFolder', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(sender(event, 'shared').win, { properties: ['openDirectory'] });
    return canceled ? undefined : filePaths[0];
  });
  // The settings form's save: a rejection reaches the page's toast; the save itself already went through
  handle('window:settingsChanged', async (event) => {
    sender(event, 'shared');
    await deps.settingsChanged();
  });
  registerClipboard(handle, sender, deps.clipboard);
  // An untitled file's ⌘S (#818): the OS's save dialog as a sheet on the window that asked; its own Replace? confirms an existing file
  handle('window:saveDialog', async (event, defaultPath: unknown) => {
    const { win } = sender(event, 'shared');
    const { canceled, filePath } = await dialog.showSaveDialog(win, typeof defaultPath === 'string' ? { defaultPath } : {});
    return canceled || filePath === undefined || filePath === '' ? undefined : filePath;
  });
  // The page's closeWindow shortcut (#585): its own window closes, through the close handler (#513) that may turn the last main window's close into a quit
  handle('window:closeWindow', (event) => {
    sender(event, 'shared').win.close();
  });
  // Whether the asking window is in full screen (#295): a window created full screen (restored there, #398) sends no enter event
  handle('window:isFullScreen', (event) => sender(event, 'shared').win.isFullScreen());
  return sender;
}
