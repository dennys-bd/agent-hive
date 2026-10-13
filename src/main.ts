import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, type BaseWindow, BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent, Menu, type MenuItemConstructorOptions, type NativeImage, nativeImage, nativeTheme, screen, session, Tray } from 'electron';
import { appMenuTemplate } from './app-menu.js';
import { clipboardFilesPlist, isClipboardPathList, parseClipboardFiles } from './clipboard-files.js';
import { loadConfigIfPresent } from './config.js';
import { activeWorkers, configuredTheme, type DaemonAddress, type DaemonStatus, daemonStatus, ensureDaemon, menuLabel, ourDaemon, livePtys, setSignal, stopDaemon } from './daemon.js';
import { type DetachedWindows, registerDetachIpc } from './detach-ipc.js';
import { hiveHome } from './home.js';
import { languageFrom } from './language.js';
import { guardUnsavedEdits, openFileOn } from './main-window-guards.js';
import { type MainWindowBounds, readMainWindowBounds, writeMainWindowBounds } from './main-window-bounds.js';
import { createNotifier } from './notify-viewer.js';
import { effectiveBindings } from './shortcuts.js';
import { createTerminalWindows, externalLinksToBrowser } from './terminal-window.js';
import { signalItems, trayIconFile, type TraySignal, watchSignal } from './tray-signal.js';
import { METER_HEIGHT, METER_WIDTH, meterBitmap, usageItems } from './tray-usage.js';
import { type LivePty, type Shortcuts, type Signal, VIEWER_DEFAULTS, type ViewerSettings } from './types.js'; // ViewerSettings, VIEWER_DEFAULTS: the onClose setting (#513)
import { LOCALE, type MessageKey, type PluralFamily, setLanguage, t, tPlural } from './ui/i18n.js';
import type { MeterBand } from './ui/lib/usage.js';
import { createViewerAuth } from './viewer-auth.js';
import { homeLog } from './home-log.js';

const APP_NAME = 'Agent Hive';
// The two --background values of src/ui/theme.css (test/theme.test.ts keeps them in sync): a window paints before its page, so it takes
// the saved theme's background and never flashes white or the other theme (#296).
const WINDOW_BACKGROUND = { dark: '#111418', light: '#f5f6f8' } as const;
const BOUNDS_FILE = 'terminal-bounds.json'; // under userData
const MAIN_WINDOW_BOUNDS_FILE = 'main-window-bounds.json'; // under userData; the main window's own, next to the terminals' (#398)
// runs from dist/src/main.js; the asset is not copied by the build, the preload is tsc's CommonJS output of window-preload.cts
const ICON = fileURLToPath(new URL('../../assets/icon.png', import.meta.url));
// the menu bar template image (#191); Electron loads trayTemplate@2x.png next to it and tints it for the bar
const TRAY_ICON = fileURLToPath(new URL('../../assets/trayTemplate.png', import.meta.url));
// the menu bar icon with the effective signal's badge (#196), or trayTemplate with no signal: every tray image sits next to TRAY_ICON
const trayAsset = (file: string): string => fileURLToPath(new URL(`../../assets/${file}`, import.meta.url));
const WINDOW_PRELOAD = fileURLToPath(new URL('./window-preload.cjs', import.meta.url));
// the menu's worker dots (#192), in the main window's status colors and not template images; Electron loads dot-<status>@2x.png next to each.
// createFromPath never throws: a file that fails to load is an empty image, which dotFor leaves out of its line.
const dotIcon = (status: Exclude<LivePty['status'], 'terminal'>): NativeImage =>
  nativeImage.createFromPath(fileURLToPath(new URL(`../../assets/dot-${status}.png`, import.meta.url)));
