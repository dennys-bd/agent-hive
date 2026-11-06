import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import type { DetachedWindows } from '../src/detach-ipc.js';
import { dropFilesBuffer, clipboardFilesPlist } from '../src/clipboard-files.js';
import { type MainWindow, registerWindowIpc, type WindowClipboard, type WindowScope } from '../src/window-ipc.js';
import { titleBarOverlayFor } from '../src/window-options.js';

// The IPC every Hive page shares (#552) over fakes: one main window on PORT, Electron's dialogs recorded

const PORT = 47821;
const SHARED = ['window:chooseFolder', 'window:settingsChanged', 'window:clipboardFiles', 'window:writeClipboardFiles', 'window:saveDialog', 'window:closeWindow', 'window:isFullScreen'];

// A BrowserWindow as the handlers read it: its page, its close and its full screen
function fakeWindow(isFull: boolean) {
  const calls: string[] = [];
  const overlays: unknown[] = [];
  const webContents = {};
  const win = { webContents, close: () => { calls.push('close'); }, isFullScreen: () => isFull, setTitleBarOverlay: (options: unknown) => { overlays.push(options); } } as unknown as BrowserWindow;
  return { win, webContents, calls, overlays };
}

// A clipboard that keeps what was written, as the real one does: each writeBuffer replaces everything on it. `swallow` loses the write.
function fakeClipboard(initial: Record<string, Buffer> = {}, { swallow = false, failWith }: { swallow?: boolean; failWith?: Error } = {}) {
  let formats = new Map(Object.entries(initial));
  const clipboard: WindowClipboard = {
    read: (format) => (formats.get(format) ?? Buffer.alloc(0)).toString('utf8'),
    readBuffer: (format) => formats.get(format) ?? Buffer.alloc(0),
    writeBuffer: (format, buffer) => {
      if (failWith) throw failWith;
      if (!swallow) formats = new Map([[format, buffer]]);
    },
  };
  return { clipboard, formats: () => formats };
}

function rig(platform: NodeJS.Platform = 'darwin', clipboard: WindowClipboard = fakeClipboard().clipboard) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ons = new Map<string, (event: IpcMainEvent, ...args: unknown[]) => void>();
  const main = fakeWindow(false);
  const other = fakeWindow(true); // a detached window of this main window, in full screen
  const closedBy: unknown[] = [];
  const detached = { owns: (sender: unknown) => sender === other.webContents, closeWindow: (sender: unknown) => { closedBy.push(sender); } } as unknown as DetachedWindows;
  const entry: MainWindow = { win: main.win, detached };
  const parents: BrowserWindow[] = [];
  const counts = { settings: 0 };
  const senderWindow = registerWindowIpc({
    handle: (channel, listener) => { handlers.set(channel, listener); },
    on: (channel, listener) => { ons.set(channel, listener); },
    platform,
    mainWindows: new Map([[PORT, entry]]),
    fromWebContents: (webContents) => (webContents === other.webContents ? other.win : null),
    dialog: {
      showOpenDialog: async (win) => { parents.push(win); return { canceled: false, filePaths: ['/repo'] }; },
      showSaveDialog: async (win) => { parents.push(win); return { canceled: false, filePath: '/repo/a.ts' }; },
    },
    clipboard,
    settingsChanged: async () => { counts.settings += 1; },
  });
  // null: a sender with no frame (a page torn down mid-call)
  const event = (sender: unknown, url: string | null = `http://127.0.0.1:${PORT}/`): IpcMainInvokeEvent =>
    ({ sender, senderFrame: url === null ? null : { url } }) as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, ev: IpcMainInvokeEvent, ...args: unknown[]): unknown => {
    const handler = handlers.get(channel);
    assert.ok(handler, `no handler for ${channel}`);
    return handler(ev, ...args);
  };
  // a sent message (ipcMain.on): nothing comes back
  const send = (channel: string, ev: IpcMainInvokeEvent, ...args: unknown[]): void => {
    const listener = ons.get(channel);
    assert.ok(listener, `no listener for ${channel}`);
    listener(ev as unknown as IpcMainEvent, ...args);
  };
  return { senderWindow, event, invoke, send, main, entry, parents, counts, other, closedBy };
}

