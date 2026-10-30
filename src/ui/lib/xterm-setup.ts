// The xterm wiring the terminal window (src/ui/terminal.ts) and the main window's panel tabs (PtyTab.tsx) share (#251): the font, the colors
// from the page's tokens (#296), the file links (#258), the task references (#588), the configured font's stack (#376), the shortcuts
// that act in a terminal (#448), the paste of files copied in Finder (#843) and the find bar's search addon (#12).
import { type ISearchOptions, SearchAddon } from '@xterm/addon-search';
import type { IBufferRange, Terminal } from '@xterm/xterm';
import { toast } from 'sonner';
import { FIXED_BINDINGS, matches } from '../../shortcuts.js';
import type { RefTarget } from '../../task-refs.js';
import type { TerminalSize } from '../../terminal-wire.js';
import { t } from '../i18n.js';
import { postJson } from './api.js';
import { findFileLinks } from './file-links.js';
import { isMac, pressed, pressedFixed } from './shortcut-bindings.js';
import { findTaskRefs } from './task-refs.js';

export const FONT_FAMILY = 'ui-monospace, monospace'; // the main window's mono font (.output)

/** The CSS stack for Settings' terminal font (#376): the system monospace alone for "", else the name first, quoted (the parser refuses a
 * quote, a backslash or a control character in it), with the system monospace behind it for a misspelled or missing font. */
export function terminalFontStack(font: string): string {
  return font === '' ? FONT_FAMILY : `"${font}", ${FONT_FAMILY}`;
}

/** Which tokens paint a terminal: a terminal's own, or the console's (redesign 05), which sits on its surface's colour and greys plain output,
 * the command line written in bright white standing out in the foreground, and a setup run's results in the signal colours (#576). */
export interface TerminalPalette { background: string; foreground: string; brightWhite?: string; green?: string; red?: string }
const TERMINAL_PALETTE: TerminalPalette = { background: '--background', foreground: '--foreground' };
// The ANSI colours a palette may name: each set from its token when named, else left to xterm's default
const ANSI_COLORS = ['brightWhite', 'green', 'red'] as const;

/** xterm draws on a canvas, so its colors are the page's tokens (theme.css), read once data-theme is set (#296). */
export function paintTerminal(term: Terminal, palette: TerminalPalette = TERMINAL_PALETTE): void {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string): string => css.getPropertyValue(name).trim();
  const ansi = Object.fromEntries(ANSI_COLORS.flatMap((color) => {
    const name = palette[color];
    return name === undefined ? [] : [[color, token(name)]];
  }));
  term.options.theme = {
    background: token(palette.background), foreground: token(palette.foreground), cursor: token('--foreground'), selectionBackground: token('--secondary'), ...ansi,
  };
}

/** Runs `repaint` on every data-theme change of the page: the main window switches theme without a reload (#296). Returns the unsubscribe. */
export function onThemeChange(repaint: () => void): () => void {
  const observer = new MutationObserver(repaint);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/** Paints now and on every data-theme change of the page (#296). Returns the unsubscribe. */
export function followTheme(term: Terminal, palette: TerminalPalette = TERMINAL_PALETTE): () => void {
  paintTerminal(term, palette);
  return onThemeChange(() => paintTerminal(term, palette));
}

/** Past this many matches the find bar counts "1000+" and the addon stops highlighting, so a huge scrollback stays responsive (#12). The
 * addon's own default, said out loud. */
export const HIGHLIGHT_LIMIT = 1000;

/** Loads the find bar's search addon on `term` (#12). Its highlights are xterm decorations, proposed API in xterm 6: the terminal needs
 * allowProposedApi. */
export function loadSearch(term: Terminal): SearchAddon {
  const search = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });
  term.loadAddon(search);
  return search;
}

/** A find bar search (#12): case-insensitive, `incremental` while typing (from the current match, so it stays put), every match on
 * --secondary bordered in --muted-foreground, the active one (the terminal's selection) bordered in --foreground. Neutral tokens: colour is
 * for status. Read at each call, as paintTerminal reads them, so a theme change reaches the next search. The addon requires the overview
 * ruler colours even though no terminal sets xterm's overviewRuler option. */
