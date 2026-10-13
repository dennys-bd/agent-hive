import { fireEvent } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  CENTER_MIN, clampSideSize, DEFAULT_DOCK_LAYOUT, type DockLayout, inEveryView, LOCKED_PANELS, onPanelKey, onQuickKey, onShortcutKey, onViewKey, PANELS, readDockLayout, runShortcut, shownBySide, sideOf, syncSide,
  VIEW_SHORTCUTS, withSide, writeDockLayout,
} from '@/lib/dock-layout';
import { setShortcuts } from '@/lib/shortcut-bindings';
import { readView, resetViewState } from '@/lib/view-state';

// The layout as the view state holds it (#484), read back through readDockLayout
const readStored = (value: unknown): DockLayout => {
  resetViewState({ dockLayout: value });
  return readDockLayout();
};
// Every value at a bound of its side, the two views different, every open flag set; the docks are the only ones there are (#295)
const LAYOUT: DockLayout = {
  docks: { automation: 'left', activities: 'left', detail: 'right' },
  sizes: { activities: { left: 15, right: 70 }, automation: { left: 70, right: 15 } },
  open: { activities: { left: false, right: true }, automation: { left: true, right: false } },
};
const ALL_OPEN = { left: true, right: true };

afterEach(() => vi.restoreAllMocks());

test('readDockLayout returns the defaults when nothing is saved: Automação on the left, the detail on the right, 30/30, only the left side open (#342, #353, #452, #456, #484)', () => {
  expect(DEFAULT_DOCK_LAYOUT).toEqual({
    docks: { automation: 'left', activities: 'left', detail: 'right' },
    sizes: { activities: { left: 30, right: 30 }, automation: { left: 30, right: 30 } },
    open: { activities: { left: true, right: false }, automation: { left: true, right: false } },
  });
  resetViewState();
  expect(readDockLayout()).toEqual(DEFAULT_DOCK_LAYOUT);
});

test('a value that is no object, an unknown side, a missing panel or size, a size out of its side\'s bounds, a missing or non-boolean open flag, the shape #342 wrote, or a panel docked at the bottom all read as the defaults, whole (#342, #452, #484)', () => {
  const bad: unknown[] = [
    '{oops', null, 42,
    { ...LAYOUT, docks: { automation: 'left', activities: 'left' } },
    { ...LAYOUT, docks: { ...LAYOUT.docks, detail: 'top' } },
    { ...LAYOUT, docks: { ...LAYOUT.docks, activities: 'top' } },
    { ...LAYOUT, docks: { ...LAYOUT.docks, detail: 'bottom' } }, // no bottom side since redesign 05: no migration
    { ...LAYOUT, sizes: { ...LAYOUT.sizes, activities: { left: 14, right: 30 } } },
    { ...LAYOUT, sizes: { ...LAYOUT.sizes, automation: { left: 30, right: 71 } } },
    { ...LAYOUT, sizes: { ...LAYOUT.sizes, automation: { left: 30 } } },
    { ...LAYOUT, sizes: { ...LAYOUT.sizes, activities: { left: 30, right: '30' } } },
    { ...LAYOUT, sizes: { activities: LAYOUT.sizes.activities } }, // a view missing (#821)
    { ...LAYOUT, open: { ...LAYOUT.open, activities: { left: true, right: 'yes' } } },
    { ...LAYOUT, open: { ...LAYOUT.open, automation: { left: true } } },
    { docks: LAYOUT.docks, sizes: { left: 30, right: 30 }, open: { left: true, right: false } }, // the shape before #821: no migration
    { docks: LAYOUT.docks, sizes: LAYOUT.sizes, terminal: { open: true, listWidth: 176 } }, // what #342 wrote: no migration
  ];
  for (const value of bad) expect(readStored(value)).toEqual(DEFAULT_DOCK_LAYOUT);
});

test('writeDockLayout puts the layout in the view state\'s dockLayout, and readDockLayout round-trips it at its bounds, rebuilt from the known keys only (#342, #452, #484)', () => {
  resetViewState();
  writeDockLayout(LAYOUT);
  expect(readView('dockLayout')).toEqual(LAYOUT);
  expect(readDockLayout()).toEqual(LAYOUT);
  const extra = { ...LAYOUT, extra: 1, docks: { ...LAYOUT.docks, other: 'left' }, open: { ...LAYOUT.open, top: { left: true, right: true }, activities: { ...LAYOUT.open.activities, top: true } } };
  expect(readStored(extra)).toEqual(LAYOUT);
});

