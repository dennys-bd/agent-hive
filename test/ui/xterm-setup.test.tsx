import { fireEvent } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { toast } from 'sonner';
import { setShortcuts } from '@/lib/shortcut-bindings';
import { clearTerminal, escapePath, FONT_FAMILY, linkTaskRefs, openRefUrl, paintTerminal, shownSize, terminalFontStack, terminalKeys, terminalPaste, trackTerminal } from '@/lib/xterm-setup';
import type { Shortcuts } from '../../src/types';
import { FakeTerminal } from './xterm-fakes';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } })); // the clipboard's error is observable without a Toaster

afterEach(() => { setShortcuts({}); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('terminalFontStack: "" is the system monospace alone; a name goes first, quoted, with the system monospace behind it as the fallback (#376)', () => {
  expect(terminalFontStack('')).toBe(FONT_FAMILY);
  expect(terminalFontStack('MesloLGS NF')).toBe('"MesloLGS NF", ui-monospace, monospace');
});

test('openRefUrl: the activity\'s open-ref, a task\'s or a workspace\'s local one, its id encoded; none, or an empty one, link nothing (#588, #629)', () => {
  expect(openRefUrl('a-board:I1')).toBe('/activities/a-board%3AI1/open-ref');
  expect(openRefUrl('local:my site')).toBe('/activities/local%3Amy%20site/open-ref');
  expect(openRefUrl(undefined)).toBeUndefined();
  expect(openRefUrl('')).toBeUndefined();
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('linkTaskRefs: each reference of a row is a link; a click posts it, a task answer opens the task, a URL goes to the link opener, a 404 opens nothing (#588)', async () => {
  const answers: Record<string, Response> = {
    '#7': json({ taskId: 'board:I7' }), '#8': json({ url: 'https://github.com/acme/r/issues/8' }), 'HIVE-2': json({ error: 'no task or issue for this reference' }, 404),
  };
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => answers[(JSON.parse(String(init?.body)) as { ref: string }).ref]);
  vi.stubGlobal('fetch', fetchMock);
  const term = new FakeTerminal();
  term.lines = ['see #7, #8 and HIVE-2; UTF-8 stays text'];
  const open = { task: vi.fn(), url: vi.fn() };
  linkTaskRefs(term as unknown as Terminal, '/activities/a-I1/open-ref', () => ['HIVE'], open);
  let links: { text: string; activate(): void }[] = [];
  term.providers[0].provideLinks(1, (found) => { links = found ?? []; });
  expect(links.map((l) => l.text)).toEqual(['#7', '#8', 'HIVE-2']);
  for (const link of links) link.activate();
  await vi.waitFor(() => expect(open.url).toHaveBeenCalledWith('https://github.com/acme/r/issues/8'));
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
    ['/activities/a-I1/open-ref', '{"ref":"#7"}'], ['/activities/a-I1/open-ref', '{"ref":"#8"}'], ['/activities/a-I1/open-ref', '{"ref":"HIVE-2"}'],
  ]);
  expect(open.task).toHaveBeenCalledExactlyOnceWith('board:I7');
  expect(open.url).toHaveBeenCalledOnce();
});

function keyHandler(): { handle: (event: KeyboardEvent) => boolean; input: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> } {
  let handle: (event: KeyboardEvent) => boolean = () => true;
  const input = vi.fn();
  const clear = vi.fn();
  const term = { attachCustomKeyEventHandler: (fn: typeof handle) => { handle = fn; }, input, clear };
  terminalKeys(term as unknown as Terminal);
  return { handle, input, clear };
}

test('terminalKeys: Shift+Enter sends ESC CR, the newline Claude reads from /terminal-setup, and xterm sends no CR of its own (#389)', () => {
  const { handle, input } = keyHandler();
  const down = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
  expect(handle(down)).toBe(false);
  expect(down.defaultPrevented).toBe(true);
  expect(input).toHaveBeenCalledExactlyOnceWith('\x1b\r', true);
  expect(handle(new KeyboardEvent('keypress', { key: 'Enter', shiftKey: true }))).toBe(false);
  expect(handle(new KeyboardEvent('keyup', { key: 'Enter', shiftKey: true }))).toBe(false);
  expect(input).toHaveBeenCalledOnce();
});

test('terminalKeys: plain Enter, Shift+Enter with another modifier and other keys pass through to xterm (#389)', () => {
  const { handle, input } = keyHandler();
  for (const init of [{ key: 'Enter' }, { key: 'Enter', shiftKey: true, ctrlKey: true }, { key: 'Enter', shiftKey: true, altKey: true }, { key: 'Enter', shiftKey: true, metaKey: true }, { key: 'a', shiftKey: true }]) {
    expect(handle(new KeyboardEvent('keydown', init))).toBe(true);
  }
  expect(input).not.toHaveBeenCalled();
});

test('terminalKeys: Shift+Enter is a fixed key, so no shortcuts map moves or turns it off, a stale one naming newline included (#481)', () => {
  const { handle, input } = keyHandler();
  setShortcuts({ newline: 'Alt+Enter' } as unknown as Shortcuts); // a map from before #481: the id is no shortcut
  expect(handle(new KeyboardEvent('keydown', { key: 'Enter', altKey: true }))).toBe(true);
  setShortcuts({ newline: null } as unknown as Shortcuts);
  const down = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
  expect(handle(down)).toBe(false);
  expect(down.defaultPrevented).toBe(true);
  expect(input).toHaveBeenCalledExactlyOnceWith('\x1b\r', true);
});

// jsdom runs as off macOS (isMac() is false): clear is Ctrl+Shift+K there, and Ctrl+K stays the program's (#585)
test('terminalKeys: the clear key clears the terminal once, sends nothing to the program, and every event of the key is refused to xterm (#448, #585)', () => {
  const { handle, input, clear } = keyHandler();
  const down = new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, cancelable: true });
  expect(handle(down)).toBe(false);
  expect(down.defaultPrevented).toBe(true);
  expect(handle(new KeyboardEvent('keypress', { key: 'K', ctrlKey: true, shiftKey: true }))).toBe(false);
  expect(handle(new KeyboardEvent('keyup', { key: 'K', ctrlKey: true, shiftKey: true }))).toBe(false);
  expect(clear).toHaveBeenCalledOnce();
  expect(input).not.toHaveBeenCalled();
  expect(handle(new KeyboardEvent('keydown', { key: 'k' }))).toBe(true);
  expect(handle(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))).toBe(true);
  expect(clear).toHaveBeenCalledOnce();
});

