import { fileURLToPath } from 'node:url';
import { BrowserWindow, clipboard, Menu, shell } from 'electron';
import { localActivityId } from './activities.js';
import { parseClipboardFiles } from './clipboard-files.js';
import { type BuildDetached, createDetachedWindows, type DetachedFile, type DetachedWindows, type DockTarget } from './detach-ipc.js';
import { isOpenableExternal } from './external-url.js';
import type { Logger } from './log.js';
import { SECRET_HEADER } from './secret.js';
import { readBounds, writeBounds } from './terminal-wire.js';

// runs from dist/src/terminal-window.js; the preload is tsc's CommonJS output of terminal-preload.cts
const PRELOAD = fileURLToPath(new URL('./terminal-preload.cjs', import.meta.url));

/** A main window's detached windows' deps. DockTarget (#252): onDock sends a docked run back to this main window's page (detach-ipc.ts's mainWindowDeps). */
export interface TerminalWindowDeps extends DockTarget {
  port: () => number; // where terminal.html is served; read at open time (assigned after listen)
  boundsFile: string; // <userData>/terminal-bounds.json
  background(): string; // the saved theme's --background (#296), read as each window opens: no white flash before the page paints
  // What the viewer set as the cookie of the main window's port (#467): terminal.html and its pty socket carry that cookie, and a shell's stop
  // request sends it as the header. Never hive.secret read afresh: a daemon that moved wrote a secret the main window's old port must not get.
  secretOf(port: number): string | undefined;
  onOpenTask(taskId: string): void; // a task reference clicked in a window (#588): main brings this main window forward on the task's panel
  onOpenFile(file: DetachedFile): void; // a file link clicked in a window (#717): main brings this main window forward on the file's editor pane
  log: Pick<Logger, 'error'>; // #742: the main process's errors reach hive.log
}

