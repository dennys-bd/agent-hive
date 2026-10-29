import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import { stageChannel } from '../../console';
import { applyLanding, type Landing } from '@/components/center-drag';
import type { TabRequest } from '@/hooks/use-activity';
import { renameTabs, storableLayouts } from '@/lib/center-files';
import * as models from '@/lib/editor-models';
import { type Activity, activityKey, runSessions, sleepingSessions } from '@/lib/activities';
import {
  type CenterLayout, type CenterTabRef, changePanes, closeLeaf, closeRef, foldIntoPane, initialLayout, openRef, prune, pruneLayouts, readCenterLayouts, replaceRun, resize,
  retargetRef, selectRef, type TabSessions, withStageConsole, writeCenterLayouts,
} from '@/lib/center-layout';
import { focusPane, resizePanes } from '@/lib/pane-split';
import type { Axis } from '@/lib/split-tree';

/** What the center does to the picked activity's layout (#458). */
export interface CenterOps {
  select(group: string, index: number): void; // a tab's click, or a click in its group (its shown tab): the group takes the focus too
  close(key: string): void; // its X: the run itself keeps going (#452)
  land(key: string, landing: Landing): void; // a drop, or the tab menu's split and move
  resize(path: readonly number[], sizes: number[]): void; // a divider between two groups
  open(ref: CenterTabRef): void; // a tab the center opens itself (#818): the +'s untitled file
  retarget(key: string, ref: CenterTabRef): void; // the diff pane's scope picker (#591)
  splitPane(anchorKey: string, newKey: string, axis: Axis): void; // ⌘D / ⌘⇧D (#641): the answered run's tab folded into the anchor tab's focused pane
  focusPane(tabKey: string, ptyId: string): void; // a pointer down in a split tab's pane (#641)
  resizePane(tabKey: string, path: readonly number[], sizes: number[]): void; // a divider between two panes of a split tab (#641)
  closePane(ptyId: string): void; // ⌘W on a split tab, a run's stream ending, the search's fechar tab: one run out, its tab with the last (#641)
  holdRun(ptyId: string): void; // a sleeping tab's continue (#672): its tab stays while the session moves to a new run
  replaceRun(from: string, to: string): void; // #672: the new run takes over the sleeping run's tab, in place
  releaseRun(ptyId: string): void; // #672: a refused continue: the sleeping tab's hold ends, or it would outlive its record
}
// layouts (#533): every activity's stored layout, read-only, for the design layer, which keeps a pane per open design tab of any activity
export interface CenterLayouts extends CenterOps { layout?: CenterLayout; layouts: Readonly<Record<string, CenterLayout>> }

// layouts: every activity's, as stored, by activityKey (#590). emptied: the picked task whose last tab just closed, showing the empty line until the pick changes; its
// entry is absent, so a later pick opens its main run again. holding (#672): the runs a continue is moving a sleeping tab to and from. The
// broadcast that drops the sleeping run can come before the route's answer, so its tab stays until replaceRun, and the new run's until it is live
interface Store { layouts: Record<string, CenterLayout>; emptied?: string; holding: readonly string[] }

/** The run a first pick shows (#458): the task's stage run (the non-free session's), else its first live run, else its first sleeping one (#672). */
export function mainRef(activity: Activity): CenterTabRef | undefined {
  const run = activity.runs.find((r) => r.kind === 'stage') ?? activity.runs.find((r) => r.terminalId === undefined) ?? activity.slept?.[0]?.run; // a captured run has no pty of its own (#696)
  return run === undefined ? undefined : { kind: 'run', ptyId: run.ptyId };
}

// Every run an activity's tabs may show: its live runs and its sleeping ones (#672)
const tabRuns = (activity: Activity): string[] => [...activity.runs, ...(activity.slept ?? []).map((s) => s.run)].map((run) => run.ptyId);

// What the picked activity shows: its stored layout without the runs that ended, else its main run alone; nothing once emptied
function viewOf(store: Store, activity: Activity): CenterLayout | undefined {
  const id = activityKey(activity);
  if (store.emptied === id) return undefined;
  const entry = store.layouts[id];
  const kept = entry === undefined ? undefined : prune(entry, new Set([...tabRuns(activity), ...store.holding]), new Set(sleepingSessions(activity))); // #696: a sleeping session's tab stays
  const main = mainRef(activity);
  return kept ?? (main === undefined ? undefined : initialLayout(main));
}