test('terminalKeys follows the configured clear binding, read at each key; turned off, its key goes to xterm (#448)', () => {
  const { handle, clear } = keyHandler();
  setShortcuts({ clear: 'CmdOrCtrl+Alt+K' }); // after the handler is attached: a save reaches an open terminal
  expect(handle(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true }))).toBe(true);
  expect(clear).not.toHaveBeenCalled();
  expect(handle(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, altKey: true, cancelable: true }))).toBe(false);
  expect(clear).toHaveBeenCalledOnce();
  setShortcuts({ clear: null });
  expect(handle(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true }))).toBe(true);
  expect(handle(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, altKey: true }))).toBe(true);
  expect(clear).toHaveBeenCalledOnce();
  setShortcuts({});
});

// The terminal's clipboard keys off macOS (#644); jsdom runs as off macOS
const COPY: KeyboardEventInit = { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true };
const COPY_INSERT: KeyboardEventInit = { key: 'Insert', code: 'Insert', ctrlKey: true };
const PASTE: KeyboardEventInit = { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true };
const PASTE_INSERT: KeyboardEventInit = { key: 'Insert', code: 'Insert', shiftKey: true };
const SELECT_ALL: KeyboardEventInit = { key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true };

// A terminal with `selection` selected ('' for none), its handler attached
function clipboardTerm(selection = '') {
  let handle: (event: KeyboardEvent) => boolean = () => true;
  const term = {
    attachCustomKeyEventHandler: (fn: typeof handle) => { handle = fn; },
    input: vi.fn(), clear: vi.fn(), paste: vi.fn(), selectAll: vi.fn(),
    hasSelection: () => selection !== '', getSelection: () => selection,
  };
  terminalKeys(term as unknown as Terminal);
  return { handle: (event: KeyboardEvent) => handle(event), term };
}

const stubClipboard = (clipboard: Partial<Clipboard>): void => {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
};

test('terminalKeys off macOS: Ctrl+Shift+C and Ctrl+Insert copy the selection, and every event of the key is refused to xterm; with no selection they copy nothing (#644)', () => {
  const writeText = vi.fn(async (_text: string) => {});
  stubClipboard({ writeText });
  const { handle, term } = clipboardTerm('npm test');
  for (const init of [COPY, COPY_INSERT]) {
    const down = new KeyboardEvent('keydown', { ...init, cancelable: true });
    expect(handle(down)).toBe(false);
    expect(down.defaultPrevented).toBe(true);
    expect(handle(new KeyboardEvent('keypress', init))).toBe(false);
    expect(handle(new KeyboardEvent('keyup', init))).toBe(false);
  }
  expect(writeText.mock.calls).toEqual([['npm test'], ['npm test']]);
  expect(term.input).not.toHaveBeenCalled();
  const empty = clipboardTerm('');
  expect(empty.handle(new KeyboardEvent('keydown', { ...COPY, cancelable: true }))).toBe(false);
  expect(writeText).toHaveBeenCalledTimes(2);
});

