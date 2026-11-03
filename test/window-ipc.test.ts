import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { DetachedWindows } from '../src/detach-ipc.js';
import { type MainWindow, registerWindowIpc, type WindowScope } from '../src/window-ipc.js';

// The IPC every Hive page shares (#552) over fakes: one main window on PORT, Electron's dialogs recorded

const PORT = 47821;
const SHARED = ['window:chooseFolder', 'window:settingsChanged', 'window:clipboardFiles', 'window:writeClipboardFiles', 'window:saveDialog', 'window:closeWindow', 'window:isFullScreen'];

// A BrowserWindow as the handlers read it: its page, its close and its full screen
function fakeWindow(isFull: boolean) {
  const calls: string[] = [];
  const webContents = {};
  const win = { webContents, close: () => { calls.push('close'); }, isFullScreen: () => isFull } as unknown as BrowserWindow;
  return { win, webContents, calls };
}

function rig() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const main = fakeWindow(false);
  const other = fakeWindow(true); // a detached window of this main window, in full screen
  const closedBy: unknown[] = [];
  const detached = { owns: (sender: unknown) => sender === other.webContents, closeWindow: (sender: unknown) => { closedBy.push(sender); } } as unknown as DetachedWindows;
  const entry: MainWindow = { win: main.win, detached };
  const parents: BrowserWindow[] = [];
  const counts = { settings: 0 };
  const senderWindow = registerWindowIpc({
    handle: (channel, listener) => { handlers.set(channel, listener); },
    mainWindows: new Map([[PORT, entry]]),
    fromWebContents: (webContents) => (webContents === other.webContents ? other.win : null),
    dialog: {
      showOpenDialog: async (win) => { parents.push(win); return { canceled: false, filePaths: ['/repo'] }; },
      showSaveDialog: async (win) => { parents.push(win); return { canceled: false, filePath: '/repo/a.ts' }; },
    },
    clipboard: { read: () => '', writeBuffer: () => undefined },
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
  return { senderWindow, event, invoke, main, entry, parents, counts, other, closedBy };
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
