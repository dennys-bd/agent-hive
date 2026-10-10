import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BaseWindow, MenuItemConstructorOptions } from 'electron';
import { appMenuTemplate } from '../src/app-menu.js';
import { type Bindings, effectiveBindings } from '../src/shortcuts.js';
import type { Shortcuts } from '../src/types.js';
import { setLanguage, t } from '../src/ui/i18n.js';

const SETTINGS_KEY = 'CmdOrCtrl+,';
const CLOSE_KEY = 'CmdOrCtrl+W';
const DEFAULTS = effectiveBindings({}, true); // no shortcut changed (#449), on macOS
// a menu's items without its separators
const items = (menu: MenuItemConstructorOptions): MenuItemConstructorOptions[] =>
  (menu.submenu as MenuItemConstructorOptions[]).filter((item) => item.type !== 'separator');

test('appMenuTemplate: the app, Edit and Window menus and no View; every item but Settings…, Close and the separators keeps its role (#242, #358)', () => {
  const menus = appMenuTemplate(() => {}, () => {}, DEFAULTS, true);
  assert.deepEqual(menus.map((m) => m.role), ['appMenu', 'editMenu', 'windowMenu'], 'no View: reload, DevTools and zoom are not for a Hive user');
  assert.deepEqual(menus.map((m) => items(m).map((item) => item.role ?? item.accelerator)), [
    ['about', SETTINGS_KEY, 'hide', 'hideOthers', 'unhide', 'quit'],
    ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'],
    ['minimize', 'zoom', 'togglefullscreen', CLOSE_KEY, 'CmdOrCtrl+Shift+W', 'front'],
  ], 'the roles keep the shortcuts: Cmd+C / Cmd+V only reach the page through them, and quit goes through before-quit');
});

test('appMenuTemplate in pt: every label in the Hive\'s language; Settings… calls onSettings (#242)', (t) => {
  t.after(() => setLanguage('en'));
  setLanguage('pt');
  let opened = 0;
  const menus = appMenuTemplate(() => {
    opened += 1;
  }, () => {}, DEFAULTS, true);
  assert.deepEqual(menus.map((m) => [m.label, items(m).map((item) => item.label)]), [
    [undefined, ['Sobre o Agent Hive', 'Configurações…', 'Ocultar Agent Hive', 'Ocultar outros', 'Mostrar tudo', 'Sair']],
    ['Editar', ['Desfazer', 'Refazer', 'Recortar', 'Copiar', 'Colar', 'Selecionar tudo']],
    ['Janela', ['Minimizar', 'Zoom', 'Tela cheia', 'Fechar', 'Fechar janela', 'Trazer tudo para a frente']],
  ], 'the app menu is titled by macOS with the app name');
  const settings = items(menus[0]).find((item) => item.accelerator === SETTINGS_KEY);
  assert.ok(settings, 'Settings… is in the app menu');
  (settings.click as () => void)();
  assert.equal(opened, 1);
});

test('appMenuTemplate: Window → Close has no role but Cmd+W, so a source can close its terminal tab first; its click hands onClose the window it names (#358)', () => {
  const asked: (BaseWindow | undefined)[] = [];
  const menus = appMenuTemplate(() => {}, (win) => {
    asked.push(win);
  }, DEFAULTS, true);
  const close = items(menus[2]).find((item) => item.accelerator === CLOSE_KEY);
  assert.ok(close, 'Close is in the Window menu');
  assert.equal(close.role, undefined, 'the close role would close the window before the board is asked');
  const click = close.click as (item: unknown, win: BaseWindow | undefined) => void;
  const win = {} as BaseWindow;
  click(undefined, win);
  click(undefined, undefined); // no focused window: main closes nothing
  assert.deepEqual(asked, [win, undefined]);
});

// Settings… and Close, found by label, and the accelerator each carries ('none' for an item without one)
function accelerators(bindings: Bindings): unknown[] {
  const menus = appMenuTemplate(() => {}, () => {}, bindings, true);
  const settings = items(menus[0]).find((item) => item.label === t('main.settings'));
  const close = items(menus[2]).find((item) => item.label === t('main.menu.close'));
  return [settings, close].map((item) => (item === undefined ? 'missing' : (item.accelerator ?? 'none')));
}

