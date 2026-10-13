// The center's layout under Atividades (#458): one per activity (per task), VS Code's editor groups in small. A tree of splits (rows and
// columns, split-tree.ts) whose leaves are groups of tabs, each tab a run's terminal, a task's diff or the console (redesign 05); a run's tab
// may hold a split of terminal panes of its own (#641, pane-split.ts). Pure: every function returns a new layout and never touches its input.
// Stored per viewer in the view state like the dock's (#342, #484), never a setting; what does not read back as written is dropped.
import type { DiffScope } from '../../types';
import { focusPane, leavesOf, type Panes, parsePanes, prunePanes, renamePane, splitPane } from './pane-split.js';
import { type Axis, isObject, leaves, parseTree, rebuild, resizeAt, type TreeNode, type TreeSplit } from './split-tree.js';
import { readView, writeView } from './view-state.js';

export type { PaneNode, Panes } from './pane-split.js';

/** What a layout stores of a tab: enough to rebuild it from the activity's live runs and its task. A run's tab split into panes (#641) keeps
 * one of its runs, the anchor, as its ptyId and its key; the anchor is always one of its panes. A run tab whose anchor holds a session names
 * it (#696): after a restart the tab still knows the session to continue. */
export type CenterTabRef = { kind: 'run'; ptyId: string; panes?: Panes; sessionId?: string } | { kind: 'diff'; scope: DiffScope; checkpoint?: number } | { kind: 'console'; channel?: string; locked?: true; run?: string } | { kind: 'file'; path: string } | { kind: 'preview'; path: string } | { kind: 'design'; path: string } | { kind: 'changes'; path: string } | { kind: 'untitled'; n: number };
export type RunRef = Extract<CenterTabRef, { kind: 'run' }>;
/** A console tab (#755): the channel it shows, its own and saved with the layout; locked on a commands stage's channel, with no channel select.
 * No channel: the newest one, as a tab stored before #755 reads. */
export type ConsoleRef = Extract<CenterTabRef, { kind: 'console' }>;
export const consoleRef = (channel?: string, locked = false, run?: string): ConsoleRef =>
  ({ kind: 'console', ...(channel === undefined ? {} : { channel }), ...(locked ? { locked: true as const } : {}), ...(run === undefined ? {} : { run }) });
export interface TabGroup { kind: 'group'; id: string; tabs: CenterTabRef[]; active: number }
export type Split = TreeSplit<TabGroup>;
export type CenterNode = TreeNode<TabGroup>;
/** focused: a TabGroup's id, the group opens land in. */
export interface CenterLayout { root: CenterNode; focused: string }
export type Edge = 'left' | 'right' | 'top' | 'bottom';

const HALF = 50;
const EDGE_AXIS: Record<Edge, Axis> = { left: 'row', right: 'row', top: 'column', bottom: 'column' };

/** A tab's identity in its layout (#458), as the Terminal panel's tabKey (#270): the run's pty id, its diff's scope, its file's
 * path (#717), its preview's (#697), its design's (#109) or its changes' (#668), or an untitled tab's number (#818: a buffer with no file, never stored, center-files.ts), or the console's channel (#755: one tab per channel, and per stage execution for a stage's; `console` for one with none). */
export function refKey(ref: CenterTabRef): string {
  if (ref.kind === 'run') return ref.ptyId;
  if (ref.kind === 'file') return `file:${ref.path}`;
  if (ref.kind === 'preview') return `preview:${ref.path}`;
  if (ref.kind === 'design') return `design:${ref.path}`; // #109: one tab per file, beside its editor tab
  if (ref.kind === 'changes') return `changes:${ref.path}`;
  if (ref.kind === 'untitled') return `untitled:${ref.n}`; // #818
  if (ref.kind === 'console') return ref.channel === undefined ? 'console' : `console:${ref.channel}${ref.run === undefined ? '' : `#${ref.run}`}`; // a channel is encoded, never holding a #
  return `diff:${ref.scope}${ref.checkpoint === undefined ? '' : `:${ref.checkpoint}`}`;
}

