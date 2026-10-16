// Where each main window panel docks, how big each side is and which sides are open (#342, #452): per-viewer UI state, as #251's and #341's
// layouts were, kept in the view state (#484) and never a setting. Anything unreadable or out of range falls back to the defaults whole, the shape #342
// wrote (its terminal flag, no per-side flags), one from before #456 (no Automação), one with Automação or Atividades off the left (#458) and one with Detalhes off the right (#295)
// included: there is one user, so no migration. Which tab each group shows is not stored: it follows what the user last opened. The panel keys
// live here too (#452): they name a side, not a panel. There is no bottom side since redesign 05: a layout that docks a panel there reads as
// the defaults. There is no terminal panel since redesign 07: a run is a tab of its activity's center. Each view keeps its own sizes and open
// flags (#821), the docks shared; a layout from before #821 reads as the defaults whole. plugins (#313) is the third view; a layout from before
// it reads with its defaults, the other two views kept.
import { isEditorKey } from '@/lib/monaco-keys';
import { isRecording, pressed, pressedFixed } from '@/lib/shortcut-bindings';
import { readView, writeView } from '@/lib/view-state';
import type { FixedShortcutId } from '../../shortcut-registry';
import type { OperationId } from '../../types';

export type Side = 'left' | 'right';
export type PanelId = 'automation' | 'activities' | 'plugins' | 'detail';
/** The dashboard's three views (#533, #821, #313); use-activity's CenterMode is an alias of it. */
export type ViewId = 'activities' | 'automation' | 'plugins';
export const VIEWS: readonly ViewId[] = ['activities', 'automation', 'plugins'];
/** Whether a dock tab is a view's (#313): its click switches the center instead of opening its side. */
export const isView = (panel: PanelId): panel is ViewId => (VIEWS as readonly PanelId[]).includes(panel);
/** One view's sides as DockFrame draws them (#821). sizes: percent of the frame's width. open: whether each side's panel shows (#452). */
export interface ViewLayout { docks: Record<PanelId, Side>; sizes: Record<Side, number>; open: Record<Side, boolean> }
// docks stays though every panel is fixed (#295): DockFrame, shownBySide, use-dock and MainDock place the panels by it
/** What the view state keeps (#821): where each panel docks, shared by the views, and each view's own sizes and open flags. */
export interface DockLayout { docks: Record<PanelId, Side>; sizes: Record<ViewId, Record<Side, number>>; open: Record<ViewId, Record<Side, boolean>> }
/** A change to one side (#821): its open flag or its size. */
export type SideChange = { open: boolean } | { size: number };
/** The panel each group shows; a side missing has none. */
export type ActiveTabs = Partial<Record<Side, PanelId>>;

export const SIDES: readonly Side[] = ['left', 'right'];
/** Also the order of the tabs in a shared group: Activities first, the tab its side opens on (#457, #746), Automação right after it (#456). */
export const PANELS: readonly PanelId[] = ['activities', 'automation', 'plugins', 'detail'];
/** The tabs that decide the center (#458), locked to the left panel: "the center follows the left tab" then has one meaning. */
export const LOCKED_PANELS: readonly PanelId[] = ['activities', 'automation', 'plugins'];
export const isLocked = (panel: PanelId): boolean => LOCKED_PANELS.includes(panel);
// A group has one edge to drag, so the size belongs to the side. The bounds keep a column (or a strip) of the view visible.
export const SIDE_BOUNDS: Record<Side, { min: number; max: number }> = { left: { min: 15, max: 70 }, right: { min: 15, max: 70 } };
// The left panel starts open on Activities (#457, #746), with Automação (#456) beside it; the first task or session opens its own panel
// through activation (#452).
/** The same value for every view (#821). */
export const inEveryView = <T>(value: T): Record<ViewId, T> => ({ activities: value, automation: value, plugins: value });

export const DEFAULT_DOCK_LAYOUT: DockLayout = {
  docks: { automation: 'left', activities: 'left', plugins: 'left', detail: 'right' },
  sizes: inEveryView({ left: 30, right: 30 }),
  open: inEveryView({ left: true, right: false }),
};

export const clampSideSize = (side: Side, size: number): number => Math.min(SIDE_BOUNDS[side].max, Math.max(SIDE_BOUNDS[side].min, size));

/** The share of the frame the center keeps while both sides are open (#295), percent of the frame as the sides' sizes are. */
export const CENTER_MIN = 20;

// The room `side` has (#295): what the other side leaves of the frame past CENTER_MIN, in the tightest of `views` where it is open; Infinity
// where it is open in none. 70 + 70 is 140% of the frame, which no min-w-0 can fit
function roomFor(layout: DockLayout, views: readonly ViewId[], side: Side): number {
  const other: Side = side === 'left' ? 'right' : 'left';
  return Math.min(...views.filter((view) => layout.open[view][other]).map((view) => 100 - CENTER_MIN - layout.sizes[view][other]));
}