test('appMenuTemplate: Settings… always carries the fixed CmdOrCtrl+, (#481); Close takes its shortcut\'s binding, and turned off leaves the item without one (#449)', () => {
  assert.deepEqual(accelerators(DEFAULTS), [SETTINGS_KEY, CLOSE_KEY]);
  assert.deepEqual(accelerators(effectiveBindings({ close: 'CmdOrCtrl+Shift+W' }, true)), [SETTINGS_KEY, 'CmdOrCtrl+Shift+W']);
  assert.deepEqual(accelerators(effectiveBindings({ close: null }, true)), [SETTINGS_KEY, 'none'], 'the item stays, reachable by a click');
  const stale = { settings: null, close: null } as unknown as Shortcuts; // a map from before #481: settings is no shortcut
  assert.deepEqual(accelerators(effectiveBindings(stale, true)), [SETTINGS_KEY, 'none']);
});

test('appMenuTemplate: Window has full screen, Electron\'s togglefullscreen role on its shortcut\'s binding, and close window, which closes the window it names; neither has a key while turned off (#585)', () => {
  const window = (bindings: Bindings): MenuItemConstructorOptions[] => items(appMenuTemplate(() => {}, () => {}, bindings, true)[2]);
  const byLabel = (menu: MenuItemConstructorOptions[], key: 'main.menu.fullScreen' | 'main.menu.closeWindow') => menu.find((item) => item.label === t(key));
  const click = (item: MenuItemConstructorOptions | undefined) => item?.click as (menuItem: unknown, win: BaseWindow | undefined) => void;
  const mac = window(DEFAULTS);
  assert.deepEqual([byLabel(mac, 'main.menu.fullScreen')?.role, byLabel(mac, 'main.menu.fullScreen')?.accelerator], ['togglefullscreen', 'CmdOrCtrl+Shift+F']);
  let closed = 0;
  click(byLabel(mac, 'main.menu.closeWindow'))(undefined, { close: () => { closed += 1; } } as unknown as BaseWindow);
  click(byLabel(mac, 'main.menu.closeWindow'))(undefined, undefined); // no focused window: nothing
  assert.equal(closed, 1);
  const other = window(effectiveBindings({}, false));
  assert.deepEqual([byLabel(other, 'main.menu.fullScreen')?.accelerator, byLabel(other, 'main.menu.closeWindow')?.accelerator], ['F11', 'CmdOrCtrl+Alt+Shift+W']);
  const off = window(effectiveBindings({ fullScreen: null, closeWindow: null }, true));
  const full = byLabel(off, 'main.menu.fullScreen');
  assert.deepEqual([full?.role, full?.accelerator, byLabel(off, 'main.menu.closeWindow')?.accelerator], [undefined, undefined, undefined], 'no role: the role would bring Electron\'s own key');
  let isFull = false;
  click(full)(undefined, { isFullScreen: () => isFull, setFullScreen: (next: boolean) => { isFull = next; } } as unknown as BaseWindow);
  assert.equal(isFull, true);
});

test('appMenuTemplate off macOS: every Edit item keeps its role and shows its key but registers none, so Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z and Ctrl+A reach the terminal\'s program; on macOS they register as before (#644)', () => {
  const edit = (isMac: boolean): MenuItemConstructorOptions[] => items(appMenuTemplate(() => {}, () => {}, effectiveBindings({}, isMac), isMac)[1]);
  assert.deepEqual(edit(false).map((item) => [item.role, item.registerAccelerator]), [
    ['undo', false], ['redo', false], ['cut', false], ['copy', false], ['paste', false], ['selectAll', false],
  ], 'Chromium handles those keys in a text field on its own');
  assert.deepEqual(edit(true).map((item) => item.role), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  assert.deepEqual(edit(true).filter((item) => 'registerAccelerator' in item), [], 'on macOS ⌘C / ⌘V only reach a page through the role items (#242)');
  const others = appMenuTemplate(() => {}, () => {}, effectiveBindings({}, false), false).filter((menu) => menu.role !== 'editMenu');
  assert.deepEqual(others.flatMap(items).filter((item) => 'registerAccelerator' in item), [], 'only the Edit menu changes');
});
