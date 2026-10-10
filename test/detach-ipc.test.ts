import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IpcMainInvokeEvent } from 'electron';
import { type DetachedFile, type MainWindowPage, createDetachedWindows, type DetachedEvents, registerDetachIpc } from '../src/detach-ipc.js';
import type { Point } from '../src/terminal-wire.js';

const WORKER = '0b6f3c1e-5d2a-4c8b-9e7f-1a2b3c4d5e6f';
const OTHER = '1c2d3e4f-0000-4000-8000-000000000002';
const TAB: DetachedTab = { ptyId: WORKER, kind: 'stage', task: 'board:I1', title: '#1 Task 1', label: '#1 Task 1 · etapa' };
const PROJECT_TAB: DetachedTab = { ptyId: OTHER, kind: 'terminal', project: 'hive', title: 'hive', label: 'hive · shell' };
const EVENT = {} as IpcMainInvokeEvent; // the fake senderMainWindow never reads it

interface FakeWindow { tab: DetachedTab; on: DetachedEvents; focused: number; destroyed: boolean; positions: Point[] }

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// registerDetachIpc over a fake ipcMain and one main window whose registry builds fake windows. `invoke` plays the page's call; `control` says
// whether the next page fails to load, or holds its load open until the window is destroyed (#467); `built` holds every window opened; `sent` holds what the main window's page got; `stopped` holds every
// worker id the registry asked to stop (#400); `opened` holds every task id the registry passed on (#588).
function hub() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const sent: unknown[][] = [];
  const built: FakeWindow[] = [];
  const stopped: string[] = [];
  const opened: string[] = [];
  const files: DetachedFile[] = [];
  const control = { fail: false, hold: false };
  const win: MainWindowPage = { webContents: { send: (...args: unknown[]) => { sent.push(args); } } };
  const detach = registerDetachIpc({
    handle: (channel, listener) => { handlers.set(channel, listener); },
    senderMainWindow: () => mainWindow,
  });
  const terminals = createDetachedWindows({
    ...detach.mainWindowDeps(win),
    stopShell: (ptyId) => { stopped.push(ptyId); },
    onOpenTask: (taskId) => { opened.push(taskId); },
    onOpenFile: (file) => { files.push(file); },
    build: async (tab, on) => {
      if (control.fail) {
        await tick(); // a real build reads the saved bounds first
        on.closed(); // load() destroys a window whose page failed, and Electron emits closed
        throw new Error('load failed');
      }
      await tick(); // a real build reads the saved bounds first
      const fake: FakeWindow = { tab, on, focused: 0, destroyed: false, positions: [] };
      built.push(fake);
      let abort = (): void => {};
      const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('ERR_ABORTED')); });
      aborted.catch(() => undefined); // only a held load awaits it
      // Electron emits closed after destroy, and a destroyed window aborts its load
      const window = {
        focus: () => { fake.focused += 1; },
        destroy: () => { fake.destroyed = true; on.closed(); abort(); },
        setPosition: (x: number, y: number) => { fake.positions.push({ x, y }); },
      };
      on.created(window);
      if (control.hold) await aborted; // a page still loading: a hostile server on the port can keep it so
      return window;
    },
  });
  const mainWindow = { win, terminals };
  const invoke = (channel: string, ...args: unknown[]): unknown => {
    const handler = handlers.get(channel);
    assert.ok(handler, `no handler for ${channel}`);
    return handler(EVENT, ...args);
  };
  return { invoke, sent, built, control, terminals, stopped, opened, files };
}

test('a malformed tab or pty id is refused before it reaches the main window, and window:panelRect is no longer handled (#252, #440, #647)', () => {
  const h = hub();
  for (const bad of [undefined, 'W', { ...TAB, ptyId: 'W1' }, { ...TAB, kind: 'tab' }, { ...TAB, kind: 'shell' }, { ...TAB, label: '' }]) {
    assert.throws(() => h.invoke('window:detach', bad), { message: 'aba inválida' }, JSON.stringify(bad));
  }
  assert.throws(() => h.invoke('window:focusDetached', 'W1'), { message: 'aba inválida: W1' });
  assert.throws(() => h.invoke('window:panelRect', { x: 0, y: 0, width: 400, height: 820 }), { message: 'no handler for window:panelRect' }, 'dock-by-drop is gone (#440)');
  assert.equal(h.built.length, 0);
});