export function findOptions(incremental: boolean): ISearchOptions {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string): string => css.getPropertyValue(name).trim();
  return {
    incremental,
    decorations: {
      matchBackground: token('--secondary'), matchBorder: token('--muted-foreground'), matchOverviewRuler: token('--muted-foreground'),
      activeMatchBorder: token('--foreground'), activeMatchColorOverviewRuler: token('--foreground'),
    },
  };
}

// The route a terminal's task references post to (#588, #629): its activity's, a task's or a workspace's local one (#400), the id encoded.
// undefined for none; an empty string counts as absent, as the window's query yields one for a missing key.
const activityRoute = (activityId: string | undefined, action: 'open-ref'): string | undefined =>
  (activityId ? `/activities/${encodeURIComponent(activityId)}/${action}` : undefined);

/** The open-ref route a terminal's task references post to (#588). */
export const openRefUrl = (activityId: string | undefined): string | undefined => activityRoute(activityId, 'open-ref');

// A row of the buffer as text, `y` 1-based as a link provider gets it, and a span of it as xterm's range (1-based, end inclusive).
// ponytail: string index = cell column, so a wide character earlier in the row shifts the underline, and a link wrapped onto the next row
// is not found; map through the buffer's cells if either ever matters (#258, #588)
const rowText = (term: Terminal, y: number): string => term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
const rangeOf = (start: number, end: number, y: number): IBufferRange => ({ start: { x: start + 1, y }, end: { x: end, y } });

/** A file path in the output is a link (#258, #717): a click hands its path, line and column to `open`, which opens it in the editor pane (a
 * main window tab) or asks main to (a detached window). Links are not checked against the disk: a path that points nowhere shows the pane's
 * arquivo não encontrado. The http links xterm already handles are untouched. */
export function linkFiles(term: Terminal, open: (path: string, line?: number, col?: number) => void): void {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = rowText(term, y);
      callback(findFileLinks(text).map(({ path, line, col, start, end }) => ({
        text: text.slice(start, end),
        range: rangeOf(start, end, y),
        activate: () => open(path, line, col),
      })));
    },
  });
}

/** Where a task reference's click goes (#588): a task's panel in the Hive, or a web link through the page's trusted-link path. */
export interface RefOpeners { task(taskId: string): void; url(url: string): void }

const openTarget = (target: RefTarget, open: RefOpeners): void => ('taskId' in target ? open.task(target.taskId) : open.url(target.url));

/** A task reference in the output (#588), `#N` or a known `PREFIX-N`, is a link: a click posts `{ ref }` to `url`, openRefUrl's route, and
 * opens the task or the issue it answers. Nothing is checked on hover: a reference that resolves to nothing answers 404, and the refusal is
 * dropped. `prefixes` is read at each row, so a main window's tab follows a Settings save without a new xterm. */
export function linkTaskRefs(term: Terminal, url: string, prefixes: () => readonly string[], open: RefOpeners): void {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      callback(findTaskRefs(rowText(term, y), prefixes()).map(({ ref, start, end }) => ({
        text: ref,
        range: rangeOf(start, end, y),
        activate: () => void postJson<RefTarget>(url, { ref }).then((target) => openTarget(target, open)).catch(() => {}),
      })));
    },
  });
}

// The xterm of each worker's tab in this window (#584), so the search's limpar terminal reaches the one that had the focus.
// ponytail: one xterm per pty id per window; a second tab of the same run in one window would replace the first here
const terminals = new Map<string, Terminal>();

// #808: the tracked xterm the user last focused, whose grid a run this page opens is born at while it shows
let lastFocused: Terminal | undefined;

/** Tracks `term` as `ptyId`'s until the returned untrack; an untrack of a replaced one leaves the newer in place. A focus on it makes it the
 * one shownSize reads first (#808). xterm has no focus event of its own: its textarea's focus bubbles to its element as focusin. */
