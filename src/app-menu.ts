// The viewer's application menu (#242). Electron's default one is English and carries a View menu (reload, DevTools, zoom) a Hive user does
// not need. Every item but Settings… and Close keeps its role, so the shortcuts and the native behaviour stay, and gets a label in the Hive's
// language: a role alone is labelled by Electron in English. Edit must stay: on macOS Cmd+C / Cmd+V / Cmd+Z only reach a page through items
// with those roles. Off macOS its items show their keys but do not register them (#644): the menu would take Ctrl+C / V / X / Z / A before the
// terminal's program, and Chromium handles those keys in a text field on its own. Close has no role (#358): the close role would close the
// window before a main window could close the terminal tab its focus is in, so the item carries the close shortcut itself and onClose
// decides. Settings… carries the fixed Cmd+, (#481) and Close its shortcut's binding (#449). Full screen and close window carry their
// shortcuts' bindings too (#585). Electron is imported for its types only, so node:test covers it; main.ts builds and sets it.
import type { BaseWindow, MenuItemConstructorOptions } from 'electron';
import { type Bindings, FIXED_BINDINGS } from './shortcuts.js';
import { type MessageKey, t } from './ui/i18n.js';

type Role = NonNullable<MenuItemConstructorOptions['role']>;

const item = (role: Role, key: MessageKey): MenuItemConstructorOptions => ({ role, label: t(key) });
// An Edit item (#644): on macOS a plain role item; off macOS its key is shown but not registered, so it stays the terminal program's
const editItem = (role: Role, key: MessageKey, isMac: boolean): MenuItemConstructorOptions =>
  (isMac ? item(role, key) : { ...item(role, key), registerAccelerator: false });
const SEPARATOR: MenuItemConstructorOptions = { type: 'separator' };
// Close's binding as its item's accelerator (#449); turned off leaves the item without any, still reachable by a click.
const accelerator = (binding: string | null): Pick<MenuItemConstructorOptions, 'accelerator'> => (binding === null ? {} : { accelerator: binding });

// Full screen (#585): Electron's togglefullscreen role on the shortcut's binding. A role with no accelerator gets Electron's own (Ctrl+Cmd+F,
// F11), so while the shortcut is off the item drops the role and toggles through its click, with no key.
function fullScreenItem(binding: string | null): MenuItemConstructorOptions {
  const label = t('main.menu.fullScreen');
  if (binding !== null) return { role: 'togglefullscreen', label, accelerator: binding };
  return { label, click: (_item, win) => win?.setFullScreen(!win.isFullScreen()) };
}

/** The app menu, Edit and Window, labelled in the current language. Settings… has no role: onSettings opens the settings form, as the menu
 *  bar's Settings… does. Quit's role emits before-quit, which goes through quitHive like Cmd+Q. Close gets the window the click names (the
 *  focused one for Cmd+W, undefined with none) and hands it to onClose. The app menu has no label: macOS titles it with the app's name.
 *  isMac: whether Edit's keys are registered (#644). */
export function appMenuTemplate(onSettings: () => void, onClose: (win: BaseWindow | undefined) => void, bindings: Bindings, isMac: boolean): MenuItemConstructorOptions[] {
  return [
    {
      role: 'appMenu',
      submenu: [
        item('about', 'main.menu.about'), SEPARATOR,
        { label: t('main.settings'), accelerator: FIXED_BINDINGS.settings, click: onSettings }, SEPARATOR,
        item('hide', 'main.menu.hide'), item('hideOthers', 'main.menu.hideOthers'), item('unhide', 'main.menu.showAll'), SEPARATOR,
        item('quit', 'main.quit'),
      ],
    },
    {
      role: 'editMenu',
      label: t('main.menu.edit'),
      submenu: [
        editItem('undo', 'main.menu.undo', isMac), editItem('redo', 'main.menu.redo', isMac), SEPARATOR,
        editItem('cut', 'main.menu.cut', isMac), editItem('copy', 'main.menu.copy', isMac), editItem('paste', 'main.menu.paste', isMac),
        editItem('selectAll', 'main.menu.selectAll', isMac),
      ],
    },
    {
      role: 'windowMenu',
      label: t('main.menu.window'),
      submenu: [
        item('minimize', 'main.menu.minimize'), item('zoom', 'main.menu.zoom'), fullScreenItem(bindings.fullScreen), SEPARATOR,
        { label: t('main.menu.close'), ...accelerator(bindings.close), click: (_item, win) => onClose(win) },
        // #585: the focused window closes at once, as window:closeWindow closes it; the app and the daemon keep running (its close handler, #513)
        { label: t('main.menu.closeWindow'), ...accelerator(bindings.closeWindow), click: (_item, win) => win?.close() }, SEPARATOR,
        item('front', 'main.menu.front'),
      ],
    },
  ];
}