// A posix path with its `.` and empty segments gone and each `..` taken back (#697): a relative path's leading `..` stays, for isFilePath to
// refuse, and the root's parent is the root. String work only: the page has no node:path
function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/');
  const parts: string[] = []; // local to this call, so the push below mutates nothing shared
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') parts.push(part);
    else if (parts.length > 0 && parts.at(-1) !== '..') parts.pop();
    else if (!isAbsolute) parts.push(part);
  }
  return `${isAbsolute ? '/' : ''}${parts.join('/')}`;
}

/** A file tab's path (#717, #697): relative to the activity's folder without a `..` segment, or absolute (a file outside it) as
 * normalizePath leaves it; never empty. */
export const isFilePath = (path: string): boolean =>
  path !== '' && path !== '/' && !path.split('/').includes('..') && (!path.startsWith('/') || normalizePath(path) === path);

/** A clicked path as a tab's (#717, #697): resolved against `folder`, then relative to it when it lands inside, else absolute and normalized;
 * a relative path with no folder known stays relative, cleaned. Undefined for an empty path, and for a relative one that climbs out with no
 * folder to climb from, which the caller resolves another way (#818). */
export function fileRefPath(path: string, folder?: string): string | undefined {
  if (path === '') return undefined;
  const full = normalizePath(path.startsWith('/') || folder === undefined ? path : `${folder}/${path}`);
  const inside = folder !== undefined && full.startsWith(`${folder}/`) ? full.slice(folder.length + 1) : full;
  return isFilePath(inside) ? inside : undefined;
}

/** Every run a tab shows (#641): a split tab's panes in reading order, a run tab's one run, none for a diff, a PR or the console. */
export function runsOf(ref: CenterTabRef): string[] {
  if (ref.kind !== 'run') return [];
  return ref.panes === undefined ? [ref.ptyId] : leavesOf(ref.panes.root);
}

// Whether the tab is the one `key` names, or holds that run as one of its panes (#641)
const holds = (ref: CenterTabRef, key: string): boolean => refKey(ref) === key || runsOf(ref).includes(key);

/** Every group of the tree, in reading order. */
export const groupsOf = (node: CenterNode): TabGroup[] => leaves(node);

const findRef = (layout: CenterLayout, key: string): CenterTabRef | undefined =>
  groupsOf(layout.root).flatMap((group) => group.tabs).find((ref) => refKey(ref) === key);

/** Whether another tab of the layout holds the same file's buffer (#668): a file tab's changes tab, or a changes tab's file tab. The buffer
 * goes only with the last of the two. */
export function sharesBuffer(layout: CenterLayout | undefined, ref: CenterTabRef): boolean {
  if (layout === undefined || (ref.kind !== 'file' && ref.kind !== 'changes')) return false;
  return findRef(layout, refKey({ kind: ref.kind === 'file' ? 'changes' : 'file', path: ref.path })) !== undefined;
}

// A counter over the ids in use, so the module stays pure: g1, g2, …
function nextId(root: CenterNode): string {
  const numbers = groupsOf(root).map((group) => Number(group.id.slice(1)) || 0);
  return `g${Math.max(0, ...numbers) + 1}`;
}

/** A first layout: one group holding the tab, focused. */
export const initialLayout = (ref: CenterTabRef): CenterLayout => ({ root: { kind: 'group', id: 'g1', tabs: [ref], active: 0 }, focused: 'g1' });

// The group without that tab, maybe empty; the shown tab stays shown, or its neighbour when it was the one removed
function withoutKey(group: TabGroup, key: string): TabGroup {
  const index = group.tabs.findIndex((ref) => refKey(ref) === key);
  if (index === -1) return group;
  const tabs = group.tabs.filter((_, i) => i !== index);
  const active = index < group.active ? group.active - 1 : Math.min(group.active, Math.max(0, tabs.length - 1));
  return { ...group, tabs, active };
}
const nonEmpty = (group: TabGroup): TabGroup | undefined => (group.tabs.length === 0 ? undefined : group);