test('clampSideSize holds left and right to 15..70 (#342)', () => {
  expect([clampSideSize('left', 5), clampSideSize('left', 90), clampSideSize('left', 42)]).toEqual([15, 70, 42]);
  expect([clampSideSize('right', 5), clampSideSize('right', 90)]).toEqual([15, 70]);
});

test('shownBySide shows nothing on a closed side; on an open one its active panel while docked there, else the first docked there, and nothing on a side with no panel (#342, #452, #746)', () => {
  const shared = sideOf(DEFAULT_DOCK_LAYOUT, 'activities');
  expect(shownBySide({ ...shared, open: ALL_OPEN }, { right: 'detail' })).toEqual({ left: 'activities', right: 'detail' });
  expect(shownBySide({ ...shared, open: ALL_OPEN }, {})).toEqual({ left: 'activities', right: 'detail' });
  expect(shownBySide(shared, { right: 'detail' })).toEqual({ left: 'activities' }); // the defaults: only the left side open, on Atividades (#746)
});

test('onPanelKey names the left and right side for Ctrl+Shift+B and Ctrl+Alt+Shift+B off macOS and Cmd+B and Cmd+Shift+B on macOS, on window in the capture phase and stopped there; another combination does nothing (#452, #585)', () => {
  const toggle = vi.fn();
  const off = onPanelKey(toggle);
  const inside = document.createElement('textarea'); // where xterm takes its keys
  document.body.appendChild(inside);
  const reached = vi.fn();
  inside.addEventListener('keydown', reached);
  const press = (init: KeyboardEventInit): boolean => inside.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  // false: preventDefault was called
  expect([press({ key: 'B', ctrlKey: true, shiftKey: true }), press({ key: 'B', ctrlKey: true, altKey: true, shiftKey: true })]).toEqual([false, false]);
  expect(toggle.mock.calls).toEqual([['left'], ['right']]);
  expect(reached).not.toHaveBeenCalled();
  // Ctrl+B is the terminal's off macOS (#585); Ctrl+Shift+J is the console's; the Windows key binds nothing
  for (const init of [{ key: 'b', ctrlKey: true }, { key: 'b', ctrlKey: true, altKey: true }, { key: 'J', ctrlKey: true, shiftKey: true }, { key: 'B', metaKey: true, shiftKey: true }, { key: 'j' }]) press(init);
  expect(toggle).toHaveBeenCalledTimes(2);
  expect(reached).toHaveBeenCalledTimes(5);
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  press({ key: 'b', metaKey: true });
  press({ key: 'b', ctrlKey: true }); // a terminal's own key on macOS
  expect(toggle.mock.calls.slice(2)).toEqual([['left']]);
  off();
  press({ key: 'b', metaKey: true });
  expect(toggle).toHaveBeenCalledTimes(3);
  inside.remove();
});

test('the console is no dock panel since redesign 05, it is a drawer over the center; a layout saved with its side still reads, the side dropped (#537)', () => {
  expect(PANELS).toEqual(['activities', 'automation', 'detail']);
  const withConsole = { ...LAYOUT, docks: { ...LAYOUT.docks, console: 'bottom' } };
  expect(readStored(withConsole)).toEqual(LAYOUT);
});

test('the terminal is no dock panel since redesign 07, its runs are tabs of their activity; a layout saved with its side and list width still reads, both dropped', () => {
  const withTerminal = { ...LAYOUT, docks: { ...LAYOUT.docks, terminal: 'right' }, terminal: { listWidth: 220 } };
  expect(readStored(withTerminal)).toEqual(LAYOUT);
});

test('the Activities tab docks on the left by default and comes first in tab order, so the left side opens on it; a layout saved before #457, with no activities, reads as the defaults whole (#457, #746)', () => {
  expect(PANELS.slice(0, 2)).toEqual(['activities', 'automation']);
  expect(DEFAULT_DOCK_LAYOUT.docks.activities).toBe('left');
  expect(shownBySide(sideOf(DEFAULT_DOCK_LAYOUT, 'activities'), {})).toEqual({ left: 'activities' });
  const { activities: _activities, ...before } = LAYOUT.docks;
  expect(readStored({ ...LAYOUT, docks: before })).toEqual(DEFAULT_DOCK_LAYOUT);
});