// A request's tab once it can open (#457): anything but a run at once (a diff, a PR, the console, a file, #717); a run once it is live, a
// start's (no tab) being the task's stage run
function readyRef(activity: Activity, { tab }: TabRequest): CenterTabRef | undefined {
  if (tab !== undefined && tab.kind !== 'run') return tab;
  const run = activity.runs.find((r) => (tab === undefined ? r.kind === 'stage' : r.ptyId === tab.ptyId));
  return run === undefined ? undefined : { kind: 'run', ptyId: run.ptyId };
}

const withEntry = (layouts: Record<string, CenterLayout>, id: string, layout: CenterLayout | undefined): Record<string, CenterLayout> => {
  const rest = Object.fromEntries(Object.entries(layouts).filter(([task]) => task !== id));
  return layout === undefined ? rest : { ...rest, [id]: layout };
};

interface RunIds extends TabSessions { runs: string[]; slept: string[] }

// Each activity's live and sleeping runs and their sessions (#696) as one string: the pruning effect's trigger, unchanged while no run starts,
// sleeps or ends
const liveKey = (activities: Activity[]): string => JSON.stringify(Object.fromEntries(activities.map((activity): [string, RunIds] => [
  activityKey(activity),
  { runs: activity.runs.map((r) => r.ptyId), slept: (activity.slept ?? []).map((s) => s.run.ptyId), held: runSessions(activity), sleeping: sleepingSessions(activity) },
])));

// The store after a broadcast: each layout writes its runs' sessions and keeps its activity's live and sleeping runs, the held ones (#672) and
// the tabs of its sleeping sessions (#696); a hold ends once its run is live
function prunedStore(s: Store, ids: Record<string, RunIds>): Store {
  const running = new Set(Object.values(ids).flatMap((a) => a.runs));
  const holding = s.holding.filter((held) => !running.has(held));
  const shown = Object.fromEntries(Object.entries(ids).map(([key, a]) => [key, [...a.runs, ...a.slept, ...s.holding]]));
  const sessions = Object.fromEntries(Object.entries(ids).map(([key, a]) => [key, { held: a.held, sleeping: a.sleeping }]));
  const layouts = pruneLayouts(s.layouts, shown, sessions);
  return layouts === s.layouts && holding.length === s.holding.length ? s : { ...s, layouts, holding };
}

// A continue's answer (#672): every stored layout, not the picked one's view, since the view may no longer be this activity's by then; the
// new run is held until it is live
const handedOver = (s: Store, from: string, to: string): Store => ({
  ...s, holding: [...s.holding.filter((held) => held !== from), to],
  layouts: Object.fromEntries(Object.entries(s.layouts).map(([key, layout]) => [key, replaceRun(layout, from, to)])),
});

/** A commands stage in flight (#755): its activity's key, the stage execution's id (its first command's pty, the same from one command to
 * the next) and its console channel. */
interface StageRunTab { key: string; run: string; channel: string }

// Every commands stage in flight as one string: the stage tabs' trigger, unchanged while a run goes from one command to the next
const stageRuns = (activities: Activity[]): string => JSON.stringify(activities.flatMap((activity): StageRunTab[] => {
  const run = activity.kind === 'task' ? activity.activity.commands : undefined;
  return activity.kind === 'task' && run !== undefined
    ? [{ key: activityKey(activity), run: run.runId, channel: stageChannel(run.stage).id }]
    : [];
}));

// A commands stage that starts (#755) adds its locked console tab to its activity's layout once, picked or not; a run already seen is left
// alone, so a tab closed during it stays closed. Per viewer and in memory: a reload during the run may add it again. A tab added to the
// picked activity whose last tab had closed drops its emptied mark, or it would never show
function useStageTabs(activities: Activity[], setStore: Dispatch<SetStateAction<Store>>): void {
  const seen = useRef<readonly string[]>([]);
  const runs = stageRuns(activities);
  useEffect(() => {
    const live = JSON.parse(runs) as StageRunTab[];
    const fresh = live.filter((tab) => !seen.current.includes(tab.run));
    seen.current = live.map((tab) => tab.run); // a run that ended leaves the list, so the stage's next run opens its tab again
    if (fresh.length === 0) return;
    setStore((s) => ({
      ...s,
      layouts: fresh.reduce((all, tab) => withEntry(all, tab.key, withStageConsole(all[tab.key], tab.channel, tab.run)), s.layouts),
      ...(fresh.some((tab) => tab.key === s.emptied) ? { emptied: undefined } : {}),
    }));
  }, [runs, setStore]);
}