// The layout around a new root: the focus kept while its group stands, else the first group's
function settle(root: CenterNode | undefined, focused: string): CenterLayout | undefined {
  if (root === undefined) return undefined;
  const groups = groupsOf(root);
  return { root, focused: groups.some((group) => group.id === focused) ? focused : groups[0].id };
}

/** Every tab replaced by what `change` gives it, in its place; center-files.ts follows a rename through it (#818). */
export const mapTabs = (layout: CenterLayout, change: (ref: CenterTabRef) => CenterTabRef): CenterLayout =>
  settle(rebuild(layout.root, (group) => ({ ...group, tabs: group.tabs.map(change) })), layout.focused) ?? layout;

/** Shows a group's tab and focuses the group; an unknown group or index leaves the layout as it is. */
export function selectRef(layout: CenterLayout, group: string, index: number): CenterLayout {
  const target = groupsOf(layout.root).find((g) => g.id === group);
  if (target === undefined || index < 0 || index >= target.tabs.length) return layout;
  return settle(rebuild(layout.root, (g) => (g.id === group ? { ...g, active: index } : g)), group) ?? layout;
}

// The tab holding `key` (as its own key or as one of its panes) shown and its group focused, that pane focused when it is one (#641);
// undefined when no tab holds it
function showHolder(layout: CenterLayout, key: string): CenterLayout | undefined {
  const holder = groupsOf(layout.root).find((group) => group.tabs.some((tab) => holds(tab, key)));
  if (holder === undefined) return undefined;
  const shown = selectRef(layout, holder.id, holder.tabs.findIndex((tab) => holds(tab, key)));
  return mapTabs(shown, (tab) => (tab.kind === 'run' && tab.panes !== undefined && holds(tab, key) ? { ...tab, panes: focusPane(tab.panes, key) } : tab));
}

/** A tab into the focused group, at its end and shown; one already in the layout is shown where it is instead, its group focused, and a run
 * that is a pane of a split tab shows that tab with the pane focused (#641). */
export function openRef(layout: CenterLayout, ref: CenterTabRef): CenterLayout {
  const shown = showHolder(layout, refKey(ref));
  if (shown !== undefined) return shown;
  const add = (group: TabGroup): TabGroup =>
    (group.id === layout.focused ? { ...group, tabs: [...group.tabs, ref], active: group.tabs.length } : group);
  return settle(rebuild(layout.root, add), layout.focused) ?? layout;
}

/** A commands stage's locked console tab (#755) at the end of the layout's first group, shown there, the focus left where it was; the layout
 * made around it when there is none. A layout already holding a tab on that channel and execution is returned as it is. */
export function withStageConsole(layout: CenterLayout | undefined, channel: string, run: string): CenterLayout {
  const ref = consoleRef(channel, true, run);
  if (layout === undefined) return initialLayout(ref);
  if (findRef(layout, refKey(ref)) !== undefined) return layout;
  const first = groupsOf(layout.root)[0]?.id;
  const add = (group: TabGroup): TabGroup => (group.id === first ? { ...group, tabs: [...group.tabs, ref], active: group.tabs.length } : group);
  return settle(rebuild(layout.root, add), layout.focused) ?? layout;
}

/** The run in focus (#492): the focused group's shown tab's, its focused pane's on a split tab (#641); undefined when that group shows a
 * diff or there is no layout. */
export function shownRun(layout: CenterLayout | undefined): string | undefined {
  const focused = layout === undefined ? undefined : groupsOf(layout.root).find((group) => group.id === layout.focused);
  const ref = focused?.tabs[focused.active];
  if (ref?.kind !== 'run') return undefined;
  return ref.panes?.focused ?? ref.ptyId;
}

