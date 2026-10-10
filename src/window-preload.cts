// The main window's bridge: contextIsolation and the sandbox stay on, so the page gets these calls and nothing else of Electron.
// CommonJS (.cts → dist/src/window-preload.cjs): a sandboxed preload is loaded as a script with `require`, not as an ES module.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

// Electron wraps a handler's throw as "Error invoking remote method 'window:detach': Error: <message>"; the page's toast
// shows the message alone.
const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;

const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args).catch((err: Error) => {
    throw new Error(err.message.replace(IPC_PREFIX, ''));
  });

// The menu bar's worker lines (#192): main sends window:select once the page has loaded, which can be before App has subscribed, and a
// message without a listener is lost. The last request waits here; a later subscription replaces the earlier one (StrictMode mounts twice).
let selectListener: ((selection: unknown) => void) | undefined;
let heldSelection: unknown;
ipcRenderer.on('window:select', (_event, selection: unknown) => {
  if (selectListener) selectListener(selection);
  else heldSelection = selection;
});

// A detached window docked back (#252): main sends window:dock, which a page still loading (a reload) has not subscribed to yet. Every dock
// waits here, not only the last one: two windows can dock during one reload. A later subscription replaces the earlier one.
let dockListener: ((tab: unknown) => void) | undefined;
let heldDocks: unknown[] = [];
ipcRenderer.on('window:dock', (_event, tab: unknown) => {
  if (dockListener) dockListener(tab);
  else heldDocks = [...heldDocks, tab];
});

// Cmd+W / Window → Fechar on this main window (#358): main asks the page, since only the page knows where its focus is. The close key closes
// a tab or does nothing (#612). With no tab, or no callback (the center on Automação, the Settings form over the views, a page still
// loading), the window stays: it closes only through Close Window or its own button, so a stray press never quits the Hive.
let closeKeyListener: (() => void) | undefined;
ipcRenderer.on('window:close', () => closeKeyListener?.());

// A file link clicked in a detached window (#717): main sends window:openFile with the window already loaded, so nothing is held
let openFileListener: ((file: unknown) => void) | undefined;
ipcRenderer.on('window:openFile', (_event, file: unknown) => openFileListener?.(file));

const bridge: HiveWindow = {
  chooseFolder: () => invoke('window:chooseFolder'),
  onSelect: (callback) => {
    selectListener = callback;
    if (heldSelection === undefined) return;
    callback(heldSelection);
    heldSelection = undefined;
  },
  settingsChanged: () => invoke('window:settingsChanged'),
  detach: (tab) => invoke('window:detach', tab),
  focusDetached: (ptyId) => invoke('window:focusDetached', ptyId),
  detachedPtys: () => invoke('window:detachedPtys'),
  onDock: (callback) => {
    dockListener = callback;
    const held = heldDocks;
    heldDocks = [];
    for (const tab of held) callback(tab);
  },
  // The unsubscribe clears only its own callback: a stale cleanup must never drop a newer subscription (a remount, StrictMode)
  onCloseKey: (callback) => {
    closeKeyListener = callback;
    return () => {
      if (closeKeyListener === callback) closeKeyListener = undefined;
    };
  },
  onOpenFile: (callback) => {
    openFileListener = callback;
    return () => {
      if (openFileListener === callback) openFileListener = undefined;
    };
  },
  closeWindow: () => invoke('window:closeWindow'), // #585
  pathForFile: (file) => webUtils.getPathForFile(file), // #594: synchronous, and only the preload may call it
  clipboardFiles: () => invoke('window:clipboardFiles'),
  writeClipboardFiles: (paths) => invoke('window:writeClipboardFiles', paths), // #818
  saveDialog: (defaultPath) => invoke('window:saveDialog', defaultPath), // #818
};

contextBridge.exposeInMainWorld('hive', bridge);