test('terminalKeys off macOS: Ctrl+Shift+V and Shift+Insert paste the clipboard\'s text through xterm\'s paste, which keeps bracketed paste (#644)', async () => {
  stubClipboard({ readText: vi.fn(async () => 'line 1\nline 2') });
  const { handle, term } = clipboardTerm();
  for (const init of [PASTE, PASTE_INSERT]) {
    const down = new KeyboardEvent('keydown', { ...init, cancelable: true });
    expect(handle(down)).toBe(false);
    expect(down.defaultPrevented).toBe(true);
    expect(handle(new KeyboardEvent('keyup', init))).toBe(false);
  }
  await vi.waitFor(() => expect(term.paste).toHaveBeenCalledTimes(2));
  expect(term.paste).toHaveBeenCalledWith('line 1\nline 2');
  expect(term.input).not.toHaveBeenCalled();
});

test('terminalKeys off macOS: Ctrl+Shift+A selects the whole buffer, while Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X and Ctrl+Z stay the program\'s (#644)', () => {
  const { handle, term } = clipboardTerm('x');
  const down = new KeyboardEvent('keydown', { ...SELECT_ALL, cancelable: true });
  expect(handle(down)).toBe(false);
  expect(down.defaultPrevented).toBe(true);
  expect(term.selectAll).toHaveBeenCalledOnce();
  for (const letter of ['a', 'c', 'v', 'x', 'z']) {
    expect(handle(new KeyboardEvent('keydown', { key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true }))).toBe(true);
  }
  expect(term.selectAll).toHaveBeenCalledOnce();
});

test('terminalKeys off macOS: a clipboard that refuses shows its error in a toast, and nothing is pasted (#644)', async () => {
  stubClipboard({
    readText: vi.fn(async () => { throw new Error('Read permission denied.'); }),
    writeText: vi.fn(async () => { throw new Error('Write permission denied.'); }),
  });
  const { handle, term } = clipboardTerm('x');
  handle(new KeyboardEvent('keydown', PASTE));
  handle(new KeyboardEvent('keydown', COPY));
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
  expect(toast.error).toHaveBeenCalledWith('Read permission denied.');
  expect(toast.error).toHaveBeenCalledWith('Write permission denied.');
  expect(term.paste).not.toHaveBeenCalled();
});

test('terminalKeys on macOS leaves every one of these keys to xterm: ⌘C and ⌘V reach the page through the Edit menu, ⌘A through xterm itself (#644)', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const writeText = vi.fn(async (_text: string) => {});
  stubClipboard({ writeText });
  const { handle, term } = clipboardTerm('x');
  const cmd = (letter: string): KeyboardEventInit => ({ key: letter, code: `Key${letter.toUpperCase()}`, metaKey: true });
  for (const init of [COPY, COPY_INSERT, PASTE, PASTE_INSERT, SELECT_ALL, cmd('c'), cmd('v'), cmd('a')]) {
    expect(handle(new KeyboardEvent('keydown', init))).toBe(true);
  }
  expect(writeText).not.toHaveBeenCalled();
  expect([term.paste, term.selectAll].map((fn) => fn.mock.calls.length)).toEqual([0, 0]);
});

test('escapePath: a plain path is unchanged; the shell\'s special characters, space and tab included, get a backslash; an accented name stays; a control character is dropped (#843)', () => {
  expect(escapePath('/tmp/shots/shot.png')).toBe('/tmp/shots/shot.png');
  expect(escapePath('/tmp/my shot (1).png')).toBe('/tmp/my\\ shot\\ \\(1\\).png');
  expect(escapePath(`/tmp/it's "$HOME"\\x`)).toBe(`/tmp/it\\'s\\ \\"\\$HOME\\"\\\\x`);
  expect(escapePath('/tmp/relatório ação.pdf')).toBe('/tmp/relatório\\ ação.pdf');
  expect(escapePath('/tmp/a\nb\x07c\x7f\x9b.png')).toBe('/tmp/abc.png');
  expect(escapePath('/tmp/a\tb')).toBe('/tmp/a\\\tb');
  const rest = '!#&*;<=>?[]^`{|}~';
  expect(escapePath(rest)).toBe([...rest].map((char) => `\\${char}`).join(''));
});