/** The file in focus (#295): the focused group's shown tab's path when it is a file; what the footer's checkers follow. */
export function shownFile(layout: CenterLayout | undefined): string | undefined {
  const focused = layout === undefined ? undefined : groupsOf(layout.root).find((group) => group.id === layout.focused);
  const ref = focused?.tabs[focused.active];
  return ref?.kind === 'file' ? ref.path : undefined;
}

/** The layout without that tab: an emptied group goes and its split collapses; undefined once no tab is left. */
export const closeRef = (layout: CenterLayout, key: string): CenterLayout | undefined =>
  settle(rebuild(layout.root, (group) => nonEmpty(withoutKey(group, key))), layout.focused);

/** A tab turned into another in place (#591): the diff pane's scope picker. When that other one is already in the layout, the first closes
 * and the other shows, as a second open of it would. */
export function retargetRef(layout: CenterLayout, key: string, ref: CenterTabRef): CenterLayout {
  const next = refKey(ref);
  if (next === key) return layout;
  if (findRef(layout, next) !== undefined) return openRef(closeRef(layout, key) ?? layout, ref);
  return mapTabs(layout, (tab) => (refKey(tab) === key ? ref : tab));
}

/** A tab moved to `index` of `toGroup` (its place among that group's tabs without it, clamped), shown there and its group focused. */
export function moveRef(layout: CenterLayout, key: string, toGroup: string, index: number): CenterLayout {
  const ref = findRef(layout, key);
  if (ref === undefined || !groupsOf(layout.root).some((group) => group.id === toGroup)) return layout;
  const root = rebuild(layout.root, (group) => {
    const rest = withoutKey(group, key);
    if (group.id !== toGroup) return nonEmpty(rest);
    const at = Math.max(0, Math.min(rest.tabs.length, index));
    return { ...rest, tabs: [...rest.tabs.slice(0, at), ref, ...rest.tabs.slice(at)], active: at };
  });
  return settle(root, toGroup) ?? layout;
}

/** A tab moved into a new group on `edge` of `group`, the new group taking `share` percent of that group's place (half by default, as a
 * drag lands; the split menu gives the new pane 44, #536) and the focus. A group's only tab stays. */
export function splitWith(layout: CenterLayout, key: string, group: string, edge: Edge, share = HALF): CenterLayout {
  const ref = findRef(layout, key);
  const target = groupsOf(layout.root).find((g) => g.id === group);
  if (ref === undefined || target === undefined) return layout;
  if (target.tabs.length === 1 && refKey(target.tabs[0]) === key) return layout; // nothing is left to split from
  const fresh: TabGroup = { kind: 'group', id: nextId(layout.root), tabs: [ref], active: 0 };
  const isFirst = edge === 'left' || edge === 'top';
  const root = rebuild(layout.root, (g) => {
    const rest = withoutKey(g, key);
    if (g.id !== group) return nonEmpty(rest);
    const children = isFirst ? [fresh, rest] : [rest, fresh];
    return { kind: 'split', axis: EDGE_AXIS[edge], children, sizes: isFirst ? [share, 100 - share] : [100 - share, share] };
  });
  return settle(root, fresh.id) ?? layout;
}

/** A divider's move: the split at `path` takes `sizes` (one per child, else nothing changes), each clamped to MIN_SIZE. */
export const resize = (layout: CenterLayout, path: readonly number[], sizes: number[]): CenterLayout => ({ ...layout, root: resizeAt(layout.root, path, sizes) });

/** A split tab's panes changed (#641): a pane's focus or a divider's move. A tab that is not split, or no tab of that key, is left as it is. */
export const changePanes = (layout: CenterLayout, tabKey: string, change: (panes: Panes) => Panes): CenterLayout =>
  mapTabs(layout, (tab) => (tab.kind === 'run' && tab.panes !== undefined && refKey(tab) === tabKey ? { ...tab, panes: change(tab.panes) } : tab));

/** A run that just landed as a tab, folded into another tab's split (#641), ⌘D's last step: its tab goes from wherever it landed, and the
 * anchor tab's focused pane splits with it on `axis`, half and half, the new pane focused and its tab shown. Anything else (an unknown key,
 * a key that is no run tab, the same key twice, a landed tab that is split itself) leaves the layout. */
