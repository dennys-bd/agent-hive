import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { createDetachedWindows, type DetachedEvents, type DetachedWindow, type DetachedWindows, registerDetachIpc } from '../src/detach-ipc.js';
import type { CenterTabRef, MovedTab } from '../src/tab-carry.js';
import type { Panes } from '../src/ui/lib/pane-split.js';
import type { WindowScope } from '../src/window-ipc.js';

// The main process's side of detached windows (#552) over fakes: a build answers a fake window whose page loads when the test says, and the
// handlers run over a fake ipcMain with one main window

const A = 'a-I1';
const B = 'a-I2';
const FILE: MovedTab = { activity: A, ref: { kind: 'file', path: 'src/a.ts' }, carry: { text: 'mine\n', base: 'v1' } };
const DIFF: MovedTab = { activity: A, ref: { kind: 'diff', scope: 'worktree' } };
const PANES: Panes = {
  root: { kind: 'split', axis: 'row', children: [{ kind: 'pane', ptyId: 'p1' }, { kind: 'pane', ptyId: 'p2' }], sizes: [50, 50] },
  focused: 'p2',
};
const SPLIT: MovedTab = { activity: B, ref: { kind: 'run', ptyId: 'p1', panes: PANES } };
const MAIN = { page: 'main' }; // the main window's webContents