test('senderWindow answers a main window\'s page for the main and shared scopes, and refuses the detached scope, a stranger, a frame off its port and no frame (#552)', () => {
  const h = rig();
  for (const scope of ['main', 'shared'] as const) {
    const found = h.senderWindow(h.event(h.main.webContents), scope);
    assert.deepEqual([found.entry === h.entry, found.win === h.main.win], [true, true], scope);
  }
  const refused: [IpcMainInvokeEvent, WindowScope][] = [
    [h.event(h.main.webContents), 'detached'],
    [h.event({}), 'shared'],
    [h.event(h.main.webContents, 'http://127.0.0.1:1/'), 'main'],
    [h.event(h.main.webContents, 'https://example.com/'), 'shared'],
    [h.event(h.main.webContents, null), 'shared'],
  ];
  for (const [ev, scope] of refused) assert.throws(() => h.senderWindow(ev, scope), { message: 'janela não encontrada' }, scope);
});

test('the shared handlers refuse a sender that is no Hive page before any use, and the dialogs open as sheets on the window that asked (#202, #818, #552)', async () => {
  const h = rig();
  for (const channel of SHARED) {
    await assert.rejects(async () => { await h.invoke(channel, h.event({}), ['/repo/a.ts']); }, { message: 'janela não encontrada' }, channel);
  }
  assert.deepEqual([h.parents.length, h.counts.settings, h.main.calls], [0, 0, []]);
  const ev = h.event(h.main.webContents);
  assert.deepEqual([await h.invoke('window:chooseFolder', ev), await h.invoke('window:saveDialog', ev, 'a.ts')], ['/repo', '/repo/a.ts']);
  assert.ok(h.parents.length === 2 && h.parents.every((win) => win === h.main.win), 'both sheets on the main window');
  await h.invoke('window:settingsChanged', ev);
  assert.deepEqual([h.counts.settings, h.invoke('window:isFullScreen', ev)], [1, false]);
});

test('window:closeWindow from a main window\'s page closes that window, through its own close handler (#585, #552)', () => {
  const h = rig();
  h.invoke('window:closeWindow', h.event(h.main.webContents));
  assert.deepEqual(h.main.calls, ['close']);
});

test('a detached window\'s page is found through its main window\'s registry: its own window for the detached and shared scopes, refused for the main one; its sheets, full screen and closeWindow are its own (#552)', async () => {
  const h = rig();
  const ev = h.event(h.other.webContents);
  for (const scope of ['detached', 'shared'] as const) {
    const found = h.senderWindow(ev, scope);
    assert.deepEqual([found.entry === h.entry, found.win === h.other.win], [true, true], scope);
  }
  assert.throws(() => h.senderWindow(ev, 'main'), { message: 'janela não encontrada' });
  assert.throws(() => h.senderWindow(h.event(h.other.webContents, 'http://127.0.0.1:1/'), 'detached'), { message: 'janela não encontrada' });
  await h.invoke('window:chooseFolder', ev);
  assert.ok(h.parents.length === 1 && h.parents[0] === h.other.win, 'the sheet is on the detached window');
  assert.equal(h.invoke('window:isFullScreen', ev), true);
  h.invoke('window:closeWindow', ev);
  assert.deepEqual([h.closedBy.length === 1 && h.closedBy[0] === h.other.webContents, h.other.calls, h.main.calls], [true, [], []], 'destroyed by its registry, never closed again');
});

test('window:theme on win32 recolours the sender\'s own caption overlay, a main window\'s or a detached one\'s, in the theme\'s colours (#648)', () => {
  const h = rig('win32');
  h.send('window:theme', h.event(h.main.webContents), 'light');
  h.send('window:theme', h.event(h.other.webContents), 'dark');
  assert.deepEqual(h.main.overlays, [titleBarOverlayFor('light')]);
  assert.deepEqual(h.other.overlays, [titleBarOverlayFor('dark')]);
});

test('window:theme ignores a value that is not light or dark, and a sender that is no Hive page, without throwing (#648)', () => {
  const h = rig('win32');
  for (const value of ['blue', undefined, 42, { theme: 'dark' }]) h.send('window:theme', h.event(h.main.webContents), value);
  assert.doesNotThrow(() => h.send('window:theme', h.event({}), 'dark'));
  assert.doesNotThrow(() => h.send('window:theme', h.event(h.main.webContents, 'https://example.com/'), 'dark'));
  assert.deepEqual([h.main.overlays, h.other.overlays], [[], []]);
});