export function foldIntoPane(layout: CenterLayout, anchorKey: string, newKey: string, axis: Axis): CenterLayout {
  const anchor = findRef(layout, anchorKey);
  const landed = findRef(layout, newKey);
  if (anchor?.kind !== 'run' || landed?.kind !== 'run' || landed.panes !== undefined || anchorKey === newKey) return layout;
  const panes = splitPane(anchor.panes, anchor.ptyId, anchor.panes?.focused ?? anchor.ptyId, newKey, axis);
  const without = closeRef(layout, newKey);
  if (panes === undefined || without === undefined) return layout;
  return showHolder(mapTabs(without, (tab) => (refKey(tab) === anchorKey ? { ...anchor, panes } : tab)), newKey) ?? layout;
}

/** A sleeping run's tab handed to the run that continues its session (#672), in place: the tab, or its pane on a split tab, takes the new run's
 * id. A layout with no tab holding `from` is returned as it is; a file, a diff, a PR or the console tab is never touched. */
export function replaceRun(layout: CenterLayout, from: string, to: string): CenterLayout {
  if (!groupsOf(layout.root).some((group) => group.tabs.some((tab) => runsOf(tab).includes(from)))) return layout;
  const swap = (tab: RunRef): RunRef => {
    const ptyId = tab.ptyId === from ? to : tab.ptyId;
    const session = tab.sessionId === undefined ? {} : { sessionId: tab.sessionId }; // #696: the same session runs on in the new run
    return tab.panes === undefined ? { kind: 'run', ptyId, ...session } : { kind: 'run', ptyId, panes: renamePane(tab.panes, from, to), ...session };
  };
  return mapTabs(layout, (tab) => (tab.kind === 'run' && runsOf(tab).includes(from) ? swap(tab) : tab));
}

const NO_SESSIONS: ReadonlySet<string> = new Set();

// A run tab with only the runs `isLive` accepts (#641): its panes pruned, the anchor handed to the first run left in reading order when it
// was one of those gone (the tab's key changes with it); undefined once none is left. An anchor whose session sleeps stays (#696): after a
// restart its run is gone, and the tab waits as a sleeping one
function keepRuns(ref: RunRef, isLive: (ptyId: string) => boolean, sleeping: ReadonlySet<string>): RunRef | undefined {
  const held = (ptyId: string): boolean => isLive(ptyId) || (ptyId === ref.ptyId && ref.sessionId !== undefined && sleeping.has(ref.sessionId));
  const runs = runsOf(ref).filter(held);
  if (runs.length === 0) return undefined;
  const ptyId = held(ref.ptyId) ? ref.ptyId : runs[0];
  const session = ptyId === ref.ptyId && ref.sessionId !== undefined ? { sessionId: ref.sessionId } : {};
  const panes = ref.panes && prunePanes(ref.panes, held);
  return panes === undefined ? { kind: 'run', ptyId, ...session } : { kind: 'run', ptyId, panes, ...session };
}

// The group with each tab's dead runs gone: a tab that keeps some stays in its place, one that keeps none leaves as closeRef's does
function pruneGroup(group: TabGroup, isLive: (ptyId: string) => boolean, sleeping: ReadonlySet<string>): TabGroup | undefined {
  const kept = group.tabs.map((tab) => (tab.kind === 'run' ? keepRuns(tab, isLive, sleeping) : tab));
  const emptied = group.tabs.filter((_, i) => kept[i] === undefined).map(refKey);
  const tabs = kept.map((tab, i) => tab ?? group.tabs[i]);
  return nonEmpty(emptied.reduce(withoutKey, { ...group, tabs }));
}