test('detach opens the run\'s window once, with the known keys only, a second argument ignored; a second detach or focusDetached focuses it; once it closes focusDetached answers false and the next detach opens a new one (#252, #440)', async () => {
  const h = hub();
  await h.invoke('window:detach', { ...TAB, extra: 'dropped', session: 'hive-1-task-1', terminal: 'internal' }, null); // where the drop point rode: never read
  await h.invoke('window:detach', TAB);
  assert.equal(h.built.length, 1);
  assert.deepEqual(h.built[0].tab, TAB);
  assert.equal(h.built[0].focused, 1);
  assert.equal(h.invoke('window:focusDetached', WORKER), true);
  await tick();
  assert.equal(h.built[0].focused, 2);
  h.built[0].on.closed();
  assert.equal(h.invoke('window:focusDetached', WORKER), false);
  await h.invoke('window:detach', TAB);
  assert.equal(h.built.length, 2);
});

test('the strip\'s drag moves the window to each point, rounded, ignores anything that is not a finite point, and never docks wherever it goes (#377, #440)', async () => {
  const h = hub();
  await h.invoke('window:detach', TAB);
  const [win] = h.built;
  win.on.moveTo({ x: 120.4, y: 280.6 });
  for (const bad of [undefined, null, 'x', { x: 1 }, { y: 2 }, { x: Number.NaN, y: 2 }, { x: 1, y: Number.POSITIVE_INFINITY }, { x: '1', y: 2 }]) {
    win.on.moveTo(bad);
  }
  win.on.moveTo({ x: 130, y: 290 });
  await tick();
  assert.deepEqual(win.positions, [{ x: 120, y: 281 }, { x: 130, y: 290 }]);
  assert.deepEqual([win.destroyed, h.sent], [false, []], 'a move never docks: only the button and the title menu do');
});

test('the page\'s dock button (term:dock) docks at once; the title menu\'s dock arriving in the same gesture docks nothing more, and a late move reaches no window (#377, #252, #440)', async () => {
  const h = hub();
  await h.invoke('window:detach', TAB);
  const [win] = h.built;
  win.on.dock();
  assert.equal(h.invoke('window:focusDetached', WORKER), false, 'docking: the run is back in the panel before the destroy lands');
  win.on.dock(); // the title menu's item (term:titleMenu), reported before the destroy lands
  win.on.moveTo({ x: 10, y: 10 });
  await tick();
  assert.deepEqual(h.sent, [['window:dock', TAB]]);
  assert.equal(win.destroyed, true);
  assert.deepEqual(win.positions, [], 'setPosition on a destroyed BrowserWindow throws');
});

test('closing the main window closes every detached window without docking; a window whose page fails to load rejects and leaves no entry behind (#252)', async () => {
  const h = hub();
  await h.invoke('window:detach', TAB);
  await h.invoke('window:detach', { ...TAB, ptyId: OTHER });
  h.terminals.closeAll();
  await tick();
  assert.deepEqual(h.built.map((w) => w.destroyed), [true, true]);
  assert.deepEqual(h.sent, [], 'closing is not docking');
  h.control.fail = true;
  await assert.rejects(async () => { await h.invoke('window:detach', TAB); }, { message: 'load failed' });
  assert.equal(h.invoke('window:focusDetached', WORKER), false);
});

test('closeAll destroys a window still loading at once, and one not yet created as soon as it exists, without a rejection reaching the page (#467)', async () => {
  const h = hub();
  h.control.hold = true;
  const loading = h.invoke('window:detach', TAB) as Promise<void>;
  await tick();
  const early = h.invoke('window:detach', { ...TAB, ptyId: OTHER }) as Promise<void>; // still reading its bounds
  h.terminals.closeAll();
  assert.deepEqual(h.built.map((w) => w.destroyed), [true], 'destroyed now, not after a load the old port may never finish');
  await Promise.all([loading, early]); // resolved: the main window is going, no toast for it
  assert.deepEqual(h.built.map((w) => w.destroyed), [true, true]);
  assert.deepEqual(h.invoke('window:detachedPtys'), []);
  assert.deepEqual(h.sent, []);
});

