// A detached run's window (#252): one xterm over the run's pty in the daemon, through the routes the main window's panel tabs use, under a title
// strip of its own that drags the window and holds the way back to the panel (#340, #377). Plain DOM, two elements, plus React roots holding only
// the link dialog (#404), the toasts (#644) and the find bar (#12). The Express server serves the files and answers GET /settings (the theme, the font, the language) and the
// task references' open-ref (#588); a file link goes through main to the main window's editor pane (#717).
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LinkConfirm } from '@/components/LinkConfirm';
import { TerminalFind } from '@/components/TerminalFind';
import { Toaster } from '@/components/ui/sonner';
import './index.css'; // Tailwind + theme.css: the link dialog is the main window's own AlertDialog (#404); the page's own rules are unlayered and win
import type { SettingsInfo } from '../types';
import { setLanguage, t } from './i18n.js';
import { getJson } from './lib/api.js';
import { connectPty } from './lib/pty-stream.js';
import { setShortcuts } from './lib/shortcut-bindings.js';
import { refPrefixes } from './lib/task-refs.js';
import { applyTheme } from './lib/theme.js';
import { linkHandler, openLink, setTrustedDomains } from './lib/trusted-links.js';
import { FONT_FAMILY, linkFiles, linkTaskRefs, loadSearch, openRefUrl, paintTerminal, terminalClipboard, terminalFontStack, terminalKeys, terminalPaste } from './lib/xterm-setup.js';

const host = document.getElementById('terminal');
if (!host) throw new Error('terminal.html: #terminal missing');
const params = new URLSearchParams(location.search);
const ptyId = params.get('pty') ?? ''; // the run's or the terminal's pty id: main's window always carries it
if (ptyId === '') throw new Error('terminal.html: ?pty= missing');
// What a task reference posts open-ref for: the run's activity (#588, #629). A file link needs none: main knows the window's tab (#717)
const activityId = params.get('activity') ?? undefined;
const refLinks = openRefUrl(activityId);
const name = params.get('title') ?? ''; // the tab's label
document.title = `${name} — Agent Hive`; // text, never markup: the name only reaches the title

// The strip drags the window itself (#377) instead of through -webkit-app-region, which would change how the strip takes its right-click.
// Only the primary button drags, so the title's right-click menu still opens, and never from the dock button, which keeps its click. The
// grab offset keeps the pointer where it took the window. Letting go only ends the move: docking back is the button's or the menu's (#440).
function dragByStrip(strip: HTMLElement): void {
  let grab = { x: 0, y: 0 };
  strip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('#dock'))) return;
    grab = { x: event.clientX, y: event.clientY };
    strip.setPointerCapture(event.pointerId);
  });
  strip.addEventListener('pointermove', (event) => {
    if (!strip.hasPointerCapture(event.pointerId)) return;
    window.hiveTerminal.moveTo({ x: event.screenX - grab.x, y: event.screenY - grab.y });
  });
}

// A detached run's own title strip (#340): the native bar is hidden, so the strip drags the window (dragByStrip, #377), and its text takes
// the right-click that offers the way back to the panel. Built before the first fit, so the terminal fits the height left under it. The
// label is read at the click, in whatever language GET /settings has set by then.
function addTitleStrip(before: HTMLElement): void {
  const strip = document.createElement('header');
  strip.id = 'titlebar';
  const text = document.createElement('span');
  text.id = 'title';
  text.textContent = name; // text, never markup
  text.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.hiveTerminal.titleMenu(t('terminal.window.dock'));
  });
  strip.append(text);
  dragByStrip(strip);
  before.before(strip);
}

addTitleStrip(host);

// The link dialog (#404): a React root on a div of its own, created at the first untrusted link. Rendering it again with no url closes it.
let linkDialog: Root | undefined;
function askLink(url: string | undefined): void {
  if (!linkDialog) {
    const box = document.createElement('div');
    document.body.append(box);
    linkDialog = createRoot(box);
  }
  linkDialog.render(createElement(LinkConfirm, { url, onClose: () => askLink(undefined) }));
}

// The terminal keys' clipboard errors off macOS (#644) are toasts, as in the panel tabs; without a Toaster here they would show nothing
const toasts = document.createElement('div');
document.body.append(toasts);
createRoot(toasts).render(createElement(Toaster));