// The layout with only the runs `isLive` accepts (and the tabs of sleeping sessions, #696), then without its emptied groups; the same object
// back when every run passes
function pruneRuns(layout: CenterLayout, isLive: (ptyId: string) => boolean, sleeping: ReadonlySet<string> = NO_SESSIONS): CenterLayout | undefined {
  if (groupsOf(layout.root).every((group) => group.tabs.every((tab) => runsOf(tab).every(isLive)))) return layout;
  return settle(rebuild(layout.root, (group) => pruneGroup(group, isLive, sleeping)), layout.focused);
}

/** The layout without the runs no longer live (diffs, PRs and the console stay): a split tab loses those panes and hands its key on when its
 * anchor ended (#641), a tab with no run left goes, then its emptied group, unless its anchor names a session in `sleeping` (#696); undefined
 * once nothing is left. */
export const prune = (layout: CenterLayout, liveRuns: ReadonlySet<string>, sleeping: ReadonlySet<string> = NO_SESSIONS): CenterLayout | undefined =>
  pruneRuns(layout, (ptyId) => liveRuns.has(ptyId), sleeping);

/** One run out of the layout (#641), ⌘W on a split tab or a pane's stream ending: its pane when its tab is split, the tab itself when the run
 * is a tab alone, a sleeping session's too, an emptied group going as closeRef's does; undefined once nothing is left. */
export const closeLeaf = (layout: CenterLayout, ptyId: string): CenterLayout | undefined => pruneRuns(layout, (run) => run !== ptyId);

/** Each run tab with the session its run holds written on it (#696), so the tab still names the session once the run is gone. */
export const withSessions = (layout: CenterLayout, held: Readonly<Record<string, string>>): CenterLayout => mapTabs(layout, (tab) => {
  if (tab.kind !== 'run') return tab;
  const sessionId = held[tab.ptyId];
  return sessionId === undefined || sessionId === tab.sessionId ? tab : { ...tab, sessionId };
});

/** What an activity's tabs keep beyond its live runs (#696): each run's session, written on its tab, and the sessions no run holds, whose tabs
 * outlive their run. */
export interface TabSessions { held: Readonly<Record<string, string>>; sleeping: readonly string[] }

/** Every activity's layout with its sessions written (#696), then pruned against its live runs and its sleeping sessions; an activity missing
 * from `live` is no longer one and loses its entry. The same object back when nothing changed, so a state holding it does not update. */
export function pruneLayouts(
  layouts: Record<string, CenterLayout>, live: Record<string, readonly string[]>, sessions: Readonly<Record<string, TabSessions>> = {},
): Record<string, CenterLayout> {
  const next = Object.fromEntries(Object.entries(layouts).flatMap(([key, layout]) => {
    const runs = live[key];
    const own = sessions[key];
    const kept = runs === undefined ? undefined : prune(withSessions(layout, own?.held ?? {}), new Set(runs), new Set(own?.sleeping ?? []));
    return kept === undefined ? [] : [[key, kept] as const];
  }));
  return JSON.stringify(next) === JSON.stringify(layouts) ? layouts : next;
}

// A stored run tab: with panes (#641), only when parsePanes reads them and the anchor is one of them; its session (#696) only as a string
function parseRun({ ptyId, panes, sessionId }: Record<string, unknown>): RunRef | undefined {
  if (typeof ptyId !== 'string' || ptyId === '') return undefined;
  const session = typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {};
  if (panes === undefined) return { kind: 'run', ptyId, ...session };
  const parsed = parsePanes(panes);
  return parsed !== undefined && leavesOf(parsed.root).includes(ptyId) ? { kind: 'run', ptyId, panes: parsed, ...session } : undefined;
}

// A stored console tab (#755): its channel only as a non-empty string, locked and run only beside one; anything else is the plain console
const parseConsole = ({ channel, locked, run }: Record<string, unknown>): ConsoleRef =>
  (typeof channel === 'string' && channel !== '' ? consoleRef(channel, locked === true, typeof run === 'string' && run !== '' ? run : undefined) : consoleRef());

const DIFF_SCOPE_NAMES: readonly DiffScope[] = ['stage', 'worktree', 'commit', 'checkpoint'];