interface FakeWindow {
  activity: string;
  on: DetachedEvents;
  win: DetachedWindow;
  sent: unknown[][];
  counts: { focus: number; close: number; destroy: number };
  isDirty: boolean; // its page holds unsaved edits: a close shows the dialog, and the user picks Cancel
  load(): void;
  fail(): void; // its page failed to load: the builder destroys it, and Electron emits closed
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const hasClosing = (win: FakeWindow): boolean => win.sent.some(([channel]) => channel === 'window:closing');

// A build whose page loads when the test says. Its close plays Electron's: the close event, which the registry may prevent, then closed, or,
// with unsaved edits, the dialog's Cancel. Its destroy emits closed and aborts a load still running (#467).
function fakeBuild(built: FakeWindow[]) {
  return (activity: string, on: DetachedEvents): Promise<DetachedWindow> => {
    let settle = { load: (): void => undefined, fail: (_err: Error): void => undefined };
    const loading = new Promise<void>((resolve, reject) => { settle = { load: resolve, fail: reject }; });
    const sent: unknown[][] = [];
    const counts = { focus: 0, close: 0, destroy: 0 };
    const win: DetachedWindow = {
      focus: () => { counts.focus += 1; },
      close: () => {
        counts.close += 1;
        if (fake.isDirty) {
          on.kept();
          return;
        }
        let isPrevented = false;
        on.closing({ preventDefault: () => { isPrevented = true; } });
        if (!isPrevented) on.closed();
      },
      destroy: () => {
        counts.destroy += 1;
        on.closed();
        settle.fail(new Error('ERR_ABORTED'));
      },
      webContents: { send: (...args: unknown[]) => { sent.push(args); } },
    };
    const fake: FakeWindow = {
      activity, on, win, sent, counts, isDirty: false,
      load: () => settle.load(),
      fail: () => {
        on.closed();
        settle.fail(new Error('load failed'));
      },
    };
    built.push(fake);
    on.created(win);
    return loading.then(() => win);
  };
}

function rig() {
  const built: FakeWindow[] = [];
  const mainSent: unknown[][] = [];
  const opened: string[] = [];
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const listeners = new Map<string, (event: IpcMainEvent, ...args: unknown[]) => void>();
  const page = { webContents: { send: (...args: unknown[]) => { mainSent.push(args); } } };
  // window-ipc.ts's senderWindow in small: the main window's page for main, one of this registry's windows for detached, either for shared
  const senderWindow = (event: { sender: unknown }, scope: WindowScope): { entry: { detached: DetachedWindows } } => {
    const isMain = event.sender === MAIN;
    const isAllowed = scope === 'shared' ? isMain || detached.owns(event.sender) : scope === 'main' ? isMain : detached.owns(event.sender);
    if (!isAllowed) throw new Error('janela não encontrada');
    return { entry: { detached } };
  };
  const hub = registerDetachIpc({
    handle: (channel, listener) => { handlers.set(channel, listener); },
    on: (channel, listener) => { listeners.set(channel, listener); },
    senderWindow,
  });
  const detached = createDetachedWindows({ ...hub.mainWindowDeps(page), onOpenTask: (taskId) => { opened.push(taskId); }, build: fakeBuild(built) });
  const invoke = (channel: string, sender: unknown, ...args: unknown[]): unknown => {
    const handler = handlers.get(channel);
    assert.ok(handler, `no handler for ${channel}`);
    return handler({ sender } as unknown as IpcMainInvokeEvent, ...args);
  };
  const send = (channel: string, sender: unknown, ...args: unknown[]): void => {
    const listener = listeners.get(channel);
    assert.ok(listener, `no listener for ${channel}`);
    listener({ sender } as unknown as IpcMainEvent, ...args);
  };
  // A tab moved out from the main window, its activity's newest window loaded
  const moveLoaded = async (tab: MovedTab): Promise<void> => {
    const moving = invoke('window:moveToWindow', MAIN, tab) as Promise<void>;
    built.filter((w) => w.activity === tab.activity).at(-1)?.load();
    await moving;
  };
  return { built, mainSent, opened, detached, invoke, send, moveLoaded };
}

test('moveToWindow for an activity with no window builds one and sends it window:open with the moved tab, carry included, only once its page loaded (#552)', async () => {
  const h = rig();
  const moving = h.invoke('window:moveToWindow', MAIN, { ...FILE, extra: 1 }) as Promise<void>;
  assert.deepEqual(h.built.map((w) => w.activity), [A]);
  await tick();
  assert.deepEqual(h.built[0].sent, [], 'nothing before the load');
  h.built[0].load();
  await moving;
  assert.deepEqual(h.built[0].sent, [['window:open', FILE]]);
});

test('a second tab of the same activity, during the load and after it, builds nothing and reaches the same window, focused; another activity\'s builds its own (#552)', async () => {
  const h = rig();
  const first = h.invoke('window:moveToWindow', MAIN, FILE) as Promise<void>;
  const second = h.invoke('window:moveToWindow', MAIN, DIFF) as Promise<void>;
  h.built[0].load();
  await Promise.all([first, second]);
  const preview: MovedTab = { activity: A, ref: { kind: 'preview', path: 'README.md' } };
  await h.moveLoaded(preview);
  assert.equal(h.built.length, 1);
  assert.deepEqual(h.built[0].sent, [['window:open', FILE], ['window:open', DIFF], ['window:open', preview]]);
  assert.equal(h.built[0].counts.focus, 3);
  await h.moveLoaded(SPLIT);
  assert.deepEqual(h.built.map((w) => w.activity), [A, B]);
  assert.deepEqual(h.built[1].sent, [['window:open', SPLIT]]);
});

test('a build whose page fails to load makes the move reject, leaves no window and lists no tab; the next move builds anew (#552)', async () => {
  const h = rig();
  const moving = h.invoke('window:moveToWindow', MAIN, FILE) as Promise<void>;
  h.built[0].fail();
  await assert.rejects(moving, { message: 'load failed' });
  assert.deepEqual([h.detached.size(), h.invoke('window:detachedTabs', MAIN)], [0, []]);
  await h.moveLoaded(FILE);
  assert.equal(h.built.length, 2);
});

test('moveToWindow and focusTab refuse a malformed payload before any build; the main-only channels refuse a detached page, and the old detach channels are gone (#552)', async () => {
  const h = rig();
  for (const bad of [undefined, { ref: FILE.ref }, { ...FILE, activity: '' }, { ...DIFF, carry: FILE.carry }, { activity: A, ref: { kind: 'untitled', n: 0 } }]) {
    assert.throws(() => h.invoke('window:moveToWindow', MAIN, bad), { message: 'aba inválida' }, JSON.stringify(bad));
  }
  assert.throws(() => h.invoke('window:focusTab', MAIN, A, 7), { message: 'aba inválida' });
  assert.equal(h.built.length, 0);
  await h.moveLoaded(FILE);
  const page = h.built[0].win.webContents;
  for (const [channel, args] of [['window:moveToWindow', [DIFF]], ['window:focusTab', [A, 'diff:worktree']], ['window:detachedTabs', []]] as const) {
    assert.throws(() => h.invoke(channel, page, ...args), { message: 'janela não encontrada' }, channel);
  }
  assert.equal(h.built.length, 1);
  for (const channel of ['window:detach', 'window:focusDetached', 'window:detachedPtys', 'window:panelRect']) {
    assert.throws(() => h.invoke(channel, MAIN), { message: `no handler for ${channel}` }, 'a call rejects, which focusRun reads as no window');
  }
});

test('dock sends window:dock with the moved tab to the main window\'s page and unlists it; a malformed tab, another activity\'s, or a dock from the main window is refused and sends nothing (#552)', async () => {
  const h = rig();
  await h.moveLoaded(FILE);
  await h.moveLoaded(DIFF);
  const page = h.built[0].win.webContents;
  h.invoke('window:dock', page, { ...FILE, extra: 1 });
  assert.deepEqual(h.mainSent, [['window:dock', FILE]]);
  assert.deepEqual(h.invoke('window:detachedTabs', MAIN), [{ activity: A, ref: DIFF.ref }]);
  for (const bad of [undefined, 'file', { ...DIFF, activity: B }, { activity: A, ref: { kind: 'pr', number: 1 } }, { ...DIFF, carry: FILE.carry }]) {
    assert.throws(() => h.invoke('window:dock', page, bad), { message: 'aba inválida' }, JSON.stringify(bad));
  }
  assert.throws(() => h.invoke('window:dock', MAIN, DIFF), { message: 'janela não encontrada' });
  assert.equal(h.mainSent.length, 1);
});

test('detachedTabs lists every tab out by activity and ref, never a carry; focusTab focuses for a listed tab or a pane of a listed split tab, and answers false for any other (#552)', async () => {
  const h = rig();
  await h.moveLoaded(FILE);
  await h.moveLoaded(DIFF);
  await h.moveLoaded(SPLIT);
  assert.deepEqual(h.invoke('window:detachedTabs', MAIN), [{ activity: A, ref: FILE.ref }, { activity: A, ref: DIFF.ref }, { activity: B, ref: SPLIT.ref }]);
  const [first, second] = h.built;
  assert.deepEqual([h.invoke('window:focusTab', MAIN, A, 'file:src/a.ts'), h.invoke('window:focusTab', MAIN, B, 'p1'), h.invoke('window:focusTab', MAIN, B, 'p2')], [true, true, true]);
  assert.deepEqual([first.counts.focus, second.counts.focus], [3, 3]);
  for (const [activity, key] of [[A, 'p2'], [A, 'preview:README.md'], [B, 'file:src/a.ts'], ['a-I9', 'file:src/a.ts']]) {
    assert.equal(h.invoke('window:focusTab', MAIN, activity, key), false, `${activity} ${key}`);
  }
  assert.deepEqual([first.counts.focus, second.counts.focus], [3, 3], 'no focus for a tab no window holds');
});

test('a tab leaves detachedTabs once the page stops reporting it, once docked, and once its window closed; a report drops malformed refs and is ignored from any other sender (#552)', async () => {
  const h = rig();
  await h.moveLoaded(FILE);
  await h.moveLoaded(DIFF);
  await h.moveLoaded(SPLIT);
  const [first, second] = h.built;
  const untitled: CenterTabRef = { kind: 'untitled', n: 2 };
  h.send('window:tabs', first.win.webContents, [DIFF.ref, untitled, { kind: 'pr', number: 1 }, 'junk']);
  h.send('window:tabs', MAIN, []); // the main window is no detached window: dropped, never thrown
  h.send('window:tabs', first.win.webContents, 'junk'); // no list: the last report stands
  assert.deepEqual(h.invoke('window:detachedTabs', MAIN), [{ activity: A, ref: DIFF.ref }, { activity: A, ref: untitled }, { activity: B, ref: SPLIT.ref }]);
  h.invoke('window:dock', first.win.webContents, { activity: A, ref: untitled });
  second.on.closed();
  assert.deepEqual(h.invoke('window:detachedTabs', MAIN), [{ activity: A, ref: DIFF.ref }]);
  assert.equal(h.invoke('window:focusTab', MAIN, B, 'p1'), false);
});

test('a user\'s close of a window holding tabs is prevented and its page gets window:closing; closeWindow from that page destroys it; an empty window closes at once (#552)', async () => {
  const h = rig();
  await h.moveLoaded(FILE);
  const [win] = h.built;
  win.win.close();
  assert.deepEqual(win.sent.at(-1), ['window:closing']);
  assert.equal(h.detached.size(), 1, 'the window stays until its page calls closeWindow');
  h.detached.closeWindow(MAIN); // only the window's own page closes it this way
  assert.equal(win.counts.destroy, 0);
  h.detached.closeWindow(win.win.webContents);
  assert.deepEqual([win.counts.destroy, h.detached.size(), h.invoke('window:detachedTabs', MAIN)], [1, 0, []]);
  await h.moveLoaded(SPLIT);
  const empty = h.built[1];
  h.send('window:tabs', empty.win.webContents, []);
  empty.win.close();
  assert.deepEqual([hasClosing(empty), h.detached.size()], [false, 0]);
});

test('closeWithMain closes each window plainly, never sending window:closing; it answers true once all closed, false as soon as one was kept, and the others still close (#552)', async () => {
  const h = rig();
  assert.equal(await h.detached.closeWithMain(), true, 'no window: nothing to wait for');
  await h.moveLoaded(FILE);
  await h.moveLoaded(SPLIT);
  assert.equal(await h.detached.closeWithMain(), true);
  assert.deepEqual([h.built.map((w) => w.counts.close), h.detached.size()], [[1, 1], 0]);
  await h.moveLoaded(FILE);
  await h.moveLoaded(SPLIT);
  h.built[2].isDirty = true; // its unsaved-edits dialog answers Cancel
  assert.equal(await h.detached.closeWithMain(), false);
  assert.deepEqual([h.detached.size(), h.built[2].counts.destroy, h.built[3].counts.close], [1, 0, 1]);
  assert.ok(h.built.every((w) => !hasClosing(w)), 'nothing docks into a page that unloads');
  h.built[2].isDirty = false;
  h.built[2].win.close(); // the kept window's next close is the user's again
  assert.equal(hasClosing(h.built[2]), true);
});

test('closeAll destroys every window once, loaded or still loading, and one built after it as soon as it exists, with no rejection reaching the page (#467, #552)', async () => {
  const h = rig();
  await h.moveLoaded(FILE);
  const loading = h.invoke('window:moveToWindow', MAIN, SPLIT) as Promise<void>;
  h.detached.closeAll();
  h.detached.closeAll();
  assert.deepEqual(h.built.map((w) => w.counts.destroy), [1, 1]);
  await loading; // resolved: the main window is going, no toast for it
  await h.invoke('window:moveToWindow', MAIN, DIFF);
  assert.deepEqual(h.built.map((w) => w.counts.destroy), [1, 1, 1]);
  assert.deepEqual([h.detached.size(), h.mainSent], [0, []]);
});

test('window:openTask from a detached window passes a non-empty task id to its main window, and refuses any other id or sender (#588, #552)', async () => {
  const h = rig();
  await h.moveLoaded(FILE);
  const page = h.built[0].win.webContents;
  for (const bad of [undefined, '', 7, { taskId: 'board:I1' }]) {
    assert.throws(() => h.invoke('window:openTask', page, bad), { message: 'tarefa inválida' }, JSON.stringify(bad));
  }
  assert.throws(() => h.invoke('window:openTask', MAIN, 'board:I7'), { message: 'janela não encontrada' });
  h.invoke('window:openTask', page, 'board:I7');
  assert.deepEqual(h.opened, ['board:I7']);
  assert.deepEqual(h.built[0].counts, { focus: 1, close: 0, destroy: 0 }, 'the window neither docks nor closes');
});
