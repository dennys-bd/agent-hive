// What a Hive window does for the editor pane (#717, #552): refuses to lose unsaved edits to an unload.
import { type BrowserWindow, dialog } from 'electron';
import { t } from './ui/i18n.js';

const DISCARD_BUTTON = 0;
const CANCEL_BUTTON = 1;

/** A page holding unsaved edits asks before it goes (#717): the editor pane's beforeunload, answered with the native dialog. Discard lets
 * the unload (a reload, the window's close, a quit) go on; Cancel keeps the window, which onKept reports (#552: a detached window's kept
 * close keeps its main window open too). */
export function guardUnsavedEdits(win: BrowserWindow, onKept?: () => void): void {
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', message: t('editor.discardConfirm'), buttons: [t('editor.discard'), t('main.cancel')], defaultId: CANCEL_BUTTON, cancelId: CANCEL_BUTTON,
    });
    if (choice === DISCARD_BUTTON) event.preventDefault();
    else onKept?.();
  });
}