const DOT_ICONS: Record<Exclude<LivePty['status'], 'terminal'>, NativeImage> = { working: dotIcon('working'), waiting: dotIcon('waiting'), review: dotIcon('review'), approval: dotIcon('approval'), backoff: dotIcon('backoff') }; // #805
// the Quit and Restart dialogs' buttons (#193, #194): the verb first; Cancel is the default and what Esc picks
const CONFIRM_BUTTON = 0;
const CANCEL_BUTTON = 1;
// the menu's first line (#194), in the Hive's language (#242), and the cut of the reason line under it: a native menu line does not wrap
const STATUS_KEYS: Record<DaemonStatus['state'], MessageKey> = {
  running: 'main.status.running', setup: 'main.status.setup', stopped: 'main.status.stopped', blocked: 'main.status.blocked',
};
// the Quit and Restart dialogs' text and verb (#193, #194), by how many workers the stop would kill (#242)
const STOP_TEXT: Record<'quit' | 'restart', { message: PluralFamily; verb: MessageKey }> = {
  quit: { message: 'main.confirm.quit', verb: 'main.quit' },
  restart: { message: 'main.confirm.restart', verb: 'main.restart' },
};
const REASON_MAX = 80;
const log = homeLog(); // #742: the main process's errors reach hive.log, not only a terminal it was started from

/** A main window and its detached terminal windows (#252), keyed by the daemon's port: one main window per Hive. */
interface MainWindow {
  win: BrowserWindow;
  terminals: DetachedWindows;
}

const mainWindows = new Map<number, MainWindow>();

// The main window's cookie (#467): the probed secret as a cookie of the daemon's port, set before any page of that daemon loads, once every
// window of another port is closed and its cookie removed. The session is read lazily: it exists only after app ready.
const { authorize, secretOf } = createViewerAuth(() => session.defaultSession.cookies, closeOtherPorts);

// authorize's first step (#467): the main windows of other ports and their detached windows go at once. destroy, not close: close is async and
// its handler may cancel it, while the page must stop before the new cookie is set; the bounds of a main window on a dead port are not kept.
function closeOtherPorts(port: number): void {
  for (const [other, mainWindow] of [...mainWindows]) {
    if (other === port) continue;
    mainWindows.delete(other);
    mainWindow.terminals.closeAll();
    mainWindow.win.destroy();
  }
}

// A main window already open on the daemon's port whose daemon has a new secret (a Restart, or `hive stop` then `hive`): the cookie is set again
// and the page reloaded, since its EventSource, refused with 403, never retries (#467)
async function refreshMainWindow(daemon: DaemonAddress): Promise<void> {
  if (await authorize(daemon)) mainWindows.get(daemon.port)?.win.webContents.reload();
}

// A main window open on a port the daemon left moves to its new one (#466); on its port, or with none open, the cookie is set again (#467)
async function followMainWindow(daemon: DaemonAddress): Promise<void> {
  if (mainWindows.size > 0 && !mainWindows.has(daemon.port)) await showMainWindow(daemon);
  else await refreshMainWindow(daemon);
}

// before ready so userData lives under "Agent Hive" instead of Electron's default dir;
// unpackaged, macOS still takes the Dock label from Electron's Info.plist, only the icon is ours
app.setName(APP_NAME);

// A HIVE_HOME viewer (#310) gets its own userData, next to that home: sharing the installed one's would make the single-instance
// lock and terminal-bounds.json collide with the real Hive instead of running a test one beside it.
if (process.env.HIVE_HOME) app.setPath('userData', join(hiveHome(), 'electron'));

// The main window of one daemon plus its detached terminal windows (#252). Closing the main window closes them (the runs go on in the daemon)
// and, when it was the last main window, the Dock icon: with onClose menuBar the viewer stays there (#191); with onClose quit closing the last
// main window is a quit (#513). A detached window never outlives its main window, so "a window is open" and "a main window is open" are the same thing.
// The saved theme resolved for a window about to open (#296): system reads nativeTheme, truthful because the Hive never sets its themeSource.
function windowBackground(): string {
  const theme = configuredTheme(hiveHome());
  const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark';
  return WINDOW_BACKGROUND[dark ? 'dark' : 'light'];
}

const TRAFFIC_LIGHTS = { x: 14, y: 16 }; // the handoff's: 12px lights 16px from the top of a 44px header
// #227: below this the footer's last step (handoff §6) stops fitting the usual content; a saved rectangle narrower than it is widened by Electron
const MIN_WIDTH = 960;

