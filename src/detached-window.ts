import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, shell } from 'electron';
import { type BuildDetached, createDetachedWindows, type DetachedEvents, type DetachedWindows, type DockTarget } from './detach-ipc.js';
import { isOpenableExternal } from './external-url.js';
import type { Logger } from './log.js';
import { guardUnsavedEdits } from './main-window-guards.js';
import { readBounds, writeBounds } from './terminal-wire.js';

// runs from dist/src/detached-window.js: tsc's CommonJS output of window-preload.cts, the one preload of both kinds of window (#552)
export const WINDOW_PRELOAD = fileURLToPath(new URL('./window-preload.cjs', import.meta.url));
// The handoff's: 12px lights 16px from the top of a 44px header. A detached window hides its title bar as the main window does (#533, #552)
export const TRAFFIC_LIGHTS = { x: 14, y: 16 };

/** A main window's detached windows' deps. DockTarget: onDock sends a docked tab back to this main window's page (detach-ipc.ts's mainWindowDeps). */
export interface DetachedWindowDeps extends DockTarget {
  port: () => number; // the main window's port, where the page is served; read at open time
  boundsFile: string; // <userData>/detached-window-bounds.json
  background(): string; // the saved theme's --background (#296), read as each window opens: no white flash before the page paints
  // What the viewer set as the cookie of the main window's port (#467): the page carries that cookie. Never hive.secret read afresh: a daemon
  // that moved wrote a secret the main window's old port must not get
  secretOf(port: number): string | undefined;
  onOpenTask(taskId: string): void; // a task reference clicked in a window (#588): main brings this main window forward on the task's panel
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

// Every detached window stores its bounds as it closes: the next one opens there (#252, #552)
function saveBoundsOnClose(win: BrowserWindow, boundsFile: string, log: Pick<Logger, 'error'>): void {
  win.on('close', () => void writeBounds(boundsFile, win.getBounds()).catch((err: Error) => log.error(`detached window bounds failed: ${err.message}`)));
}

// A page that fails to load rejects: the caller's toast shows it, and no empty window is left behind
async function load(win: BrowserWindow, url: string): Promise<void> {
  await win.loadURL(url).catch((err: Error) => {
    if (!win.isDestroyed()) win.destroy(); // closeAll may have destroyed it, which is what aborted the load (#467)
    throw err;
  });
}

// The window's own events to the registry (#552): its close (which the registry may prevent), its end, the unsaved-edits dialog's Cancel,
// the bounds the next window opens at, and the full screen the page's strip reads (#295)
function wire(win: BrowserWindow, on: DetachedEvents, deps: DetachedWindowDeps): void {
  guardUnsavedEdits(win, on.kept);
  saveBoundsOnClose(win, deps.boundsFile, deps.log);
  win.on('close', (event) => on.closing(event));
  win.on('closed', () => on.closed());
  win.on('enter-full-screen', () => win.webContents.send('window:fullScreen', true));
  win.on('leave-full-screen', () => win.webContents.send('window:fullScreen', false));
}

// A detached window (#552): the Hive's own page in window mode on the main window's port, with its preload, its hidden title bar and its
// background, where the last detached window closed. The title is the page's document.title (node 3); Agent Hive until it sets one.
function detachedWindows(deps: DetachedWindowDeps): BuildDetached {
  return async (activity, on) => {
    const bounds = await readBounds(deps.boundsFile);
    // the main window's cookie is already in the session: its page opened with it, and a new boot on the same port re-set it (#467)
    if (deps.secretOf(deps.port()) === undefined) throw new Error('a janela principal não tem o segredo do daemon'); // no empty window
    const win = new BrowserWindow({
      ...bounds, title: 'Agent Hive', titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS, backgroundColor: deps.background(), webPreferences: { preload: WINDOW_PRELOAD },
    });
    const origin = `http://127.0.0.1:${deps.port()}`;
    externalLinksToBrowser(win, origin, deps.log);
    wire(win, on, deps);
    on.created(win); // before the load: a main window going for another port destroys it now (#467)
    await load(win, `${origin}/index.html?${new URLSearchParams({ window: randomUUID(), activity })}`);
    return win;
  };
}

/** A main window's detached windows (#552): the registry of detach-ipc.ts over the one module that builds their BrowserWindows. The logic is
 *  createDetachedWindows, tested with fakes. */
export function createDetachedWindowsFor(deps: DetachedWindowDeps): DetachedWindows {
  return createDetachedWindows({ build: detachedWindows(deps), onDock: deps.onDock, onOpenTask: deps.onOpenTask });
}
