// The IPC every Hive page shares (#552): a main window's, and a detached window's, since both load the one preload (window-preload.cts) and
// the scope is checked here, never by which preload loaded. Out of main.ts, past its 400 lines. Electron's dialog and clipboard come in as
// deps, so node:test drives it with fakes. Every handler resolves its sender first: a page the daemon redirected elsewhere keeps the preload
// but gets nothing.
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { clipboardFilesPlist, dropFilesBuffer, isClipboardPathList, parseClipboardFiles, parseDropFiles } from './clipboard-files.js';
import type { DetachedWindows } from './detach-ipc.js';
import { titleBarOverlayFor } from './window-options.js';

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
export interface WindowClipboard { read(format: string): string; readBuffer(format: string): Buffer; writeBuffer(format: string, buffer: Buffer): void }

export interface WindowIpcDeps {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void; // ipcMain.handle
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void; // ipcMain.on: window:theme is sent, never invoked
  platform: NodeJS.Platform; // process.platform: only win32 has a caption overlay to recolour (#648)
  mainWindows: ReadonlyMap<number, MainWindow>;
  fromWebContents(webContents: IpcMainInvokeEvent['sender']): BrowserWindow | null; // BrowserWindow.fromWebContents: a detached sender's own window
  dialog: WindowDialogs;
  clipboard: WindowClipboard;
  settingsChanged(): Promise<void>; // the viewer re-reads onClose (#513) and rebuilds the app menu with the saved shortcuts (#449)
}

// The sender's main window, and the window that sent it (spec decision 16): a main window's page, or one of its detached windows, found
// through that main window's registry. Either way the frame must be on the entry's port: a page the daemon redirected elsewhere keeps the
// preload but gets nothing.
function senderWindow({ mainWindows, fromWebContents }: Pick<WindowIpcDeps, 'mainWindows' | 'fromWebContents'>, event: IpcSender, scope: WindowScope): WindowSender {
  for (const [port, entry] of mainWindows) {
    const isMain = entry.win.webContents === event.sender;
    if (!isMain && !entry.detached.owns(event.sender)) continue;
    const win = isMain ? entry.win : fromWebContents(event.sender);
    const isInScope = scope === 'shared' || (scope === 'main') === isMain;
    if (win === null || !isInScope || !event.senderFrame?.url.startsWith(`http://127.0.0.1:${port}/`)) break;
    return { entry, win };
  }
  throw new Error('janela não encontrada');
}

// Windows' first file only, as FileNameW carries it: UTF-16LE cut at its first null
const firstFileName = (buffer: Buffer): string[] => {
  const name = buffer.toString('utf16le').split('\0')[0];
  return name === '' ? [] : [name];
};

// Electron registers a format name through RegisterClipboardFormat, so 'CF_HDROP' may not be the standard id 15; FileNameW is known to carry
// the first file, which keeps a single-file paste working when the list does not come through.
function readWin32Files(clipboard: WindowClipboard): string[] {
  const listed = parseDropFiles(clipboard.readBuffer('CF_HDROP'));
  return listed.length > 0 ? listed : firstFileName(clipboard.readBuffer('FileNameW'));
}

// Finder's pasteboard: the plist of every path, else the first file's URL
const readPasteboardFiles = (clipboard: WindowClipboard): string[] =>
  parseClipboardFiles(clipboard.read('NSFilenamesPboardType'), clipboard.read('public.file-url'));

const readClipboardFiles = (clipboard: WindowClipboard, platform: NodeJS.Platform): string[] =>
  platform === 'win32' ? readWin32Files(clipboard) : readPasteboardFiles(clipboard);

// Only one format: each writeBuffer replaces the clipboard, so a second one written after it would erase the first, and both Explorer's and
// Finder's paste, and our own read, take this one first.
function writeClipboardFiles(clipboard: WindowClipboard, platform: NodeJS.Platform, paths: string[]): void {
  if (platform === 'win32') clipboard.writeBuffer('CF_HDROP', dropFilesBuffer(paths));
  else clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(clipboardFilesPlist(paths), 'utf8'));
}

// ⌘V in the files tree (#594) and a terminal (#843), ⌘C and ⌘X in the tree (#818), on Windows too (#650)
function registerClipboard(handle: WindowIpcDeps['handle'], sender: SenderWindow, clipboard: WindowClipboard, platform: NodeJS.Platform): void {
  // The files the system's file manager put on the clipboard
  handle('window:clipboardFiles', (event) => {
    sender(event, 'shared');
    return readClipboardFiles(clipboard, platform);
  });
  // The files on the clipboard as the file manager's copy writes them, so they paste there and back in the tree. Absolute paths only, checked
  // here: IPC is untrusted. The write is read back: one the system swallowed must reach the tree as an error, not as a copy that pastes nothing.
  handle('window:writeClipboardFiles', (event, paths: unknown) => {
    sender(event, 'shared');
    if (!isClipboardPathList(paths, platform)) {
      throw new Error('clipboard files must be absolute paths without control characters, and not too many');
    }
    writeClipboardFiles(clipboard, platform, paths);
    const written = readClipboardFiles(clipboard, platform);
    if (written.length !== paths.length || written.some((path, i) => path !== paths[i])) {
      throw new Error('the clipboard did not take the files');
    }
  });
}

// The page's resolved theme (#648): on Windows the caption buttons follow it live, a forced theme or the system's appearance changing.
// Untrusted IPC: only light or dark is used. A refused sender is swallowed, as window:tabs does: a sent message has no caller to refuse to.
function registerThemeOverlay({ on, platform }: Pick<WindowIpcDeps, 'on' | 'platform'>, sender: SenderWindow): void {
  on('window:theme', (event, theme) => {
    if (platform !== 'win32' || (theme !== 'light' && theme !== 'dark')) return;
    try {
      sender(event, 'shared').win.setTitleBarOverlay(titleBarOverlayFor(theme));
    } catch {
      // no Hive page of ours: nothing to recolour
    }
  });
}

/** The shared handlers (#202, #295, #513, #585, #594, #648, #818), each scoped `shared` (spec decision 17); answers the sender check for the
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
  registerClipboard(handle, sender, deps.clipboard, deps.platform);
  registerThemeOverlay(deps, sender);
  // An untitled file's ⌘S (#818): the OS's save dialog as a sheet on the window that asked; its own Replace? confirms an existing file
  handle('window:saveDialog', async (event, defaultPath: unknown) => {
    const { win } = sender(event, 'shared');
    const { canceled, filePath } = await dialog.showSaveDialog(win, typeof defaultPath === 'string' ? { defaultPath } : {});
    return canceled || filePath === undefined || filePath === '' ? undefined : filePath;
  });
  // The page's closeWindow (#585, spec decision 7): a main window closes through its close handler (#513), which may turn the last one's close
  // into a quit; a detached window is destroyed by its registry, since its page calls this only once it holds nothing left to guard
  handle('window:closeWindow', (event) => {
    const { entry, win } = sender(event, 'shared');
    if (win === entry.win) win.close();
    else entry.detached.closeWindow(event.sender);
  });
  // Whether the asking window is in full screen (#295): a window created full screen (restored there, #398) sends no enter event
  handle('window:isFullScreen', (event) => sender(event, 'shared').win.isFullScreen());
  return sender;
}