// Registered, not loaded: showMainWindow loads it once the port's cookie is in (#467)
function openMainWindow(port: number, bounds: MainWindowBounds): BrowserWindow {
  const origin = `http://127.0.0.1:${port}`;
  const { maximized, fullScreen, ...rect } = bounds;
  // The native title bar is hidden (#533): the header draws it, with the traffic lights centred in its 44px and inside its 84px left inset (#295: 12px in full screen, where macOS hides them).
  // fullscreen only when true: an explicit false makes the window not fullscreenable on macOS (the green light's +, no full screen key, #585)
  const win = new BrowserWindow({
    ...rect, ...(fullScreen ? { fullscreen: true } : {}), minWidth: MIN_WIDTH, titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS, backgroundColor: windowBackground(), webPreferences: { preload: WINDOW_PRELOAD },
  });
  if (maximized && !fullScreen) win.maximize();
  const terminals = createTerminalWindows({ port: () => port, boundsFile: join(app.getPath('userData'), BOUNDS_FILE), background: windowBackground, secretOf, ...detach.mainWindowDeps(win), onOpenTask: openTaskOn(win), onOpenFile: openFileOn(win, focusWindow), log });
  mainWindows.set(port, { win, terminals });
  showDock();
  // With onClose quit (#513) the last main window's close goes through before-quit like Cmd+Q: the settings decide whether the Hive stops,
  // and a Cancel in the warning keeps this window open. Its size, position and state are stored regardless (#398), the pre-maximize /
  // pre-fullscreen rectangle so a plain move or resize next time returns there; several main windows open, the last close wins.
  win.on('close', (event) => {
    const mainWindowBoundsFile = join(app.getPath('userData'), MAIN_WINDOW_BOUNDS_FILE);
    const stored: MainWindowBounds = { ...win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() };
    try {
      writeMainWindowBounds(mainWindowBoundsFile, stored);
    } catch (err) {
      log.error(`main window bounds failed: ${(err as Error).message}`); // a failed save never blocks the close
    }
    if (quitting || settings.onClose === 'menuBar' || mainWindows.size > 1) return;
    event.preventDefault();
    setImmediate(() => app.quit()); // out of this handler: the quit closes this very window
  });
  win.on('closed', () => {
    if (mainWindows.get(port)?.win !== win) return; // destroyed by closeOtherPorts, which already let its windows go
    mainWindows.delete(port);
    terminals.closeAll();
    whenNoMainWindow();
  });
  // #295: the header drops the window buttons' inset in full screen, where macOS hides them; the page asks window:isFullScreen at load
  win.on('enter-full-screen', () => win.webContents.send('window:fullScreen', true));
  win.on('leave-full-screen', () => win.webContents.send('window:fullScreen', false));
  guardUnsavedEdits(win);
  externalLinksToBrowser(win, origin, log);
  return win;
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function setDockIcon(): void {
  try {
    app.dock?.setIcon(ICON);
  } catch (err) {
    // a bad icon file is not worth refusing to start
    log.error(`dock icon failed: ${(err as Error).message}`);
  }
}

// The Dock icon shows only while a main window is open (#191). One that was hidden can come back with Electron's default image,
// so ours is set again once it is shown.
function showDock(): void {
  void app.dock?.show().then(setDockIcon, (err: Error) => log.error(`dock show failed: ${err.message}`));
}

// The menu bar icon (#191), with the effective signal's badge while the daemon streams one (#196), and its menu (#193): the Hive's status
// (#194), the signal radios and the running workers while it runs (#196, #192), then Show Hive, Settings…, Restart and Quit, while the
// onClose is menuBar (#513). The menu is built at every click: a native menu cannot change while it is open. The tray lives in module
// scope because a Tray that gets garbage-collected takes its icon with it.
let tray: Tray | undefined;
// The signal /events last reported (#196), undefined with none; the stream runs from ready whatever onClose says (#199).
let latestSignal: TraySignal | undefined;

function createTray(): void {
  try {
    tray = new Tray(TRAY_ICON);
  } catch (err) {
    // a bad icon file is not worth refusing to start: without a tray the viewer quits with its last main window, as before #191
    log.error(`menu bar icon failed: ${(err as Error).message}`);
    return;
  }
  tray.setToolTip(APP_NAME);
  const show = (): void => void showMenu().catch(reportError);
  tray.on('click', show);
  tray.on('right-click', show);
  paintTray(); // the stream runs from ready (#199): a new icon starts on the signal it already has
  nativeTheme.on('updated', paintTray); // the bar went light or dark: the badged comb swaps its ink
}

// The tray's /events connect (#196, #466, #467): our daemon's port and secret, probed together at every connect; the main window follows them.
// No daemon: nothing is authorized.
async function followDaemon(): Promise<DaemonAddress | undefined> {
  const daemon = await ourDaemon(hiveHome());
  if (daemon !== undefined) await followMainWindow(daemon);
  return daemon;
}

// Whether a main window has the focus (#199): then the user already sees the card change, and no notification shows
function isMainFocused(): boolean {
  const focused = BrowserWindow.getFocusedWindow();
  return [...mainWindows.values()].some((m) => m.win === focused);
}

// The daemon's /events from ready to quit (#196, #199): the badge's signal while the icon exists, and the notifications whatever onClose
// says. The address is read at every connect (#466, #467): a moved daemon is followed, a new secret re-authorizes the main window.
function watchDaemon(): void {
  const notify = createNotifier({ enabled: () => settings.notifications, isMainFocused, onClick: (taskId) => void showWorker({ taskId }).catch(reportError), log });
  watchSignal(followDaemon, (signal) => {
    latestSignal = signal;
    paintTray();
  }, log, notify);
}

// The icon for the signal and the bar (#196): the badged comb in black for a light bar and white for a dark one; with no signal the
// template, which macOS tints by itself. createFromPath never throws: a file that fails to load is an empty image, and TRAY_ICON stands in.
function paintTray(): void {
  if (!tray) return; // the stream runs without the icon too (#199)
  const image = nativeImage.createFromPath(trayAsset(trayIconFile(latestSignal, nativeTheme.shouldUseDarkColors)));
  tray?.setImage(image.isEmpty() ? TRAY_ICON : image);
}

// The icon goes (#513), and with it the appearance listener (#196); the stream goes on for the notifications (#199).
function destroyTray(): void {
  nativeTheme.removeListener('updated', paintTray);
  tray?.destroy();
  tray = undefined;
}

// Quitting stops the Hive first (#193). `quitting` lets the second pass of before-quit through once the daemon is down;
// `stopping` covers the count, the dialog and the stop of a Quit or a Restart (#194), so a second one meanwhile is ignored.
let quitting = false;
let stopping = false;

// The last error the viewer saw from a start, a stop or a Restart (#194): the menu's reason line until a start succeeds.
let lastError: string | undefined;

// The viewer's settings (#513), cached: the main window's close handler decides synchronously, so it cannot read the file. With no file, or one
// that does not parse (the daemon's settings form shows why), the viewer behaves as with the menu bar on: the icon stays a way back. English
// until whenReady's loadSettings (app.getLocale() needs ready), i18n's own default: nothing is shown before it.
let settings: ViewerSettings = { ...VIEWER_DEFAULTS, language: 'en' };
// The user's shortcut changes (#449), read with the settings: Close takes its accelerator from them (Settings… carries the fixed Cmd+,,
// #481). {} (every default) while no config parses. Kept apart from ViewerSettings, which the settings form shares, since only the menu reads it.
let shortcuts: Shortcuts = {};

// The effective language (#242): the config's, else the system's as macOS reports it for the app, with or without LANG. The daemon the
// viewer starts gets that same locale (ensureDaemon), so the main window and the menus agree.
async function loadSettings(): Promise<void> {
  const system = languageFrom(app.getLocale());
  try {
    const config = await loadConfigIfPresent(hiveHome());
    settings = config
      ? { onClose: config.onClose, notifications: config.notifications, language: config.language ?? system }
      : { ...VIEWER_DEFAULTS, language: system };
    shortcuts = config?.shortcuts ?? {};
  } catch (err) {
    log.error(`settings: ${(err as Error).message}`);
    // a read that fails mid-save must not turn back on the kinds the user switched off (#199): the last read's stand, the defaults before one
    settings = { ...VIEWER_DEFAULTS, notifications: settings.notifications, language: system };
    shortcuts = {};
  }
  setLanguage(settings.language);
}

// Window → Fechar and Cmd+W (#358): a main window is asked first, since only its page knows whether the focus is in the terminal panel. The page
// closes a tab or does nothing (#612). Any other window (a detached run #252) just closes: it holds that one run.
function closeFocused(win: BaseWindow | undefined): void {
  const mainWindow = [...mainWindows.values()].find((m) => m.win === win);
  if (mainWindow) mainWindow.win.webContents.send('window:close');
  else win?.close();
}

// The menu bar icon follows the setting (#513): created when it is on and missing, gone at once when it is off. The application menu is
// rebuilt in the language loadSettings just set (#242); the menu bar menu is built at every click, so it follows at its next opening.
function applySettings(): void {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(() => void showSettings().catch(reportError), closeFocused, effectiveBindings(shortcuts, isMac), isMac)));
  const wantsTray = settings.onClose === 'menuBar';
  if (wantsTray && !tray) createTray();
  if (!wantsTray && tray) destroyTray();
}