test('a project shell detaches with its project and no task; a tab with both, neither, or an empty project is refused (#400)', async () => {
  const h = hub();
  const { task: _task, ...neither } = TAB;
  for (const bad of [{ ...TAB, project: 'hive' }, neither, { ...PROJECT_TAB, project: '' }, { ...PROJECT_TAB, project: 7 }]) {
    assert.throws(() => h.invoke('window:detach', bad), { message: 'aba inválida' }, JSON.stringify(bad));
  }
  await h.invoke('window:detach', { ...PROJECT_TAB, extra: 'dropped', session: 'project-1c2d3e4f' });
  assert.deepEqual(h.built.map((w) => w.tab), [PROJECT_TAB]);
});

test('the user closing a project shell\'s window stops the shell once; a dock, a failed load, the main window closing and a task run\'s window stop nothing (#400)', async () => {
  const h = hub();
  await h.invoke('window:detach', PROJECT_TAB);
  await h.invoke('window:detach', TAB);
  h.built[1].on.closed(); // a task run's window: closing it only closes that viewer
  h.built[0].on.closed(); // the user closes the shell's window
  assert.deepEqual(h.stopped, [OTHER]);
  await h.invoke('window:detach', PROJECT_TAB);
  h.built[2].on.dock(); // the page's dock button, or the title menu's
  await tick();
  h.control.fail = true;
  await assert.rejects(async () => { await h.invoke('window:detach', PROJECT_TAB); }, { message: 'load failed' });
  h.control.fail = false;
  await h.invoke('window:detach', PROJECT_TAB);
  h.terminals.closeAll(); // the main window closing, and a quit going through (main.ts's before-quit)
  await tick();
  assert.deepEqual(h.built.map((w) => w.destroyed), [false, false, true, true]);
  assert.deepEqual(h.stopped, [OTHER], 'only the user\'s close stops the shell');
});

test('window:detachedPtys answers the pty ids that have a window, focusing none, and drops one once it docks or closes (#400)', async () => {
  const h = hub();
  assert.deepEqual(h.invoke('window:detachedPtys'), []);
  await h.invoke('window:detach', TAB);
  await h.invoke('window:detach', PROJECT_TAB);
  assert.deepEqual(h.invoke('window:detachedPtys'), [WORKER, OTHER]);
  await tick();
  assert.deepEqual(h.built.map((w) => w.focused), [0, 0]);
  h.built[0].on.dock();
  h.built[1].on.closed();
  assert.deepEqual(h.invoke('window:detachedPtys'), []);
});

test('term:openTask passes a non-empty string task id to the main window, ignores any other payload, and neither docks nor closes the window (#588)', async () => {
  const h = hub();
  await h.invoke('window:detach', TAB);
  const [win] = h.built;
  for (const bad of [undefined, null, '', 7, { taskId: 'board:I1' }]) win.on.openTask(bad);
  win.on.openTask('board:I7');
  await tick();
  assert.deepEqual(h.opened, ['board:I7']);
  assert.deepEqual([win.destroyed, h.sent], [false, []]);
  assert.deepEqual(h.invoke('window:detachedPtys'), [WORKER], 'the window stays');
});

test('term:openFile passes a checked file link to the main window with its tab\'s task or workspace, ignores any other payload, and neither docks nor closes the window (#717)', async () => {
  const h = hub();
  await h.invoke('window:detach', TAB);
  await h.invoke('window:detach', PROJECT_TAB);
  const [task, shell] = h.built;
  for (const bad of [undefined, null, 'src/a.ts', {}, { path: '' }, { path: 7 }, { path: 'a.ts', line: 0 }, { path: 'a.ts', line: 1, col: 1.5 }]) task.on.openFile(bad);
  task.on.openFile({ path: 'src/a.ts', line: 12, col: 3, extra: true });
  shell.on.openFile({ path: '/repo/README.md' });
  assert.deepEqual(h.files, [{ path: 'src/a.ts', line: 12, col: 3, task: 'board:I1' }, { path: '/repo/README.md', project: 'hive' }]);
  assert.deepEqual([task.destroyed, shell.destroyed, h.sent], [false, false, []]);
});