// An open xterm as terminalPaste reads it (#843): its element, holding a textarea with a paste listener of its own, where xterm's handler sits
function pasteTerm(clipboardFiles: () => Promise<string[]>) {
  const element = document.createElement('div');
  const textarea = element.appendChild(document.createElement('textarea'));
  const xtermOwn = vi.fn();
  textarea.addEventListener('paste', xtermOwn);
  const term = { element, paste: vi.fn() };
  terminalPaste(term as unknown as Terminal, clipboardFiles);
  // a paste on the focused textarea with `text` as its text/plain; false when the default was prevented
  const pasteText = (text: string): boolean =>
    fireEvent.paste(textarea, { clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') } });
  return { paste: term.paste, xtermOwn, pasteText };
}

test('terminalPaste: with Finder files on the clipboard it types their escaped paths joined by a space, and neither the default nor xterm\'s own handler gets the paste (#843)', async () => {
  const clipboardFiles = vi.fn(async () => ['/tmp/shots/shot one.png', '/tmp/b.png']);
  const { paste, xtermOwn, pasteText } = pasteTerm(clipboardFiles);
  expect(pasteText('')).toBe(false);
  await vi.waitFor(() => expect(paste).toHaveBeenCalledOnce());
  expect(paste).toHaveBeenCalledWith('/tmp/shots/shot\\ one.png /tmp/b.png');
  expect(clipboardFiles).toHaveBeenCalledOnce();
  expect(xtermOwn).not.toHaveBeenCalled();
});

test('terminalPaste: with no files it pastes the text read at the event, an empty one included, which is how a copied screenshot reaches claude (#843)', async () => {
  const { paste, xtermOwn, pasteText } = pasteTerm(async () => []);
  expect(pasteText('line 1\nline 2')).toBe(false);
  await vi.waitFor(() => expect(paste).toHaveBeenCalledOnce());
  pasteText('');
  await vi.waitFor(() => expect(paste).toHaveBeenCalledTimes(2));
  expect(paste.mock.calls).toEqual([['line 1\nline 2'], ['']]);
  expect(xtermOwn).not.toHaveBeenCalled();
});

test('terminalPaste: a clipboard read that rejects pastes the text, as if no files were there (#843)', async () => {
  const { paste, pasteText } = pasteTerm(async () => { throw new Error('clipboard unavailable'); });
  pasteText('hello');
  await vi.waitFor(() => expect(paste).toHaveBeenCalledExactlyOnceWith('hello'));
});

test('clearTerminal clears the tracked xterm of a worker, and nothing once it is untracked (#584)', () => {
  const clear = vi.fn();
  const untrack = trackTerminal('W1', { clear } as unknown as Terminal);
  clearTerminal('W1');
  untrack();
  clearTerminal('W1');
  expect(clear).toHaveBeenCalledTimes(1);
});

test('paintTerminal sets green and red from the tokens a palette names, as it does brightWhite, and leaves them to xterm otherwise (#576)', () => {
  const tokens: Record<string, string> = {
    '--background': '#000', '--foreground': '#fff', '--muted-foreground': '#999', '--secondary': '#333', '--signal-green': '#0a0', '--signal-red': '#a00',
  };
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => ` ${tokens[name] ?? ''}` }));
  const term = { options: {} } as unknown as Terminal;
  paintTerminal(term, { background: '--background', foreground: '--muted-foreground', brightWhite: '--foreground', green: '--signal-green', red: '--signal-red' });
  expect(term.options.theme).toMatchObject({ foreground: '#999', brightWhite: '#fff', green: '#0a0', red: '#a00' });
  paintTerminal(term);
  expect(term.options.theme).not.toHaveProperty('green');
  expect(term.options.theme).not.toHaveProperty('red');
});

// An xterm as shownSize reads it (#808): its grid, and an element jsdom gives a size only when the test says it shows
function gridXterm(cols: number, rows: number, isShown: boolean): Terminal {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientWidth', { value: isShown ? 800 : 0 });
  Object.defineProperty(element, 'clientHeight', { value: isShown ? 600 : 0 });
  return { cols, rows, element } as unknown as Terminal;
}
const focusIn = (term: Terminal): void => { term.element?.dispatchEvent(new FocusEvent('focusin')); };

test('shownSize answers the grid of the xterm the user last focused while it shows, else of a shown one, else nothing (#808)', () => {
  const narrow = gridXterm(100, 30, true);
  const hidden = gridXterm(80, 24, false);
  const wide = gridXterm(140, 40, true);
  const [untrackNarrow, untrackHidden, untrackWide] = [trackTerminal('A', narrow), trackTerminal('B', hidden), trackTerminal('C', wide)];
  expect(shownSize()).toEqual({ cols: 100, rows: 30 }); // nothing focused yet: the first shown
  focusIn(wide);
  expect(shownSize()).toEqual({ cols: 140, rows: 40 });
  focusIn(hidden); // a tab behind another took the focus last
  expect(shownSize()).toEqual({ cols: 100, rows: 30 });
  untrackNarrow();
  untrackWide();
  expect(shownSize()).toBeUndefined(); // only a hidden one left: the daemon's fallback applies
  untrackHidden();
});