// No main window left: with the menu bar icon the viewer stays there without a Dock icon. Without it, the last main window's close already went through
// before-quit (#513), so this quit only runs when a main window went away some other way (an error box, a tray that failed to load), and it quits
// alone: an error box here must not loop through quitHive.
function whenNoMainWindow(): void {
  if (mainWindows.size > 0) return;
  if (tray) {
    app.dock?.hide();
    return;
  }
  if (stopping) return; // a Quit in flight finishes the job through quitHive
  quitting = true;
  app.quit();
}

// The main window of the daemon ensureDaemon answered (#466): focused when it is open; otherwise opened, and authorize closes the main windows on
// another port with their detached windows (a Restart, or a Show Hive after the daemon moved: that origin is dead). The new window is
// registered first, so the main windows never empty into a quit (#198), and loads only after the old ones are gone and its cookie is set (#467):
// GET /, its assets, /events and the pty socket all carry it.
async function showMainWindow(daemon: DaemonAddress): Promise<BrowserWindow> {
  const bounds = await readMainWindowBounds(join(app.getPath('userData'), MAIN_WINDOW_BOUNDS_FILE), screen.getAllDisplays().map((d) => d.workArea));
  const existing = mainWindows.get(daemon.port); // after the await: the tray's followDaemon may have opened it meanwhile
  if (existing) {
    await refreshMainWindow(daemon); // a daemon restarted behind this window (#467)
    focusWindow(existing.win);
    return existing.win;
  }
  const win = openMainWindow(daemon.port, bounds);
  await authorize(daemon).catch((err: unknown) => {
    win.destroy(); // no blank window left behind; reportError shows why
    throw err;
  });
  win.loadURL(`http://127.0.0.1:${daemon.port}/`).catch((err: Error) => dialog.showErrorBox(APP_NAME, err.message));
  return win;
}

