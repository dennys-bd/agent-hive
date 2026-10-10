// What a main window does for the editor pane (#717): refuses to lose unsaved edits to an unload, and takes a file link from a detached window.
import { type BrowserWindow, dialog } from 'electron';
import type { DetachedFile } from './detach-ipc.js';
import { t } from './ui/i18n.js';

const DISCARD_BUTTON = 0;
const CANCEL_BUTTON = 1;

/** A page holding unsaved edits asks before it goes (#717): the editor pane's beforeunload, answered with the native dialog. descartar lets
 * the unload (a reload, the window's close, a quit) go on. */
export function guardUnsavedEdits(win: BrowserWindow): void {
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', message: t('editor.discardConfirm'), buttons: [t('editor.discard'), t('main.cancel')], defaultId: CANCEL_BUTTON, cancelId: CANCEL_BUTTON,
    });
    if (choice === DISCARD_BUTTON) event.preventDefault();
  });
}

/** A file link clicked in one of a main window's detached windows (#717): that main window comes forward and opens the file in the run's
 * activity's editor pane, as a task reference opens its task (#588). The window is loaded: it is what opened the detached one. */
export function openFileOn(win: BrowserWindow, focusWindow: (win: BrowserWindow) => void): (file: DetachedFile) => void {
  return (file) => {
    focusWindow(win);
    win.webContents.send('window:openFile', file);
  };
}