// A file the tree renamed or moved (#818): the tabs of its activity's stored layout follow it. The activity is found by id at the time, in the
// latest list, since the listener is subscribed once
function useRenamedTabs(activities: Activity[], setStore: Dispatch<SetStateAction<Store>>): void {
  const latest = useRef(activities);
  useEffect(() => {
    latest.current = activities;
  });
  useEffect(() => models.onRenamed((activityId, from, to) => {
    const activity = latest.current.find((a) => a.activity.id === activityId);
    if (activity === undefined) return;
    const key = activityKey(activity);
    setStore((s) => {
      const layout = s.layouts[key];
      return layout === undefined ? s : { ...s, layouts: { ...s.layouts, [key]: renameTabs(layout, from, to) } };
    });
  }), [setStore]);
}

/** Every activity's center layout (#458), kept in the view state (#484) and written back on every change. The layouts follow the live runs: an
 * ended run's tab goes, and a task no longer an activity loses its entry. For the picked activity it gives the layout and the operations
 * on it, and it applies a request (#457) once its tab can open, into the focused group. */
export function useCenterLayouts(activities: Activity[], current: Activity | undefined, request: TabRequest | undefined): CenterLayouts {
  const [store, setStore] = useState<Store>(() => ({ layouts: readCenterLayouts(), holding: [] }));
  const [handled, setHandled] = useState<TabRequest>();
  const id = current && activityKey(current);
  const live = liveKey(activities);
  useEffect(() => writeCenterLayouts(storableLayouts(store.layouts)), [store.layouts]);
  useEffect(() => setStore((s) => prunedStore(s, JSON.parse(live) as Record<string, RunIds>)), [live]);
  useEffect(() => setStore((s) => (s.emptied === undefined || s.emptied === id ? s : { layouts: s.layouts, holding: s.holding })), [id]);
  useStageTabs(activities, setStore); // #755: a commands stage's locked console tab
  useRenamedTabs(activities, setStore); // #818: tabs follow a rename or a move
  const change = (next: (layout: CenterLayout | undefined) => CenterLayout | undefined): void => {
    if (current === undefined) return;
    const key = activityKey(current);
    setStore((s) => {
      const layout = next(viewOf(s, current));
      return { holding: s.holding, layouts: withEntry(s.layouts, key, layout), emptied: layout === undefined ? key : undefined };
    });
  };
  // No dependency list: `change` is new on every render, and `handled` keeps a request from applying twice
  useEffect(() => {
    if (current === undefined || request === undefined || request === handled) return;
    const ref = readyRef(current, request);
    if (ref === undefined) return; // its run is not live yet: the request waits for a later broadcast
    setHandled(request);
    change((layout) => (layout === undefined ? initialLayout(ref) : openRef(layout, ref)));
  });
  return {
    layout: current === undefined ? undefined : viewOf(store, current),
    layouts: store.layouts,
    select: (group, index) => change((layout) => layout && selectRef(layout, group, index)),
    close: (key) => change((layout) => layout && closeRef(layout, key)),
    land: (key, landing) => change((layout) => layout && applyLanding(layout, key, landing)),
    resize: (path, sizes) => change((layout) => layout && resize(layout, path, sizes)),
    open: (ref) => change((layout) => (layout === undefined ? initialLayout(ref) : openRef(layout, ref))),
    retarget: (key, ref) => change((layout) => layout && retargetRef(layout, key, ref)),
    splitPane: (anchorKey, newKey, axis) => change((layout) => layout && foldIntoPane(layout, anchorKey, newKey, axis)),
    focusPane: (tabKey, ptyId) => change((layout) => layout && changePanes(layout, tabKey, (panes) => focusPane(panes, ptyId))),
    resizePane: (tabKey, path, sizes) => change((layout) => layout && changePanes(layout, tabKey, (panes) => resizePanes(panes, path, sizes))),
    closePane: (ptyId) => change((layout) => layout && closeLeaf(layout, ptyId)),
    holdRun: (ptyId) => setStore((s) => ({ ...s, holding: [...s.holding, ptyId] })),
    releaseRun: (ptyId) => setStore((s) => ({ ...s, holding: s.holding.filter((held) => held !== ptyId) })),
    replaceRun: (from, to) => setStore((s) => handedOver(s, from, to)),
  };
}