// Both entry points, the first launch (ready) and every later one (second-instance): the daemon of the home is found or started, then the
// main window of its port is focused or opened. The viewer names no repo (#202): the settings form's folder field does. The main window is
// returned for a worker line (#192) to ask for its panel.
async function open(): Promise<BrowserWindow> {
  const daemon = await ensureDaemon(hiveHome(), app.getLocale()); // a daemon started here resolves the system language as the viewer does (#242)
  lastError = undefined;
  return showMainWindow(daemon);
}

// A daemon that failed to boot, or whose home another one holds (#466): its message in a box, and kept as the menu's reason (#194).
// The viewer stays in the menu bar, where Show Hive or Restart retries (#191); without a main window there is no Dock icon to keep.
function reportError(err: Error): void {
  lastError = err.message;
  dialog.showErrorBox(APP_NAME, err.message);
  whenNoMainWindow();
}

// Quit and Restart ask only when a stop would kill something (#193, #194): workers that are not empty, manual sessions included.
// Nothing running: no dialog. The text is in the Hive's language (#242).
async function confirmStop(action: 'quit' | 'restart'): Promise<boolean> {
  const active = await activeWorkers(hiveHome());
  if (active === 0) return true;
  const { message, verb } = STOP_TEXT[action];
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: tPlural(message, active, { n: active }),
    buttons: [t(verb), t('main.cancel')],
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
  });
  return response === CONFIRM_BUTTON;
}