export function trackTerminal(ptyId: string, term: Terminal): () => void {
  terminals.set(ptyId, term);
  const focused = (): void => { lastFocused = term; };
  term.element?.addEventListener('focusin', focused);
  return () => {
    term.element?.removeEventListener('focusin', focused);
    if (lastFocused === term) lastFocused = undefined;
    if (terminals.get(ptyId) === term) terminals.delete(ptyId);
  };
}

// Shown as fitShown reads it (PtyTab.tsx, #390): a tab behind another is 0 wide or 0 tall, and its grid is not its pane's
const isShown = (term: Terminal): boolean => (term.element?.clientWidth ?? 0) > 0 && (term.element?.clientHeight ?? 0) > 0;

/** The grid a run this page opens is born at (#808): the last focused xterm's while it shows, else the first shown one's. undefined
 * when none shows: the daemon then uses the largest grid it has seen. A new tab opens next to the terminal shown, almost always its size. */
export function shownSize(): TerminalSize | undefined {
  const term = lastFocused !== undefined && isShown(lastFocused) ? lastFocused : [...terminals.values()].find(isShown);
  return term === undefined ? undefined : { cols: term.cols, rows: term.rows };
}

/** What the clear key does (#448), for `ptyId`'s xterm: screen and scrollback drop, the daemon's replay history stays. */
export const clearTerminal = (ptyId: string): void => terminals.get(ptyId)?.clear();

// The terminal's clipboard keys off macOS (#644), fixed rows of the registry. On macOS the Edit menu's roles copy and paste, and xterm
// selects all on ⌘A, so none of them is read there.
const CLIPBOARD_KEYS = ['copy', 'paste', 'selectAll'] as const;
type ClipboardKey = (typeof CLIPBOARD_KEYS)[number];

const clipboardKey = (event: KeyboardEvent): ClipboardKey | undefined =>
  (isMac() ? undefined : CLIPBOARD_KEYS.find((id) => pressedFixed(event, id) !== -1));

// A clipboard the page may not read or write says why, as DetailMenu's copy does; otherwise the key would seem to do nothing
const showError = (err: Error): void => {
  toast.error(err.message);
};

// paste, not input: xterm wraps the text in bracketed paste when the program asked for it, so a multi-line paste does not run line by line
function runClipboardKey(term: Terminal, key: ClipboardKey): void {
  if (key === 'selectAll') term.selectAll();
  else if (key === 'paste') void navigator.clipboard.readText().then((text) => term.paste(text)).catch(showError);
  else if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection()).catch(showError);
}

/** The shortcuts that act inside a terminal, in one handler: xterm keeps a single custom key handler per terminal, and a second
 * attachCustomKeyEventHandler would replace the first (#448).
 * - Shift+Enter, a fixed key (#481), sends ESC CR, the sequence Claude Code's /terminal-setup binds, so Claude inserts a newline instead of
 *   sending the prompt (#389). It goes out through onData like any key, so connectPty carries it regardless of tab or window.
 * - clear (Cmd+K by default, #448) drops this xterm's screen and scrollback, as Terminal.app does. The daemon's replay history stays, so a
 *   reopened tab replays it.
 * - find (Cmd+F on macOS, Ctrl+Shift+F elsewhere, #12) calls `onFind`, which opens the terminal's find bar. Read here and not on the window,
 *   so the editor pane's Monaco keeps its own Cmd+F. A terminal with no bar passes no `onFind`, and the key is left to xterm.
 * - Off macOS (#644), Ctrl+Shift+C or Ctrl+Insert copies the selection (nothing without one), Ctrl+Shift+V or Shift+Insert pastes the
 *   clipboard, and Ctrl+Shift+A selects the whole buffer. Ctrl+C stays the program's SIGINT, selection or not.
 * Every event of these keys is refused to xterm, or it would also send the key to the program (Ctrl+Shift+C as \x03). The clear and find
 * bindings are read at each key, so a Settings save reaches the open terminals; any other key, or one turned off, is left to xterm. */