/** Links leave the app: a window request or a navigation off `origin` opens in the default browser. The main window uses it too. */
export function externalLinksToBrowser(win: BrowserWindow, origin: string, log: Pick<Logger, 'error'>): void {
  const open = (url: string): void => {
    if (!isOpenableExternal(url)) {
      log.error('a link with a scheme that is not http, https or mailto was not opened'); // never the URL
      return;
    }
    void shell.openExternal(url).catch((err: Error) => log.error(`openExternal failed: ${err.message}`)); // never the URL
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    open(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${origin}/`)) return;
    event.preventDefault();
    open(url);
  });
}

// Every detached window stores its bounds as it closes: the next one opens there (#252)
function saveBoundsOnClose(win: BrowserWindow, boundsFile: string, log: Pick<Logger, 'error'>): void {
  win.on('close', () => void writeBounds(boundsFile, win.getBounds()).catch((err: Error) => log.error(`terminal bounds failed: ${err.message}`)));
}

// A page that fails to load rejects: the caller's toast shows it, and no empty window is left behind
async function load(win: BrowserWindow, url: string): Promise<void> {
  await win.loadURL(url).catch((err: Error) => {
    if (!win.isDestroyed()) win.destroy(); // closeAll may have destroyed it, which is what aborted the load (#467)
    throw err;
  });
}

// The title strip's right-click (#340): macOS gives no hook on a native title bar, so the page draws its own and asks main for the menu. Its
// one item is the dock button's own path. The label crosses IPC, so it is checked before it reaches a Menu.
function popTitleMenu(win: BrowserWindow, label: unknown, dock: () => void): void {
  if (typeof label !== 'string' || label === '') return;
  Menu.buildFromTemplate([{ label, click: dock }]).popup({ window: win });
}

// The page's file links route on the run's activity (#258, #400, #629): a project's is its local activity; a task's tab names the task, not
// its activity, so its window links no file. ponytail: the main window no longer detaches a tab, so no task window is opened; carry the activity id
// in DetachedTab if one ever is again
const linkTarget = (tab: DetachedTab): Record<string, string> => (tab.project !== undefined ? { activity: localActivityId(tab.project) } : {});

// Closing a project shell's window stops the shell (#400), through the daemon's own stop route with the header every UI POST carries. A
// refusal (the shell had already ended, which is what closed its window) or a daemon that is gone is dropped: nothing is left to stop.
function stopShell({ port, secretOf }: Pick<TerminalWindowDeps, 'port' | 'secretOf'>): (ptyId: string) => void {
  return (ptyId) => {
    const secret = secretOf(port());
    if (secret === undefined) return; // this main window's port never got one: nothing of ours to stop there
    const url = `http://127.0.0.1:${port()}/ptys/${encodeURIComponent(ptyId)}/stop`;
    // the main process's fetch carries none of the page's cookies: the secret goes as a header (#467), and never follows a redirect elsewhere
    void fetch(url, { method: 'POST', headers: { 'x-hive-ui': '1', [SECRET_HEADER]: secret }, redirect: 'error' }).catch(() => undefined);
  };
}

// A detached internal run's window (#252). terminal.html in worker mode reads the daemon's pty routes itself, so there is no pty and no
// terminal IPC here except the page's own: the dock button's term:dock, the title's term:titleMenu (#340), the strip's term:move (#377), a task
// reference's term:openTask (#588), a file link's term:openFile (#717) and a paste's term:clipboardFiles (#843), scoped to this page by
// webContents.ipc. The native title bar is hidden and the page drags the window itself; letting go docks nothing (#440).
// It opens where the last terminal window closed.
function workerWindows(deps: TerminalWindowDeps): BuildDetached {
  return async (tab, on) => {
    const bounds = await readBounds(deps.boundsFile);
    // the main window's cookie is already in the session: its page opened with it, and a new boot on the same port re-set it (#467)
    if (deps.secretOf(deps.port()) === undefined) throw new Error('a janela principal não tem o segredo do daemon'); // no empty window
    const win = new BrowserWindow({ ...bounds, title: `${tab.label} — Agent Hive`, titleBarStyle: 'hiddenInset', backgroundColor: deps.background(), webPreferences: { preload: PRELOAD } }); // the page draws its title (#340)
    const origin = `http://127.0.0.1:${deps.port()}`;
    externalLinksToBrowser(win, origin, deps.log);
    win.webContents.ipc.on('term:dock', () => on.dock());
    win.webContents.ipc.on('term:titleMenu', (_event, label: unknown) => popTitleMenu(win, label, () => on.dock()));
    win.webContents.ipc.on('term:move', (_event, point: unknown) => on.moveTo(point)); // the strip's drag (#377), checked by the registry
    win.webContents.ipc.on('term:openTask', (_event, taskId: unknown) => on.openTask(taskId)); // a task reference's click (#588), checked by the registry
    win.webContents.ipc.on('term:openFile', (_event, file: unknown) => on.openFile(file)); // a file link's click (#717), checked by the registry
    // a paste (#843): the files Finder put on the clipboard, as the main window's window:clipboardFiles reads them; the sandboxed preload has no clipboard
    win.webContents.ipc.handle('term:clipboardFiles', () => parseClipboardFiles(clipboard.read('NSFilenamesPboardType'), clipboard.read('public.file-url')));
    saveBoundsOnClose(win, deps.boundsFile, deps.log);
    win.on('closed', () => on.closed());
    on.created(win); // before the load: a main window closing destroys it now, aborting a load the old port may hold open (#467)
    await load(win, `${origin}/terminal.html?${new URLSearchParams({ pty: tab.ptyId, ...linkTarget(tab), title: tab.label })}`);
    return win;
  };
}

/** A main window's detached windows (#252): the registry of detach-ipc.ts over the one module that builds a terminal BrowserWindow. The detach
 * logic is createDetachedWindows, tested with fakes. */
export function createTerminalWindows(deps: TerminalWindowDeps): DetachedWindows {
  return createDetachedWindows({ build: workerWindows(deps), onDock: deps.onDock, onOpenTask: deps.onOpenTask, onOpenFile: deps.onOpenFile, stopShell: stopShell(deps) });
}