// The menu's Quit and Cmd+Q (#193): what `hive stop` does, then the viewer goes. A daemon that is down, or a port that is not ours, has
// nothing to stop (#466). A failed count or stop rejects to reportError and the viewer stays: quitting anyway would leave a daemon the user
// believes is stopped.
async function quitHive(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    if (!(await confirmStop('quit'))) return;
    await stopDaemon(hiveHome());
    quitting = true;
    app.quit();
  } finally {
    stopping = false;
  }
}

// The menu's Restart (#194): Quit's confirm and stop, then a start; the viewer stays. A main window open on a port the daemon left moves to the
// new one (#466). A failure rejects to reportError, which keeps it as the menu's reason.
async function restartHive(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    if (!(await confirmStop('restart'))) return;
    await stopDaemon(hiveHome());
    const daemon = await ensureDaemon(hiveHome(), app.getLocale());
    lastError = undefined;
    await followMainWindow(daemon); // none open, none opened
  } finally {
    stopping = false;
  }
}

// The menu (#197 over #196, #194, #192 and #193): the Hive's status, its reason when it is not running; while it runs, the signal radios
// (once the stream has one), the plan lines (once a reading has arrived) and the worker lines; then Show Hive, Settings…, Restart and Quit.
// It always opens: whatever keeps the Hive from answering shows as the status, and Show Hive or Restart brings it back.
async function showMenu(): Promise<void> {
  const status = await daemonStatus(hiveHome()); // never rejects
  const running = status.state === 'running';
  const showHive = (): void => void open().catch(reportError);
  const signal = running && latestSignal ? signalItems(latestSignal, pickSignal) : [];
  const usage = running ? usageItems(latestSignal?.rateLimits, Date.now(), LOCALE[settings.language], meterIcon, showHive) : [];
  const workers = running ? await workerLines() : [];
  tray?.popUpContextMenu(Menu.buildFromTemplate([
    ...statusLines(status),
    { type: 'separator' },
    ...signal,
    ...usage,
    ...workers,
    { label: t('main.showHive'), click: showHive },
    { label: t('main.settings'), click: () => void showSettings().catch(reportError) },
    { label: t('main.restart'), click: () => void restartHive().catch(reportError) },
    { type: 'separator' },
    { label: t('main.quit'), click: () => app.quit() },
  ]));
}

// A signal radio (#196): the daemon's state is the one source of truth, so the badge and the radios change when /events reports it
function pickSignal(signal: Signal): void {
  void setSignal(hiveHome(), signal).catch(reportError);
}

// The status line and, when the Hive is not running, the reason: the viewer's own last error first, then what the daemon or its log says
function statusLines(status: DaemonStatus): MenuItemConstructorOptions[] {
  const line: MenuItemConstructorOptions = { label: t(STATUS_KEYS[status.state]), enabled: false };
  const reason = status.state === 'running' ? undefined : lastError ?? status.reason;
  return reason ? [line, { label: menuLine(reason), enabled: false }] : [line];
}

// A reason as one menu line: its first line, cut to 80 characters. The full text is in the error box of Show Hive or Restart.
function menuLine(text: string): string {
  const first = text.split('\n')[0];
  return first.length > REASON_MAX ? `${first.slice(0, REASON_MAX - 1)}…` : first;
}