/** One view's flat layout (#821): the shared docks with that view's sizes and open flags, the shape DockFrame and shownBySide read. */
export const sideOf = (layout: DockLayout, view: ViewId): ViewLayout => ({ docks: layout.docks, sizes: layout.sizes[view], open: layout.open[view] });

// `value` on `side` in the `targets` views; every other view and side kept as it is
function setIn<T>(byView: Record<ViewId, Record<Side, T>>, targets: readonly ViewId[], side: Side, value: T): Record<ViewId, Record<Side, T>> {
  const at = (view: ViewId): Record<Side, T> => (targets.includes(view) ? { ...byView[view], [side]: value } : byView[view]);
  return { activities: at('activities'), automation: at('automation'), plugins: at('plugins') };
}

/** `change` on `side` (#821): in `view` alone while the side is kept per view, else in every view, so the two stay equal and the side behaves as
 * one shared state. A size is clamped to its side's bounds and, while the other side is open, to what keeps the center at CENTER_MIN (#295). Already as asked: the same layout back, so the dock does not render. */
export function withSide(layout: DockLayout, view: ViewId, side: Side, change: SideChange, isPerView: boolean): DockLayout {
  const targets = isPerView ? [view] : VIEWS;
  if ('open' in change) {
    const isSame = targets.every((v) => layout.open[v][side] === change.open);
    return isSame ? layout : { ...layout, open: setIn(layout.open, targets, side, change.open) };
  }
  // Never under the side's own bound: readDockLayout refuses a size out of it and would put back the defaults whole
  const size = Math.max(SIDE_BOUNDS[side].min, Math.min(clampSideSize(side, change.size), roomFor(layout, targets, side)));
  return targets.every((v) => layout.sizes[v][side] === size) ? layout : { ...layout, sizes: setIn(layout.sizes, targets, side, size) };
}

/** `from`'s open flag and size for `side`, copied to every view (#821): a side whose setting turns off starts out equal in both. */
export const syncSide = (layout: DockLayout, from: ViewId, side: Side): DockLayout =>
  withSide(withSide(layout, from, side, { open: layout.open[from][side] }, false), from, side, { size: layout.sizes[from][side] }, false);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const inBounds = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

type SideCheck<T> = (side: Side, value: unknown) => value is T;
const isSize: SideCheck<number> = (side, value): value is number => inBounds(value, SIDE_BOUNDS[side].min, SIDE_BOUNDS[side].max);
const isFlag: SideCheck<boolean> = (_side, value): value is boolean => typeof value === 'boolean';

// One view's two sides rebuilt from the known keys only; undefined when either is missing or wrong
function sidesOf<T>(value: unknown, isValue: SideCheck<T>): Record<Side, T> | undefined {
  if (!isObject(value)) return undefined;
  const { left, right } = value;
  return isValue('left', left) && isValue('right', right) ? { left, right } : undefined;
}

// Every view's sides (#821); undefined when activities or automation is missing, which the flat shape from before #821 always is. A layout
// from before #313 has no plugins: it takes `pluginsDefault`; one that has it must have it right
function viewsOf<T>(value: unknown, isValue: SideCheck<T>, pluginsDefault: Record<Side, T>): Record<ViewId, Record<Side, T>> | undefined {
  if (!isObject(value)) return undefined;
  const activities = sidesOf(value.activities, isValue);
  const automation = sidesOf(value.automation, isValue);
  const plugins = value.plugins === undefined ? pluginsDefault : sidesOf(value.plugins, isValue);
  return activities && automation && plugins ? { activities, automation, plugins } : undefined;
}

// What writeDockLayout wrote, rebuilt from the known keys only; undefined for anything else, a layout from before #353, #456, #457 or #821 included.
function parseLayout(value: unknown): DockLayout | undefined {
  if (!isObject(value) || !isObject(value.docks)) return undefined;
  const { automation, activities, detail, plugins = 'left' } = value.docks; // a stored console (before redesign 05) or terminal side (before redesign 07) is ignored
  // Every panel is fixed (#458, #295): the three views on the left, Detalhes on the right; a layout with one elsewhere is not one
  // writeDockLayout wrote since, and reads as the defaults whole (one user, no migration)
  if (automation !== 'left' || activities !== 'left' || plugins !== 'left' || detail !== 'right') return undefined;
  const sizes = viewsOf(value.sizes, isSize, DEFAULT_DOCK_LAYOUT.sizes.plugins);
  const open = viewsOf(value.open, isFlag, DEFAULT_DOCK_LAYOUT.open.plugins);
  return sizes && open ? { docks: { automation, activities, plugins, detail }, sizes, open } : undefined;
}

/** The saved layout, or the defaults when there is none or it is not what writeDockLayout wrote. */
export const readDockLayout = (): DockLayout => parseLayout(readView('dockLayout')) ?? DEFAULT_DOCK_LAYOUT;

export const writeDockLayout = (layout: DockLayout): void => writeView('dockLayout', layout);