// A task reference (#588): a task opens on the main window's panel through main (term:openTask), an issue through the link dialog's path. The
// prefixes are read once with the rest of GET /settings, so a save reaches the next window.
function linkRefs(info: SettingsInfo): void {
  if (refLinks === undefined) return;
  const prefixes = info.config ? refPrefixes(info.config) : [];
  linkTaskRefs(term, refLinks, () => prefixes, { task: (taskId) => window.hiveTerminal.openTask(taskId), url: (url) => openLink(url, askLink) });
}

// claude turns mouse tracking on, which hands every drag to it; Option+drag is the macOS way back to a selection. allowProposedApi: the find
// bar's highlights are xterm decorations, still proposed API (#12)
const term = new Terminal({ fontFamily: FONT_FAMILY, cursorBlink: true, macOptionClickForcesSelection: true, allowProposedApi: true, linkHandler: linkHandler(askLink) });
terminalKeys(term, openFind);
const search = loadSearch(term);

// The find bar (#12): a React root of its own, created at the first press of the binding. Its query lives in the component, which stays
// mounted while closed, so the next open finds it. A fixed box under the title strip holds it at the terminal's top right.
let findBar: Root | undefined;
let findRequest = 0;
function renderFind(isOpen: boolean): void {
  if (!findBar) {
    const box = document.createElement('div');
    box.style.cssText = 'position: fixed; top: var(--titlebar-height); right: 0;';
    document.body.append(box);
    findBar = createRoot(box);
  }
  findBar.render(createElement(TerminalFind, { term, search, isOpen, request: findRequest, onClose: () => renderFind(false) }));
}
function openFind(): void {
  findRequest += 1;
  renderFind(true);
}

// system before the first paint, so a system config never paints the wrong theme first; the saved one replaces it once GET /settings answers
let stopTheme = applyTheme('system', () => paintTerminal(term));

const fit = new FitAddon();
term.loadAddon(fit);
term.open(host);
terminalClipboard(term); // #543: a program's OSC 52 copy, Claude's drag included, reaches the clipboard
terminalPaste(term, () => window.hiveTerminal.clipboardFiles()); // #843: after open, which gives it its element; main reads Finder's files
// A file link opens in the main window's editor pane, in this run's activity (#717): main checks it, focuses the main
// window and forwards it
linkFiles(term, (path, line, col) => window.hiveTerminal.openFile({ path, line, col }));

// Connected before the first fit, so the fitted grid reaches the pty. The first fit and every focus of the window post the grid at once,
// even unchanged (#808): the pty follows the view in front of the user, and the host drops a grid it already has. The run ending closes the
// window as it closes a tab; closing the window closes this viewer, and for a project's shell main stops the shell too (#400).
function attachWorker(): void {
  const { postSize } = connectPty(term, ptyId, () => window.close());
  const refit = (): void => {
    fit.fit();
    postSize();
  };
  window.addEventListener('resize', () => fit.fit());
  window.addEventListener('focus', refit);
  refit();
}

// The way back to the main window's panel (#252), on the title strip's right (#340), in the Hive's language once GET /settings has told it: main closes
// the window and the main window opens the run's tab.
function addDockButton(): void {
  const button = document.createElement('button');
  button.id = 'dock';
  button.type = 'button';
  button.textContent = t('terminal.window.dock');
  button.addEventListener('click', () => window.hiveTerminal.dock());
  document.getElementById('titlebar')?.append(button); // the strip is built before any of this runs
}

attachWorker();
term.focus();

// Settings' terminal font (#376), read once like the theme: a save reaches the next window. A synthetic resize refits for the new cell
// size, and connectPty posts the new grid to the pty.
function applyFont(font: string): void {
  term.options.fontFamily = terminalFontStack(font);
  window.dispatchEvent(new Event('resize'));
}

// Read once on load, so a change in Settings reaches the next window: the theme (#296), the font (#376), the trusted link domains (#404),
// the shortcut bindings (#449), the task references (#588), and the dock button's language (#252). With no answer the
// button still shows, in i18n's default language, every link asks, and the shortcuts keep their defaults.
getJson<SettingsInfo>('/settings').then((info) => {
  setLanguage(info.language);
  addDockButton();
  stopTheme();
  stopTheme = applyTheme(info.config?.theme ?? 'system', () => paintTerminal(term));
  applyFont(info.config?.terminalFont ?? '');
  setTrustedDomains(info.config?.trustedDomains ?? []);
  setShortcuts(info.config?.shortcuts ?? {});
  linkRefs(info);
}, addDockButton);