// A line per running worker, in footer order (#192), or the no-workers line; then a separator. A list that fails is logged and left out.
async function workerLines(): Promise<MenuItemConstructorOptions[]> {
  const workers = await livePtys(hiveHome()).catch((err: Error): LivePty[] => {
    log.error(`worker list failed: ${err.message}`);
    return [];
  });
  const lines: MenuItemConstructorOptions[] = workers.length === 0
    ? [{ label: t('main.noWorkers'), enabled: false }]
    : workers.map((w) => ({ label: menuLabel(w.label), icon: dotFor(w.status), click: () => void showWorker(w).catch(reportError) }));
  return [...lines, { type: 'separator' }];
}

// A line's dot, or none: a terminal (it has no status to show, #283), an image that failed to load, or a status this build does not know
function dotFor(status: LivePty['status']): NativeImage | undefined {
  const image: NativeImage | undefined = status === 'terminal' ? undefined : DOT_ICONS[status];
  return image && !image.isEmpty() ? image : undefined;
}

// A plan line's bar (#197): drawn at 1x with a 2x representation, so it stays sharp on Retina. An image that comes out empty gives none, and
// the line shows no icon, as dotFor does.
function meterIcon(percent: number, band: MeterBand): NativeImage | undefined {
  const image = nativeImage.createFromBitmap(meterBitmap(percent, band, 1), { width: METER_WIDTH, height: METER_HEIGHT });
  image.addRepresentation({ scaleFactor: 2, width: METER_WIDTH * 2, height: METER_HEIGHT * 2, buffer: meterBitmap(percent, band, 2) });
  return image.isEmpty() ? undefined : image;
}

// A window:select payload (#192, #195), sent once the page has loaded: a page still loading gets it on did-finish-load; the preload
// holds it until the page subscribes, so a page that has not subscribed yet still gets it too.
function sendToMainWindow(webContents: BrowserWindow['webContents'], payload: unknown): void {
  const select = (): void => webContents.send('window:select', payload);
  if (webContents.isLoading()) webContents.once('did-finish-load', select);
  else select();
}

// A task reference clicked in one of a main window's detached windows (#588): that main window comes forward and opens the task's panel, as a worker
// line does (#192, #283)
function openTaskOn(win: BrowserWindow): (taskId: string) => void {
  return (taskId) => {
    focusWindow(win);
    sendToMainWindow(win.webContents, { taskId });
  };
}

// A worker line (#192): the main window is focused or opened as Show Hive does, then asked for that task's panel (#283: the Worker tab is gone). A
// workspace's shell (#292) has no task: the main window only. A notification's click (#199) comes here too.
async function showWorker({ taskId }: Pick<LivePty, 'taskId'>): Promise<void> {
  const { webContents } = await open();
  if (taskId !== undefined) sendToMainWindow(webContents, { taskId });
}

// The menu's Settings… (#195): the main window is focused or opened as Show Hive does, then asked to switch to the settings form.
async function showSettings(): Promise<void> {
  const { webContents } = await open();
  sendToMainWindow(webContents, { view: 'settings' });
}

// The sender must be a main window still showing its own daemon: a page the daemon redirected elsewhere keeps the preload but gets nothing.
function senderMainWindow(event: IpcMainInvokeEvent): MainWindow {
  const entry = [...mainWindows.entries()].find(([, b]) => b.win.webContents === event.sender);
  if (!entry || !event.senderFrame?.url.startsWith(`http://127.0.0.1:${entry[0]}/`)) throw new Error('main window not found');
  return entry[1];
}

// The settings form's "Choose…" (window.hive.chooseFolder, #202): the native folder picker, as a sheet on the main window that asked.
ipcMain.handle('window:chooseFolder', async (event) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(senderMainWindow(event).win, { properties: ['openDirectory'] });
  return canceled ? undefined : filePaths[0];
});

// The settings form's save (window.hive.settingsChanged): the viewer re-reads onClose (#513) and adds or removes its icon, and rebuilds the app menu with the saved shortcuts (#449).
// A rejection reaches the page's toast; the save itself already went through.
ipcMain.handle('window:settingsChanged', async (event) => {
  senderMainWindow(event);
  await loadSettings();
  applySettings();
});