/** What each side shows (#342, #452): nothing while the side is closed, else its active panel while that one is docked there, else the
 * first panel docked there in PANELS order. Every panel always has a tab (#452). */
export function shownBySide(layout: ViewLayout, active: ActiveTabs): ActiveTabs {
  return Object.fromEntries(SIDES.flatMap((side) => {
    if (!layout.open[side]) return [];
    const here = PANELS.filter((panel) => layout.docks[panel] === side);
    const pick = here.find((panel) => panel === active[side]) ?? here[0];
    return pick === undefined ? [] : [[side, pick]];
  }));
}

// The shortcut of each side (#452, #449): Cmd+B the left, Cmd+Shift+B the right by default. Ctrl+B is an editing key inside a macOS
// terminal, so the defaults use Cmd there (CmdOrCtrl).
const SIDE_SHORTCUTS: ReadonlyArray<[Side, OperationId]> = [['left', 'toggleLeft'], ['right', 'toggleRight']];

// An operation run from the search (#584) reaches the same listeners a key does, by the shortcut's id: it does exactly what the key does,
// a key turned off included
const RUN_EVENT = 'hive:run-shortcut';

// A keydown listener on window in the capture phase, stopped there, so a shortcut works with the focus inside xterm and the key never
// reaches the pty. The bindings are read at each key; a Settings key field that is recording keeps the key. `accepts` (#818): a key it
// refuses goes on to wherever it was going, unprevented (the files tree's keys act only with the focus in the tree). Returns the unsubscribe.
export function onShortcutKey<T>(shortcuts: ReadonlyArray<[T, OperationId]>, act: (value: T) => void, accepts: (event: KeyboardEvent) => boolean = () => true): () => void {
  const listener = (event: KeyboardEvent): void => {
    const hit = isRecording(event.target) ? undefined : shortcuts.find(([, id]) => pressed(event, id) && !isEditorKey(id, event.target)); // #780: ⌘. in the editor is its quick fix
    if (hit === undefined || !accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    act(hit[0]);
  };
  const run = (event: Event): void => {
    const hit = event instanceof CustomEvent ? shortcuts.find(([, id]) => id === event.detail) : undefined;
    if (hit !== undefined) act(hit[0]);
  };
  window.addEventListener('keydown', listener, true);
  window.addEventListener(RUN_EVENT, run);
  return () => {
    window.removeEventListener('keydown', listener, true);
    window.removeEventListener(RUN_EVENT, run);
  };
}

/** What shortcut `id`'s key does, without the key (#584): the search's operations run through it. */
export const runShortcut = (id: OperationId): void => {
  window.dispatchEvent(new CustomEvent<OperationId>(RUN_EVENT, { detail: id }));
};

/** The toggleLeft and toggleRight shortcuts call `toggle` with their side (#452; rebindable, #449). */
export const onPanelKey = (toggle: (side: Side) => void): (() => void) => onShortcutKey(SIDE_SHORTCUTS, toggle);

// The header's views (#533), activities first (#746): Cmd+1 atividades, the Atividades tab; Cmd+2 fluxo, the Automação tab; Cmd+3 plugins (#313).
export const VIEW_SHORTCUTS: ReadonlyArray<[PanelId, OperationId]> = [['activities', 'viewActivities'], ['automation', 'viewFlow'], ['plugins', 'viewPlugins']];

/** The viewActivities and viewFlow shortcuts call `go` with their tab. */
export const onViewKey = (go: (panel: PanelId) => void): (() => void) => onShortcutKey(VIEW_SHORTCUTS, go);

/** What the activities home's keys do (redesign 08): nova atividade, buscar, buscar comandos (#584), a new terminal, run a command (#585)
 * and the shortcut map (#639). */
export type QuickAction = 'newActivity' | 'search' | 'searchOperations' | 'newTerminal' | 'runCommand' | 'shortcutMap';
const QUICK_SHORTCUTS: ReadonlyArray<[QuickAction, OperationId]> = [
  ['newActivity', 'newActivity'], ['search', 'search'], ['searchOperations', 'searchOperations'], ['newTerminal', 'newTerminal'], ['runCommand', 'runCommand'],
  ['shortcutMap', 'shortcutMap'],
];

/** The newActivity, search, searchOperations, newTerminal, runCommand and shortcutMap shortcuts call `act` with their action. */
export const onQuickKey = (act: (action: QuickAction) => void): (() => void) => onShortcutKey(QUICK_SHORTCUTS, act);

/** A fixed row's keys (#585): `act` gets the index of the key pressed in this platform's list (the signal's rank, a source's digit). The same
 * capture-phase listener as a shortcut's, stopped there, so it works with the focus in a terminal. Returns the unsubscribe. */
export function onFixedKey(id: FixedShortcutId, act: (index: number) => void): () => void {
  const listener = (event: KeyboardEvent): void => {
    const index = isRecording(event.target) ? -1 : pressedFixed(event, id);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    act(index);
  };
  window.addEventListener('keydown', listener, true);
  return () => window.removeEventListener('keydown', listener, true);
}
