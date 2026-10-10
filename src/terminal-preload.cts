// A detached run's window's bridge (#252): contextIsolation and the sandbox stay on, so the page gets these calls and nothing else of
// Electron. CommonJS (.cts → dist/src/terminal-preload.cjs): a sandboxed preload is loaded as a script with `require`, not as an ES module.
import { contextBridge, ipcRenderer } from 'electron';

const bridge: HiveTerminal = {
  dock: () => ipcRenderer.send('term:dock'), // back to the main window's panel
  titleMenu: (label) => ipcRenderer.send('term:titleMenu', label), // #340: main pops the native menu on this window
  moveTo: (point) => ipcRenderer.send('term:move', point), // #377: main checks the point before it moves this window
  openFile: (file) => ipcRenderer.send('term:openFile', file), // #717: main checks it, then the main window opens the file in its editor pane
  openTask: (taskId) => ipcRenderer.send('term:openTask', taskId), // #588: main checks it, then the main window selects the task
  clipboardFiles: () => ipcRenderer.invoke('term:clipboardFiles'), // #843: main reads the clipboard; a rejection pastes the text
};

contextBridge.exposeInMainWorld('hiveTerminal', bridge);