test('Automação docks on the left by default, right after Atividades in tab order, and shows once it is its side\'s active tab; a layout saved before it, with no docks.automation, reads as the defaults whole (#456, #746)', () => {
  expect(DEFAULT_DOCK_LAYOUT.docks.automation).toBe('left');
  expect(shownBySide(sideOf(DEFAULT_DOCK_LAYOUT, 'activities'), { left: 'automation' })).toEqual({ left: 'automation' });
  const { automation: _automation, ...before } = LAYOUT.docks;
  expect(readStored({ ...LAYOUT, docks: before })).toEqual(DEFAULT_DOCK_LAYOUT);
  expect(readStored({ ...LAYOUT, docks: { ...LAYOUT.docks, automation: 'top' } })).toEqual(DEFAULT_DOCK_LAYOUT);
});

test('every panel is fixed: Automação and Atividades on the left, Detalhes on the right; a stored layout with any of them elsewhere reads as the defaults whole (#458, #295)', () => {
  expect(LOCKED_PANELS).toEqual(['activities', 'automation']);
  for (const docks of [{ ...LAYOUT.docks, automation: 'right' }, { ...LAYOUT.docks, activities: 'right' }, { ...LAYOUT.docks, detail: 'left' }]) {
    expect(readStored({ ...LAYOUT, docks })).toEqual(DEFAULT_DOCK_LAYOUT);
  }
});

// A keydown as the browser sends it, on window: where onPanelKey listens, in the capture phase
const pressOnWindow = (init: KeyboardEventInit): void => { window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init })); };

test('onPanelKey follows the configured side shortcuts, with their exact modifiers, and not the old keys; a side turned off never toggles (#449)', () => {
  const toggle = vi.fn();
  const stop = onPanelKey(toggle);
  setShortcuts({ toggleRight: 'CmdOrCtrl+Shift+T', toggleLeft: null });
  pressOnWindow({ key: 'j', code: 'KeyJ', ctrlKey: true });
  pressOnWindow({ key: 't', code: 'KeyT', ctrlKey: true });
  pressOnWindow({ key: 'b', code: 'KeyB', ctrlKey: true });
  expect(toggle).not.toHaveBeenCalled();
  pressOnWindow({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true });
  pressOnWindow({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }); // the left side's key off macOS (#585), turned off here
  pressOnWindow({ key: 'B', code: 'KeyB', ctrlKey: true, altKey: true, shiftKey: true }); // the old key of the right side
  expect(toggle.mock.calls).toEqual([['right']]);
  setShortcuts({});
  stop();
});

test('onPanelKey leaves the key alone while a Settings key field records it (#449)', () => {
  const toggle = vi.fn();
  const stop = onPanelKey(toggle);
  const recorder = document.createElement('input');
  recorder.setAttribute('data-shortcut-recording', '');
  document.body.append(recorder);
  recorder.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true, bubbles: true, cancelable: true }));
  expect(toggle).not.toHaveBeenCalled();
  recorder.remove();
  stop();
});

test('runShortcut acts through the listener its key reaches, even with the key turned off, and reaches nothing once unsubscribed (#584)', () => {
  const toggle = vi.fn();
  const stop = onPanelKey(toggle);
  setShortcuts({ toggleLeft: null });
  runShortcut('toggleLeft');
  runShortcut('newActivity'); // another listener's
  stop();
  runShortcut('toggleLeft');
  setShortcuts({});
  expect(toggle.mock.calls).toEqual([['left']]);
});

test('the header\'s views list Atividades first: Ctrl+1 (⌘1 on macOS) goes to the activities and Ctrl+2 to the flow (#533, #746)', () => {
  expect(VIEW_SHORTCUTS).toEqual([['activities', 'viewActivities'], ['automation', 'viewFlow']]);
  const go = vi.fn();
  const stop = onViewKey(go);
  fireEvent.keyDown(window, { key: '1', code: 'Digit1', ctrlKey: true });
  fireEvent.keyDown(window, { key: '2', code: 'Digit2', ctrlKey: true });
  stop();
  expect(go.mock.calls).toEqual([['activities'], ['automation']]);
});

test('onQuickKey names searchOperations for F1, search for Ctrl+Shift+P and shortcutMap for Ctrl+/, off macOS (#584, #585, #639)', () => {
  const act = vi.fn();
  const stop = onQuickKey(act);
  fireEvent.keyDown(window, { key: 'F1', code: 'F1' });
  fireEvent.keyDown(window, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: '/', code: 'Slash', ctrlKey: true });
  stop();
  expect(act.mock.calls).toEqual([['searchOperations'], ['search'], ['shortcutMap']]);
});

