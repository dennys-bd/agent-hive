import { useCallback, useEffect, useState } from 'react';
import type { DiffScope } from '../../types';
import type { Selection } from '@/components/DetailPanel';
import { type Activity, activityKey } from '@/lib/activities';
import { type CenterTabRef, consoleRef } from '@/lib/center-layout';
import type { Dock } from '@/hooks/use-dock';
import type { PanelId, ViewId } from '@/lib/dock-layout';

/** What the center should open once its run is there (#457, #458): a tab of the activity's layout, or with no tab a started task's stage
 * run. A new object on every request, so opening a tab already in the layout shows it again. */
export interface TabRequest { tab?: CenterTabRef }

/** The tab a file opens in (#717, #697, #668): its editor pane, its preview pane or its changes pane. */
export type FileTabKind = 'file' | 'preview' | 'changes';

/** Which view the center shows (#458, #533): Automação the flow, Atividades the picked activity or Home. The dock holds it (#821). */
export type CenterMode = ViewId;

/** What useActivity takes from the dock (#821): the view, which is the center's mode, and how to reach a panel. */
export type ActivityDock = Pick<Dock, 'view' | 'setView' | 'activate' | 'show'>;

/** The selected activity (#457), the center's mode (#458) and the ways to reach them: a row's pick, a worker chip in Automação (#456), a
 * run the user opened, a running task's diff, a task the user started, and the dock's tab clicks. A key is activityKey's: a task's item id,
 * or local/<workspace> for a workspace's local activity (#590). */
export interface ActivitySelection {
  current?: Activity;
  center: CenterMode;
  request?: TabRequest;
  pick(key: string): void; // an Activities row
  open(key: string): void; // a worker chip: the pick, and the Activities tab shown
  openRun(key: string, ptyId: string): void; // a run opened from the UI: open, and that run's tab in the center
  openFile(key: string, path: string, kind?: FileTabKind): void; // one of its files (#717): open, and its editor pane tab in the center, its preview pane tab (#697) or its changes pane tab (#668)
  openDiff(taskId: string, scope: DiffScope): void; // a running task's diff from its menu (#458): open, and the diff's tab in the center
  openConsole(key: string, channel?: string, locked?: boolean, run?: string): void; // the console drawer's abrir como aba (redesign 05), on the drawer's channel; locked: a commands stage's tab (#755)
  openStarted(taskId: string): void; // a start the server took: open, but only once the task's run shows
  activateTab(id: PanelId): void; // DockFrame's tab click: Automação's and Atividades' set the center's mode
}

// hasShown: whether the task has been an activity since it was picked. A run just opened may reach the state a broadcast after its opener
// fired, so a task not listed yet stays requested until it has shown once. isDeferred: a start's request, whose selection and Activities
// tab wait for that moment, since a queued start may spawn long after; any later pick or request replaces it.
interface Picked { key: string; hasShown: boolean; request?: TabRequest; isDeferred?: true }

// Automação gives a pending start's showing up (#458): its task still becomes the pick once its run shows, without taking the center
const quiet = (picked?: Picked): Picked | undefined =>
  (picked?.isDeferred ? { key: picked.key, hasShown: picked.hasShown, request: picked.request } : picked);

/** The selected activity (#457), by key: per viewer and in memory like the dock's active tabs, since no live run survives a boot. Derived on
 * every render; the pick goes once its activity is no longer listed (no live run and no worktree on disk, redesign 03; a local activity is
 * listed while its workspace exists, #590), so a later run on the same task does not bring it back by itself. A task's pick selects the
 * task too, flagged so Detalhes follows it on its own side without being forced open; a local activity has no task to select. The center's mode (#458) is the dock's view
 * (#821), starting on Atividades as the left panel does (#746); only Automação and Atividades change it, never another tab or a closed panel. */
export function useActivity(activities: Activity[], onSelect: (selection: Selection) => void, dock: ActivityDock): ActivitySelection {
  const { view: center, setView: setCenter, activate, show: showPanel } = dock;
  const [picked, setPicked] = useState<Picked>();
  const current = activities.find((activity) => activityKey(activity) === picked?.key);
  const isListed = current !== undefined;
  // One string (#590): the callbacks below stay the same while the workspaces do
  const locals = activities.flatMap((activity) => (activity.kind === 'local' ? [activityKey(activity)] : [])).join('\n');
  const select = useCallback((key: string) => {
    if (!locals.split('\n').includes(key)) onSelect({ taskId: key, fromActivity: true });
  }, [onSelect, locals]);
  // The Atividades tab follows the center without opening a closed side: opening it stays the user's (#612). The deferred start goes through
  // here too
  const show = useCallback((key: string) => {
    select(key);
    showPanel('activities');
    setCenter('activities');
  }, [select, showPanel, setCenter]);
  const hasRun = (current?.runs.length ?? 0) > 0;
  useEffect(() => {
    // A queued start waits for its run, not its listing: a task with a worktree is listed before it spawns (redesign 03)
    if (picked?.isDeferred && !hasRun) return;
    if (picked === undefined || picked.hasShown === isListed) return;
    if (!isListed) {
      setPicked(undefined);
      return;
    }
    setPicked({ key: picked.key, hasShown: true, request: picked.request });
    if (picked.isDeferred) show(picked.key);
  }, [picked, isListed, hasRun, show]);
  const pick = useCallback((key: string) => {
    setPicked({ key, hasShown: false });
    select(key);
    setCenter('activities');
  }, [select, setCenter]);
  // A user's open: the activity picked with the tab to show, the Activities tab shown on its side without opening it (#612), the center following
  const openWith = useCallback((key: string, request?: TabRequest) => {
    setPicked({ key, hasShown: false, request });
    show(key);
  }, [show]);
  const open = useCallback((key: string) => openWith(key), [openWith]);
  const openRun = useCallback((key: string, ptyId: string) => openWith(key, { tab: { kind: 'run', ptyId } }), [openWith]);
  const openDiff = useCallback((taskId: string, scope: DiffScope) => openWith(taskId, { tab: { kind: 'diff', scope } }), [openWith]);
  const openFile = useCallback((key: string, path: string, kind: FileTabKind = 'file') => openWith(key, { tab: { kind, path } }), [openWith]);
  const openConsole = useCallback((key: string, channel?: string, locked?: boolean, run?: string) => openWith(key, { tab: consoleRef(channel, locked, run) }), [openWith]);
  const openStarted = useCallback((taskId: string) => setPicked({ key: taskId, hasShown: false, request: {}, isDeferred: true }), []);
  // Automação and Atividades switch the view (#533, #821): the panel becomes its side's tab without opening it, so the view's own state decides
  // whether the left side shows. Any other tab is clicked on an open side: it activates (#452)
  const activateTab = useCallback((panel: PanelId) => {
    if (panel === 'automation') setPicked(quiet);
    if (panel !== 'automation' && panel !== 'activities') {
      activate(panel);
      return;
    }
    setCenter(panel);
    showPanel(panel);
  }, [activate, showPanel, setCenter]);
  return { current, center, request: picked?.request, pick, open, openRun, openDiff, openFile, openConsole, openStarted, activateTab };
}