function parseRef(value: unknown): CenterTabRef | undefined {
  if (!isObject(value)) return undefined;
  if (value.kind === 'run') return parseRun(value);
  if (value.kind === 'diff' && DIFF_SCOPE_NAMES.includes(value.scope as DiffScope)) { // #619: a checkpoint only as a whole positive number
    const checkpoint = value.scope === 'checkpoint' && Number.isInteger(value.checkpoint) && (value.checkpoint as number) >= 1 ? { checkpoint: value.checkpoint as number } : {};
    return { kind: 'diff', scope: value.scope as DiffScope, ...checkpoint };
  }
  if (value.kind === 'file' && typeof value.path === 'string' && isFilePath(value.path)) return { kind: 'file', path: value.path }; // #717
  if (value.kind === 'preview' && typeof value.path === 'string' && isFilePath(value.path)) return { kind: 'preview', path: value.path }; // #697
  if (value.kind === 'design' && typeof value.path === 'string' && isFilePath(value.path)) return { kind: 'design', path: value.path }; // #109
  if (value.kind === 'changes' && typeof value.path === 'string' && isFilePath(value.path)) return { kind: 'changes', path: value.path }; // #668
  if (value.kind === 'console') return parseConsole(value); // #755
  return undefined;
}

// The activity's PR tab (#592) is gone (#758): a stored one leaves its group on read, the rest of the group kept
const isRetired = (value: unknown): boolean => isObject(value) && value.kind === 'pr';

function parseGroup({ id, tabs, active }: Record<string, unknown>): TabGroup | undefined {
  if (typeof id !== 'string' || !Array.isArray(tabs)) return undefined;
  if (typeof active !== 'number' || !Number.isInteger(active) || active < 0 || active >= tabs.length) return undefined;
  const refs = tabs.filter((tab) => !isRetired(tab)).map(parseRef);
  if (refs.length === 0 || !refs.every((ref): ref is CenterTabRef => ref !== undefined)) return undefined;
  // the tab shown stays shown; a retired one shown gives way to the tab before it
  const shown = tabs.slice(0, active + 1).filter((tab) => !isRetired(tab)).length - 1;
  return { kind: 'group', id, tabs: refs, active: Math.max(0, shown) };
}

// What writeCenterLayouts wrote for one task, rebuilt from the known keys only: every run once, as a tab or a pane (#641), every group id
// once and a focused group, else undefined
function parseLayout(value: unknown): CenterLayout | undefined {
  if (!isObject(value)) return undefined;
  const { root: stored, focused } = value;
  const root = parseTree(stored, (node) => (node.kind === 'group' ? parseGroup(node) : undefined));
  if (root === undefined || typeof focused !== 'string') return undefined;
  const groups = groupsOf(root);
  const keys = groups.flatMap((group) => group.tabs.flatMap((tab) => (tab.kind === 'run' ? runsOf(tab) : [refKey(tab)])));
  const ids = groups.map((group) => group.id);
  if (new Set(keys).size !== keys.length || new Set(ids).size !== ids.length || !ids.includes(focused)) return undefined;
  return { root, focused };
}

/** Every task's stored layout; an entry that is not what writeCenterLayouts wrote is dropped alone, a value that is no object reads as none. */
export function readCenterLayouts(): Record<string, CenterLayout> {
  const value = readView('centerLayouts');
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([task, layout]) => {
    const parsed = parseLayout(layout);
    return parsed === undefined ? [] : [[task, parsed] as const];
  }));
}

export const writeCenterLayouts = (layouts: Record<string, CenterLayout>): void => writeView('centerLayouts', layouts);

/** Whether any activity's layout shows `ptyId`, as a tab or as a pane (#672): the sleep notice says its tab stays open. */
export const isTabOpen = (layouts: Record<string, CenterLayout>, ptyId: string): boolean =>
  Object.values(layouts).some((layout) => groupsOf(layout.root).some((group) => group.tabs.some((tab) => runsOf(tab).includes(ptyId))));