test('a soon shortcut never fires, not even on its planned key, which it leaves to the page (#585)', () => {
  const act = vi.fn();
  const stop = onShortcutKey([[true, 'nextTab']], act);
  expect(fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true })).toBe(true);
  stop();
  expect(act).not.toHaveBeenCalled();
});

test('sideOf is one view\'s flat layout: the shared docks with that view\'s sizes and open flags (#821)', () => {
  expect(sideOf(LAYOUT, 'automation')).toEqual({ docks: LAYOUT.docks, sizes: { left: 70, right: 15 }, open: { left: true, right: false } });
  expect(inEveryView(1)).toEqual({ activities: 1, automation: 1 });
});

test('withSide per view changes that view alone and shared writes both; a size is clamped; already as asked it is the same layout back, the input untouched (#821)', () => {
  const closed = withSide(LAYOUT, 'automation', 'left', { open: false }, true);
  expect(closed.open).toEqual({ activities: { left: false, right: true }, automation: { left: false, right: false } });
  expect(closed.sizes).toBe(LAYOUT.sizes);
  const wider = withSide({ ...LAYOUT, open: inEveryView({ left: false, right: true }) }, 'activities', 'right', { size: 40 }, false); // no left open: no room to keep (#295)
  expect(wider.sizes).toEqual({ activities: { left: 15, right: 40 }, automation: { left: 70, right: 40 } });
  expect(withSide(LAYOUT, 'automation', 'left', { size: 90 }, true).sizes.automation.left).toBe(70);
  expect(withSide(LAYOUT, 'activities', 'left', { open: false }, true)).toBe(LAYOUT);
  expect(withSide(LAYOUT, 'activities', 'left', { open: false }, false)).not.toBe(LAYOUT); // the flow's left is still open
  expect(LAYOUT.open.automation.left).toBe(true);
});

test('syncSide copies one view\'s open flag and size for one side to the other view, the other side untouched (#821)', () => {
  const synced = syncSide(LAYOUT, 'activities', 'left');
  expect(synced.open).toEqual({ activities: { left: false, right: true }, automation: { left: false, right: false } });
  expect(synced.sizes).toEqual({ activities: { left: 15, right: 70 }, automation: { left: 15, right: 15 } });
});

test('onShortcutKey with accepts acts only on a key it accepts, and leaves a refused one to the page, not prevented (#818)', () => {
  const act = vi.fn();
  const inside = document.body.appendChild(document.createElement('button'));
  const outside = document.body.appendChild(document.createElement('button'));
  const stop = onShortcutKey([['clear', 'clear']], act, (event) => event.target === inside);
  expect(fireEvent.keyDown(outside, { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(inside, { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })).toBe(false);
  stop();
  inside.remove();
  outside.remove();
  expect(act.mock.calls).toEqual([['clear']]);
});

test('a side resized while the other is open stops where the center would go under 20% of the frame, never under its own bound; with the other closed it reaches 70; a stored 70 / 70 reads as is (#295)', () => {
  const at = (rightOpen: boolean): DockLayout => ({ docks: DEFAULT_DOCK_LAYOUT.docks, sizes: inEveryView({ left: 30, right: 40 }), open: inEveryView({ left: true, right: rightOpen }) });
  expect(CENTER_MIN).toBe(20);
  expect(withSide(at(true), 'activities', 'left', { size: 70 }, true).sizes.activities.left).toBe(40);
  expect(withSide(at(false), 'activities', 'left', { size: 70 }, true).sizes.activities.left).toBe(70);
  expect(withSide(at(true), 'activities', 'left', { size: 70 }, false).sizes).toEqual(inEveryView({ left: 40, right: 40 })); // shared: both views
  const wide: DockLayout = { docks: DEFAULT_DOCK_LAYOUT.docks, sizes: inEveryView({ left: 70, right: 70 }), open: inEveryView(ALL_OPEN) };
  expect(readStored(wide)).toEqual(wide); // no migration: a resize of the wide side fixes it
  expect(withSide(wide, 'activities', 'right', { size: 70 }, true).sizes.activities.right).toBe(15); // the left at 70 leaves 10, floored at the right's own 15
});