export function terminalKeys(term: Terminal, onFind?: () => void): void {
  term.attachCustomKeyEventHandler((event) => {
    const isNewline = matches(event, FIXED_BINDINGS.newline, isMac());
    const clipboard = clipboardKey(event);
    const isFind = onFind !== undefined && pressed(event, 'findInTerminal');
    if (!isNewline && clipboard === undefined && !isFind && !pressed(event, 'clear')) return true;
    if (event.type === 'keydown') {
      event.preventDefault(); // xterm skips its own preventDefault on a refused key: the key would reach its hidden textarea
      if (isNewline) term.input('\x1b\r', true);
      else if (clipboard !== undefined) runClipboardKey(term, clipboard);
      else if (isFind) onFind();
      else term.clear();
    }
    return false;
  });
}

// A copy bigger than this is dropped: decoding xterm's 10 MB OSC limit would stall the page for a clipboard nobody pastes
const MAX_OSC52_BASE64 = 1024 * 1024;

// OSC 52's payload is `<selection names>;<base64>`; `?` instead of the base64 asks to read the clipboard back
const decodeOsc52 = (data: string): string | undefined => {
  const separator = data.indexOf(';');
  const payload = separator === -1 ? '' : data.slice(separator + 1);
  if (payload === '' || payload === '?' || payload.length > MAX_OSC52_BASE64) return undefined;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)));
  } catch {
    return undefined; // not base64: nothing a program meant to copy
  }
};

/** The terminal's OSC 52 (#543): what a program asks to copy goes on the clipboard, as iTerm2 and VS Code's terminal do. Claude Code copies
 * a drag of its own selection this way as well as with pbcopy, and its pbcopy does not always reach the pasteboard, while it still says
 * it copied. Writes only: a read query is dropped, or any program in a terminal could read the clipboard. Every OSC 52 is consumed, so
 * xterm never acts on one itself. */
export function terminalClipboard(term: Terminal, write = (text: string): Promise<void> => navigator.clipboard.writeText(text)): void {
  term.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52(data);
    // then(), so a write that throws at once toasts as a rejected one does; the id keeps a burst of refused writes to one toast
    if (text !== undefined) {
      Promise.resolve(text).then(write).catch(() => toast.error(t('terminal.copyFailed'), { id: 'terminal.copyFailed' }));
    }
    return true;
  });
}

// What a pasted file's path escapes (#843), as Terminal.app and iTerm type a dragged file: the shell's special ASCII characters, space and
// tab included. Letters outside ASCII stay, so an accented name reads as itself.
const SHELL_SPECIAL = /[ \t!"#$&'()*;<=>?[\\\]^`{|}~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: dropping control characters is the point; tab is left for SHELL_SPECIAL to escape
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

/** A file's path as a paste types it (#843): control characters dropped, so a newline in a name never reaches the program as Enter, then a
 * backslash before each of the shell's special characters. */
export const escapePath = (path: string): string => path.replace(CONTROL, '').replace(SHELL_SPECIAL, '\\$&');

/** The terminal's paste (#843). Finder's ⌘C puts no usable text on the clipboard, so xterm's own handler would send claude an empty paste,
 * and claude would read the file's icon as the clipboard's image. With files copied, the paste types their paths instead, escaped and joined
 * by a space, as Terminal.app and iTerm do, and claude attaches an image from its path. With none, or a read that fails, the text read at
 * the event goes through as before, an empty one included: that is how a copied screenshot reaches claude.
 * A capture listener on the open xterm's element (call it after `open`), so it runs before xterm's handler on its textarea. The event is
 * stopped at once: whether files are there is only known after the IPC. term.paste keeps xterm's bracketed paste and its line endings. The
 * listener lives on the xterm's element, which dispose detaches, so nothing unsubscribes it. */
export function terminalPaste(term: Terminal, clipboardFiles: () => Promise<string[]>): void {
  term.element?.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    event.preventDefault();
    event.stopImmediatePropagation();
    void clipboardFiles().then(
      (paths) => term.paste(paths.length > 0 ? paths.map(escapePath).join(' ') : text),
      () => term.paste(text),
    );
  }, { capture: true });
}
