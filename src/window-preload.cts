// The bridge of every Hive window, the main one and a detached one (#552): contextIsolation and the sandbox stay on, so the page gets these calls and nothing else of Electron.
// CommonJS (.cts → dist/src/window-preload.cjs): a sandboxed preload is loaded as a script with `require`, not as an ES module.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

// Electron wraps a handler's throw as "Error invoking remote method 'window:moveToWindow': Error: <message>"; the page's toast
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

// Messages main sends before the page has subscribed (#252, #552): a page still loading has no listener yet, and a message without one is
// lost. Every one waits here, in order; a later subscription replaces the earlier one (StrictMode mounts twice).
function heldUntilSubscribed(channel: string): (callback: (value: unknown) => void) => void {
  let listener: ((value: unknown) => void) | undefined;
  let held: unknown[] = [];
  ipcRenderer.on(channel, (_event, value: unknown) => {
    if (listener) listener(value);
    else held = [...held, value];
  });
  return (callback) => {
    listener = callback;
    const due = held;
    held = [];
    for (const value of due) callback(value);
  };
}

// A tab docked back to this main window (#252, #552): two windows can dock during one reload
const onDock = heldUntilSubscribed('window:dock');
// A tab moved into this detached window (#552): the first window:open lands as the page loads, before it has mounted
const onOpen = heldUntilSubscribed('window:open');

// The user closed this detached window while it holds tabs (#552): one request is enough, so one waits
let closingListener: (() => void) | undefined;
let isClosingHeld = false;
ipcRenderer.on('window:closing', () => {
  if (closingListener) closingListener();
  else isClosingHeld = true;
});

// Cmd+W / Window → Fechar on this main window (#358): main asks the page, since only the page knows where its focus is. The close key closes
// a tab or does nothing (#612). With no tab, or no callback (the center on Automação, the Settings form over the views, a page still
// loading), the window stays: it closes only through Close Window or its own button, so a stray press never quits the Hive.
let closeKeyListener: (() => void) | undefined;
ipcRenderer.on('window:close', () => closeKeyListener?.());

// Full screen (#295): main sends window:fullScreen on the window's enter and leave; nothing is held, since the page asks isFullScreen at load.
// Untrusted IPC: only a boolean reaches the page
let fullScreenListener: ((on: boolean) => void) | undefined;
ipcRenderer.on('window:fullScreen', (_event, on: unknown) => {
  if (typeof on === 'boolean') fullScreenListener?.(on);
});

const bridge: HiveWindow = {
  chooseFolder: () => invoke('window:chooseFolder'),
  onSelect: (callback) => {
    selectListener = callback;
    if (heldSelection === undefined) return;
    callback(heldSelection);
    heldSelection = undefined;
  },
  settingsChanged: () => invoke('window:settingsChanged'),
  onDock,
  moveToWindow: (tab) => invoke('window:moveToWindow', tab), // #552
  focusTab: (activity, key) => invoke('window:focusTab', activity, key),
  detachedTabs: () => invoke('window:detachedTabs'),
  onOpen,
  dock: (tab) => invoke('window:dock', tab),
  onClosing: (callback) => {
    closingListener = callback;
    if (!isClosingHeld) return;
    isClosingHeld = false;
    callback();
  },
  openTask: (taskId) => invoke('window:openTask', taskId), // #588 from a detached window
  tabsChanged: (refs) => ipcRenderer.send('window:tabs', refs), // sent: nothing to answer
  // The unsubscribe clears only its own callback: a stale cleanup must never drop a newer subscription (a remount, StrictMode)
  onCloseKey: (callback) => {
    closeKeyListener = callback;
    return () => {
      if (closeKeyListener === callback) closeKeyListener = undefined;
    };
  },
  closeWindow: () => invoke('window:closeWindow'), // #585
  pathForFile: (file) => webUtils.getPathForFile(file), // #594: synchronous, and only the preload may call it
  clipboardFiles: () => invoke('window:clipboardFiles'),
  writeClipboardFiles: (paths) => invoke('window:writeClipboardFiles', paths), // #818
  saveDialog: (defaultPath) => invoke('window:saveDialog', defaultPath), // #818
  isFullScreen: () => invoke('window:isFullScreen'), // #295
  onFullScreen: (callback) => {
    fullScreenListener = callback;
    return () => {
      if (fullScreenListener === callback) fullScreenListener = undefined;
    };
  },
  themeResolved: (theme) => ipcRenderer.send('window:theme', theme), // #648: sent, nothing to answer
};

contextBridge.exposeInMainWorld('hive', bridge);