test('window:theme does nothing on darwin: no caption overlay to recolour (#648)', () => {
  const h = rig('darwin');
  h.send('window:theme', h.event(h.main.webContents), 'dark');
  assert.deepEqual(h.main.overlays, []);
});

const utf16 = (text: string): Buffer => Buffer.from(text, 'utf16le');

test('window:clipboardFiles on win32 reads CF_HDROP, and on darwin the pasteboard\'s plist (#650)', async () => {
  const win = rig('win32', fakeClipboard({ CF_HDROP: dropFilesBuffer(['C:\\a\\1.txt', 'C:\\b 2.txt']) }).clipboard);
  assert.deepEqual(await win.invoke('window:clipboardFiles', win.event(win.main.webContents)), ['C:\\a\\1.txt', 'C:\\b 2.txt']);
  const mac = rig('darwin', fakeClipboard({ NSFilenamesPboardType: Buffer.from(clipboardFilesPlist(['/a/1.txt', '/b 2.txt'])) }).clipboard);
  assert.deepEqual(await mac.invoke('window:clipboardFiles', mac.event(mac.main.webContents)), ['/a/1.txt', '/b 2.txt']);
});

test('window:clipboardFiles on win32 falls back to FileNameW for the first file, and answers [] with no file format (#650)', async () => {
  const fallback = rig('win32', fakeClipboard({ FileNameW: utf16('C:\\only\\one.txt\0\0garbage') }).clipboard);
  assert.deepEqual(await fallback.invoke('window:clipboardFiles', fallback.event(fallback.main.webContents)), ['C:\\only\\one.txt']);
  const empty = rig('win32', fakeClipboard({ FileNameW: utf16('\0') }).clipboard);
  assert.deepEqual(await empty.invoke('window:clipboardFiles', empty.event(empty.main.webContents)), []);
  const none = rig('win32', fakeClipboard().clipboard);
  assert.deepEqual(await none.invoke('window:clipboardFiles', none.event(none.main.webContents)), []);
});

test('window:writeClipboardFiles writes CF_HDROP only on win32, the plist on darwin, and both read back (#650)', async () => {
  const paths = ['C:\\a\\1.txt', 'C:\\b 2.txt'];
  const win = fakeClipboard();
  const w = rig('win32', win.clipboard);
  await w.invoke('window:writeClipboardFiles', w.event(w.main.webContents), paths);
  assert.deepEqual([...win.formats().keys()], ['CF_HDROP']);
  assert.deepEqual(win.formats().get('CF_HDROP'), dropFilesBuffer(paths));
  const mac = fakeClipboard();
  const m = rig('darwin', mac.clipboard);
  await m.invoke('window:writeClipboardFiles', m.event(m.main.webContents), ['/a/1.txt']);
  assert.deepEqual([...mac.formats().keys()], ['NSFilenamesPboardType']);
  assert.deepEqual(await m.invoke('window:clipboardFiles', m.event(m.main.webContents)), ['/a/1.txt']);
});

test('window:writeClipboardFiles refuses paths that are not absolute on the platform, before writing (#650)', async () => {
  const win = fakeClipboard();
  const w = rig('win32', win.clipboard);
  await assert.rejects(async () => w.invoke('window:writeClipboardFiles', w.event(w.main.webContents), ['/a/posix']), /absolute/);
  const mac = rig('darwin', win.clipboard);
  await assert.rejects(async () => mac.invoke('window:writeClipboardFiles', mac.event(mac.main.webContents), ['C:\\a']), /absolute/);
  assert.equal(win.formats().size, 0);
});

test('window:writeClipboardFiles rejects when writeBuffer throws or the system swallowed the write, on every platform (#650)', async () => {
  const cases: [NodeJS.Platform, string][] = [['win32', 'C:\\a\\1.txt'], ['darwin', '/a/1.txt'], ['linux', '/a/1.txt']];
  for (const [platform, path] of cases) {
    const throwing = rig(platform, fakeClipboard({}, { failWith: new Error('clipboard busy') }).clipboard);
    await assert.rejects(async () => throwing.invoke('window:writeClipboardFiles', throwing.event(throwing.main.webContents), [path]), /clipboard busy/, platform);
    const swallowed = rig(platform, fakeClipboard({}, { swallow: true }).clipboard);
    await assert.rejects(async () => swallowed.invoke('window:writeClipboardFiles', swallowed.event(swallowed.main.webContents), [path]), /clipboard/, platform);
  }
});