// ⌘V in the files tree (#594) and in a panel tab's terminal (#843): the files Finder put on the clipboard. The sandboxed preload has no clipboard, so main reads it.
ipcMain.handle('window:clipboardFiles', (event) => {
  senderMainWindow(event);
  return parseClipboardFiles(clipboard.read('NSFilenamesPboardType'), clipboard.read('public.file-url'));
});

// ⌘C and ⌘X in the files tree (#818): the files on the pasteboard as Finder's ⌘C writes them, so they paste in Finder and back in the tree.
// Only NSFilenamesPboardType: each writeBuffer replaces the pasteboard, so a public.file-url written after it would erase it, and both
// Finder's paste and parseClipboardFiles read the plist first. Absolute paths only, checked here: IPC is untrusted.
ipcMain.handle('window:writeClipboardFiles', (event, paths: unknown) => {
  senderMainWindow(event);
  if (!isClipboardPathList(paths)) {
    throw new Error('clipboard files must be absolute paths without control characters, and not too many');
  }
  clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(clipboardFilesPlist(paths), 'utf8'));
});

// An untitled file's ⌘S (#818): the OS's save dialog as a sheet on the window that asked, starting at `defaultPath`; its own Replace?
// confirms an existing file. Undefined when cancelled.
ipcMain.handle('window:saveDialog', async (event, defaultPath: unknown) => {
  const { win } = senderMainWindow(event);
  const { canceled, filePath } = await dialog.showSaveDialog(win, typeof defaultPath === 'string' ? { defaultPath } : {});
  return canceled || filePath === undefined || filePath === '' ? undefined : filePath;
});

// The page's closeWindow shortcut (#585), the only key that closes a main window since the close key stopped falling back to it (#612):
// its own window closes, through the close handler (#513) that may turn the last main window's close into a quit.
ipcMain.handle('window:closeWindow', (event) => senderMainWindow(event).win.close());

// Whether the asking main window is in full screen (#295): a window created full screen (restored there, #398) sends no enter event
ipcMain.handle('window:isFullScreen', (event) => senderMainWindow(event).win.isFullScreen());

// A panel tab as a window of its own and back (#252): the handlers live in detach-ipc.ts.
const detach = registerDetachIpc({ handle: (channel, listener) => ipcMain.handle(channel, listener), senderMainWindow });

if (!app.requestSingleInstanceLock()) {
  app.quit(); // the running viewer gets second-instance and opens or focuses its main window
} else {
  app.on('second-instance', () => void open().catch(reportError));
  // without a listener Electron quits once every window is closed; the viewer lives on in the menu bar (#191). With onClose quit (#513) the
  // last main window's close handler has already turned the close into a quit. Cmd+Q still quits: Electron does not emit this event
  // while a quit is in progress.
  app.on('window-all-closed', () => {});
  // Every pass but the last is held here and goes through quitHive (confirm, stop, quit): Cmd+Q and the menu's Quit (#193), and every quit
  // now goes through it (#513): the "viewer quits alone, daemon headless" path from the old both-off state is gone. A quit that goes
  // through closes every main window's terminals first (#400), as the main window's own close does: Electron closes the windows in no set order, and a
  // detached workspace shell's window closed before its main window would read as the user's close and stop the shell.
  app.on('before-quit', (event) => {
    if (quitting) {
      for (const { terminals } of mainWindows.values()) terminals.closeAll();
      return;
    }
    event.preventDefault();
    void quitHive().catch(reportError);
  });
  app.whenReady().then(async () => {
    setDockIcon();
    await loadSettings(); // before open(): the main window's close handler reads them
    applySettings(); // the menu bar icon, only while the setting is on
    watchDaemon(); // #199: the stream outlives the icon
    return open();
  }).catch(reportError);
  // The viewer holds no process of its own: no will-quit, no close(). With onClose menuBar (#191, #513) closing the window leaves the
  // daemon up, Restart stops and starts it with the viewer staying (#194), and quitting (the menu's Quit or Cmd+Q) stops it and its workers
  // first (#193). With onClose quit closing the last window goes through before-quit like Cmd+Q, and stops the daemon too.
}
