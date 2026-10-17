import { createContext, type ReactNode, useCallback, useContext, useEffect, useEffectEvent, useState } from 'react';
import type { Task, EffectiveLimits, SidebarsPerView, Terminal, Worker, Stage, State } from '../../types';
import { ActivitiesPanel, type ActivitiesNav, PlusMenu } from '@/components/ActivitiesPanel';
import { ActivityCenter } from '@/components/ActivityCenter';
import { useConfirmLoss } from '@/components/AgentLossConfirm';
import { closePaneOf } from '@/components/CenterGroup';
import { useCloseTab } from '@/components/close-tab-notice';
import { ConsoleDrawer } from '@/components/ConsoleDrawer';
import type { DetailNav, Selection } from '@/components/DetailPanel';
import { DockFrame } from '@/components/DockFrame';
import { ActivitySide, type SideTab } from '@/components/FilesPanel';
import type { DockPanel } from '@/components/DockGroup';
import type { PaneContext } from '@/components/PaneHeader';
import { Home } from '@/components/Home';
import { LocalMenu } from '@/components/LocalMenu';
import { type SearchHost, useQuickActions } from '@/components/quick-actions';
import { useSleptNotices } from '@/components/sleep-notice';
import { DockBody } from '@/components/ViewRail';
import { Openers } from '@/components/DockOpeners';
import { usePluginsDock } from '@/components/plugins/plugins-dock';
import { dockedTab, type OpenDiff, type OpenFileHow, type OpenPr, type OpenRun } from '@/components/terminal-tabs';
import { type ConsoleChannels, ConsoleChannelsContext, type OpenStageOutput, shownChannel, useConsoleOpener } from '@/hooks/use-console';
import { type ActivitySelection, useActivity } from '@/hooks/use-activity';
import type { BackEntry } from '@/hooks/use-back-stack';
import { type CenterLayouts, useCenterLayouts } from '@/hooks/use-center-layouts';
import { useFileOpener } from '@/hooks/use-file-opener';
import { useDock } from '@/hooks/use-dock';
import { type HeaderShell, useHeaderShell } from '@/hooks/use-header-shell';
import { useWindowKeys } from '@/hooks/use-window-keys';
import { t } from '@/i18n';
import { type Activity, activitiesOf, activityKey, isTask, localKey, sleepingOf } from '@/lib/activities';
import { shownFile, shownRun } from '@/lib/center-layout';
import type { FileAt } from '@/lib/editor-models';
import { pendingSessions } from '@/lib/home';
import { useRememberFocus } from '@/lib/session-focus';
import { onPanelKey, onShortcutKey, onViewKey, type PanelId, runShortcut, shownBySide } from '@/lib/dock-layout';

/** What MainDock hands the detail's body (#452): whether Detalhes is the shown tab of an open panel, how to close the panel holding it,
 * and where it sits (redesign 06). */
export interface DetailView { isShown: boolean; onClose(): void; nav: DetailNav }

export interface MainDockProps {
  fileLinks: boolean; fontFamily: string; workspaces: string[]; tasks: Task[]; workers: Worker[];
  terminals: Terminal[]; // every live terminal (#283, #292): a task's plain terminal makes it an activity (#457)
  showTask?(taskId: string): void; // #229: ver no fluxo lands on the task's source flow, not just the tab; absent: the selection alone
  selected?: Selection; onSelect(selection: Selection): void; // the app's task selection: a picked activity selects its task for Detalhes (#457)
  detail(view: DetailView): ReactNode; children: ReactNode;
  consoleChannels?: ConsoleChannels; // the daemon's console channels (#353), read by the Dashboard; absent (the terminal's harness): no console
  // the chip that opens its drawer lives in the Dashboard's footer (redesign 05)
  // The Automação tab's body (#456), from the Dashboard, handed what its worker chips call (#457); absent (the terminal's harness): no such tab
  automation?(openActivity: (taskId: string) => void): ReactNode;
  // The window's footer (#225), from the Dashboard, handed the shown activity's store id and the focused file tab's path (#295); inside the
  // openers, so a failed checker opens its console channel. Absent (the terminal's harness): no footer
  footer?(shownActivityId: string | undefined, shownFile: string | undefined): ReactNode;
  header?(shell: HeaderShell): ReactNode; // the window's header (#533, #221), from the Dashboard, handed what its three columns show; absent (the terminal's harness): no header
  liveActivities?: State['activities']; // #629: state.activities, what the workers point at; absent (the terminal's harness): none
  slept?: State['slept']; // #672: the runs that sleep, kept as tabs; absent (the terminal's harness): none
  activityRecords?: State['activityRecords']; // #629: the records, each workspace's local sessions (#587) in its local activity's (#590); absent (the terminal's harness): none
  sourceWorkspaces?: Record<string, string>; // what the home's rows resolve a task's workspace colour with (redesign 08)
  stages?: Stage[]; // the flow's stages (#586): what the Activities tab groups by; absent (the terminal's harness): none, each activity under its own stage
  pageKey?: string; // #64: the link of the page the center shows under Automação; a new one opens the panel holding Detalhes, as a pick does
  sidebarsPerView?: SidebarsPerView; // #821: what each view keeps of its sidebars, from the config; absent (the terminal's harness): every side shared
  onAddWorkspace?(): void; // the home's and the sidebar's adicionar workspace…: Settings on workspaces
  // An activity's right-click menu (redesign 03), from the Dashboard, which holds the State; absent (the terminal's harness): no menu
  activityMenu?(task: Task, showFlow: () => void, row: ReactNode): ReactNode;
  // The activity's bar over the center (#536), from the Dashboard, which holds the State, handed the focused group's shown run; absent (the
  // terminal's harness): no bar
  activityBar?(activity: Activity, focusedRun: string | undefined, showFlow: () => void): ReactNode;
  // What the pane headers read beyond the activity (#536): the stage's model and the worktree's folder; absent (the terminal's harness): none
  paneContext?(activity: Activity): PaneContext; // #590: a local activity's too
  // The Start dialog in its Nova atividade mode (redesign 11), from the Dashboard; absent (the terminal's harness): nova atividade shows the flow
  newActivity?(dialog: NewActivity): ReactNode;
  // The copy host around the dock (#587), from the Dashboard, handed the activity the center shows; absent (the terminal's harness): no copiar para…
  copySession?(shown: string | undefined, children: ReactNode): ReactNode;
  // What the search reads (#584), from the Dashboard, which holds the State; absent (the terminal's harness): no search
  search?: SearchSource;
  // Every way into a PR (#758), from the Dashboard: its page under its repository; absent (the terminal's harness): a PR link opens GitHub.
  // from (#911): a page opened from the Atividades view, the entry that shows that view again
  openPr?(url: string, from?: BackEntry): void;
  // The task details' issue (#895), from the Dashboard: its page under its repository; absent (the terminal's harness): the issue's URL
  openIssue?(url: string, from?: BackEntry): void;
}

/** What the search reads beyond the dock (#584). */
export interface SearchSource { state: State; effective?: EffectiveLimits; openSettings?(): void; openShortcuts?(): void }

/** What the dock hands the Start dialog: the workspace whose + opened it, the task a search row picked or the title + criar tarefa typed
 * (#584), and how it ends. */
export interface NewActivity { workspace?: string; taskId?: string; title?: string; onStarted(taskId: string): void; onClose(): void }
type StartRequest = Pick<NewActivity, 'workspace' | 'taskId' | 'title'>;

// A detached window docked back (#252): a task's run goes to its activity, a workspace's to its local activity (#590). main's message is IPC,
// so its shape is checked. onDock hands back no unsubscribe: one subscription per opener, as before.
function useDockedRuns(open: OpenRun): void {
  useEffect(() => {
    window.hive?.onDock((value) => {
      const tab = dockedTab(value);
      if (tab) open(tab);
    });
  }, [open]);
}

const NO_STAGES: Stage[] = [];
const NO_RECORDS: State['activityRecords'] = [];
const NO_ACTIVITIES: State['activities'] = [];

interface ActivitiesArgs { activities: Activity[]; selection: ActivitySelection; layouts: CenterLayouts; workspaces: string[]; sourceWorkspaces?: Record<string, string>; stages: Stage[]; workers: Worker[]; nav: ActivitiesNav; isShown: boolean }

// The Activities tab (#457, redesign 03): the workspaces and their activities; a row's click makes it the window's center, a session's opens
// that run in it (#492). While the center is Atividades', the session its focused group shows is marked; under Automação none is.
function activitiesPanel({ activities, selection, layouts, nav, ...rest }: ActivitiesArgs): DockPanel {
  const { current, center, openRun } = selection;
  const shown = center === 'activities' ? shownRun(layouts.layout) : undefined;
  const body = (
    <section aria-label={t('dock.activities')} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between px-3 text-muted-foreground text-xs">
        {t('header.activities')}
        <PlusMenu nav={nav} label={t('activities.new')} />
      </div>
      <ActivitiesPanel activities={activities} selected={current && activityKey(current)} shown={shown} onSelect={selection.pick} onOpenRun={openRun} nav={nav} {...rest} />
    </section>
  );
  // its own 36px header (redesign 03): the window header's view switcher moves between it and the flow sidebar (#533, #699)
  return { id: 'activities', title: t('dock.activities'), ownHeader: true, body };
}

// The store's id of the activity the center shows (#225): under atividades with one picked; undefined under fluxo and on the home
const shownIdOf = (selection: ActivitySelection): string | undefined => (selection.center === 'activities' ? selection.current?.activity.id : undefined);

interface CenterArgs {
  selection: ActivitySelection; layouts: CenterLayouts; fileLinks: boolean; fontFamily: string; flow: ReactNode; home: ReactNode; console?: ConsoleChannels; pane?: PaneContext;
  openProblem?(activityId: string, path: string, at: FileAt): void; // #225: a problem of the drawer's list, opened in its activity
  plugins?: ReactNode; // #313: the plugins view's centre, null under the other views
}

// Whether the flow is what the center shows (#596): the flow and its sidebar stay mounted under Atividades, so what they must not do while
// hidden (the search key, the source keys #585) reads this. Outside a dock (a flow rendered alone) it is shown.
export const FlowShownContext = createContext(true);

/** Whether the flow is the center's shown view (#596), false while it is mounted but hidden under Atividades. */
export const useIsFlowShown = (): boolean => useContext(FlowShownContext);

// What the center shows (#458): the flow always, hidden and inert under Atividades so it keeps its stages' pages, scroll and search
// (#596); beside it, under Atividades, the picked activity's layout or Home with none picked. Keyed by task, so another activity starts
// with fresh drag state and its own terminals. The wrapper swaps `hidden` for `flex` because Tailwind's display class beats [hidden].
function centerView({ selection, layouts, fileLinks, fontFamily, flow, home, pane, plugins }: CenterArgs): ReactNode {
  const { current } = selection;
  const isFlow = selection.center === 'automation';
  const flowView = (
    <div hidden={!isFlow} inert={!isFlow} className={isFlow ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>
      <FlowShownContext.Provider value={isFlow}>{flow}</FlowShownContext.Provider>
    </div>
  );
  // one fragment in every view: the flow keeps its place in the tree, so switching does not remount it
  const activityView = selection.center !== 'activities' ? null : current === undefined
    ? home
    : <ActivityCenter key={activityKey(current)} activity={current} layout={layouts.layout} ops={layouts} fileLinks={fileLinks} fontFamily={fontFamily} pane={pane} onOpenRun={(ptyId) => selection.openRun(activityKey(current), ptyId)} />;
  return <>{flowView}{activityView}{plugins}</>;
}

// The center with the console's drawer over it (redesign 05), positioned on DockFrame's center column. abrir como aba needs an activity's
// grid to land in, so only atividades with an activity picked offers it.
function CenterWithConsole(args: CenterArgs) {
  const { selection, console: channels, fontFamily } = args;
  const { current } = selection;
  // #755: the tab takes the channel the drawer shows; from then on the two pick apart
  const shown = channels && shownChannel(channels.channels, channels.selection)?.id;
  const onOpenTab = selection.center === 'activities' && current !== undefined ? () => selection.openConsole(activityKey(current), shown) : undefined;
  return (
    <>
      {centerView(args)}
      {channels && <ConsoleDrawer console={channels} fontFamily={fontFamily} onOpenTab={onOpenTab} activityId={shownIdOf(selection)} onOpenProblem={args.openProblem} />}
    </>
  );
}

interface DetailArgs {
  current?: Activity; isShown: boolean; sideTab: SideTab; detail: MainDockProps['detail']; onClose(): void; nav: DetailNav;
}

// Detalhes as a dock panel (#341, #452), drawing no group header (#295): the window header's right column names it and closes it. Under Atividades
// with an activity open it is the activity sidebar (redesign 07): arquivos or detalhes as the header's icons pick (#221), arquivos alone on a local one (#633).
function detailPanel({ current, isShown, sideTab, detail, onClose, nav }: DetailArgs): DockPanel {
  const title = t('dock.detail');
  if (current === undefined) return { id: 'detail', title, ownHeader: true, body: detail({ isShown, onClose, nav }) };
  const details = isTask(current) ? detail({ isShown: isShown && sideTab === 'details', onClose, nav }) : undefined; // a local activity has no task to detail
  const body = <ActivitySide key={activityKey(current)} target={current} tab={sideTab} isShown={isShown} details={details} />;
  return { id: 'detail', title, ownHeader: true, body };
}

// fechar tab (#452) from the search: a run of the shown activity closes as ⌘W closes it, its pane alone on a split tab (#641), a terminal by
// its own setting and after the agent confirm (#696); anything else only leaves the layout
function useSearchClose(current: Activity | undefined, layouts: CenterLayouts, openRun: OpenRun): { close(ptyId: string): void; dialog: ReactNode } {
  const settings = useCloseTab();
  const loss = useConfirmLoss(current);
  const close = (ptyId: string): void => {
    const isShown = current !== undefined && (current.runs.some((r) => r.ptyId === ptyId) || sleepingOf(current, ptyId) !== undefined);
    if (current !== undefined && isShown) closePaneOf(ptyId, current, layouts, settings, loss.confirm, openRun);
    else layouts.closePane(ptyId);
  };
  return { close, dialog: loss.dialog };
}

// What a page opened from the Atividades view goes back to (#911): that view, on the activity it showed, which stays picked in useActivity.
// Named by the task's number, a local activity by its workspace, Home by the view's own name. Under Automação none: the Dashboard pushes the
// pick it leaves
function activityEntry(selection: ActivitySelection): BackEntry | undefined {
  if (selection.center !== 'activities') return undefined;
  const { current } = selection;
  const label = current === undefined
    ? t('header.activities')
    : isTask(current) ? t('back.activity', { n: current.task.item.id }) : t('back.activityTitled', { title: current.workspace });
  return { label, restore: () => selection.activateTab('activities') };
}

// The activity sidebar's tab (redesign 07). A task picked outside the activities (the flow, a chip) opens the side holding Detalhes, and asks for
// its details unless the tab is kept (#821). keepTab is read at the pick, not a dependency: a save that flips it must not replay the last pick and
// reopen that side. The toggleSideTab key (#585) opens the side, then switches files and details. Bound only while the center shows a task's
// activity, the one sidebar with the two tabs.
function useSideTab(selected: Selection | undefined, pageKey: string | undefined, activate: (id: PanelId) => void, hasSideTabs: boolean, keepTab: boolean): [SideTab, (tab: SideTab) => void] {
  const [sideTab, setSideTab] = useState<SideTab>('files');
  const followPick = useEffectEvent(() => {
    activate('detail');
    if (!keepTab) setSideTab('details');
  });
  useEffect(() => {
    if (!selected || selected.fromActivity) return;
    followPick();
  }, [selected]);
  useEffect(() => {
    if (pageKey !== undefined) followPick(); // #64: a page shows its task's details at once; closed on it, the panel stays closed until another
  }, [pageKey]);
  useEffect(() => (hasSideTabs ? onShortcutKey([[true, 'toggleSideTab']], () => {
    activate('detail');
    setSideTab((tab) => (tab === 'files' ? 'details' : 'files'));
  }) : undefined), [hasSideTabs, activate]);
  return [sideTab, setSideTab];
}

// Every side shared, as before #821: what the terminal's harness and a dock with no setting get
const SHARED_SIDEBARS: SidebarsPerView = { left: false, right: false, rightTab: false };

/** The main window's dock frame (#342): the Automação tab (#456) and the Activities tab (#457) on the left, the task detail (#341) on the
 * right, the activity sidebar with the files under Atividades (redesign 07); the console (#353) is a drawer over the center (redesign 05) and
 * a run's terminal a tab of its activity's center. Each side is a panel that opens and closes (#452). The center follows the left panel's
 * tab (#458): the flow under Automação, the picked activity's layout or Home under Atividades. */
export function MainDock(props: MainDockProps) {
  const { selected, onSelect, showTask, detail, consoleChannels, automation, header, footer, fontFamily, fileLinks, tasks, workers, terminals, children, pageKey } = props;
  const { workspaces, sourceWorkspaces, liveActivities = NO_ACTIVITIES, slept, activityRecords, stages, onAddWorkspace, activityMenu, newActivity, activityBar, paneContext, copySession, search, sidebarsPerView = SHARED_SIDEBARS, openPr: openPrPage, openIssue: openIssuePage } = props;
  const [newIn, setNewIn] = useState<StartRequest>(); // the Start dialog is open: from this workspace's +, on this task or with this title when set
  const dock = useDock(sidebarsPerView);
  const { layout, activate, close, toggle } = dock;
  const openConsole = useConsoleOpener(consoleChannels);
  const activities = activitiesOf({ tasks, workers, terminals, workspaces: workspaces, activities: liveActivities, activityRecords: activityRecords ?? NO_RECORDS, slept, stages: stages ?? NO_STAGES });
  const selection = useActivity(activities, onSelect, dock);
  const { current, request, open, openRun, openStarted, openDiff, openFile, activateTab, openConsole: openConsoleTab } = selection;
  // ver saída (#755): the task's activity picked with its commands stage's locked console tab, as abrir como aba opens a tab
  const openStageOutput: OpenStageOutput = useCallback((taskId, channel, run) => openConsoleTab(taskId, channel, true, run), [openConsoleTab]);
  const layouts = useCenterLayouts(activities, current, request); // the picked activity's tabs and splits (#458)
  useRememberFocus(current, shownRun(layouts.layout)); // #113: the design pane's recipient, the last session in focus
  const openActivityFile = useFileOpener(activities, openFile); // a click on a file: its editor pane tab (#717)
  // A run the user opened (#457): a task's becomes its activity, a workspace's its local activity (#590), the center showing it
  const openUserRun: OpenRun = useCallback((tab) => {
    const key = tab.task ?? (tab.project === undefined ? undefined : localKey(tab.project));
    if (key !== undefined) openRun(key, tab.ptyId);
  }, [openRun]);
  useDockedRuns(openUserRun);
  useSleptNotices(activities, openUserRun); // the auto flow's and the idle shutdown's sleeps show their notice here (#672)
  // A task's diff (#270): a tab of its activity's center (#458); the task's menu offers none while it is no activity
  const openTaskDiff: OpenDiff = (task, scope, checkpoint) => openDiff(task.item.itemId, scope, checkpoint);
  // Every way into a PR (#758) and the task details' issue (#895): the flow under Automação, showing the page under its repository
  const toAutomation = (open?: (url: string, from?: BackEntry) => void): OpenPr | undefined => open && ((url) => {
    const from = activityEntry(selection); // read before the switch: the view the page is opened from
    activateTab('automation');
    open(url, from);
  });
  const openPr = toAutomation(openPrPage);
  const openIssue = toAutomation(openIssuePage);
  // Every new selection opens the panel holding Detalhes with it as the shown tab, the same task picked again included: App sets a new
  // object on each pick. An activity's pick does not (#457): Detalhes shows it only when its panel is already open. The sidebar switches to
  // detalhes with it (useSideTab)
  const keepTab = sidebarsPerView.right && sidebarsPerView.rightTab; // #821: rightTab counts only while the right side is kept per view
  const [sideTab, setSideTab] = useSideTab(selected, pageKey, activate, selection.center === 'activities' && current?.kind === 'task', keepTab);
  useEffect(() => onPanelKey(toggle), [toggle]); // Cmd+B, Cmd+Shift+B (#452)
  const hasHeader = header !== undefined;
  useEffect(() => (hasHeader ? onViewKey(activateTab) : undefined), [hasHeader, activateTab]); // Cmd+1, Cmd+2 (#533)
  useWindowKeys(hasHeader, search?.effective); // close window (#585)
  const detailSide = layout.docks.detail;
  const closeDetail = useCallback(() => close(detailSide), [close, detailSide]); // Escape on the shown Detalhes (#452); the X is the frame's close
  const openStart = (start: StartRequest = {}): void => (newActivity === undefined ? activateTab('automation') : setNewIn(start));
  const openNewActivity = (workspace?: string): void => openStart({ workspace });
  const showFlow = (taskId: string): void => { activateTab('automation'); if (showTask) showTask(taskId); else onSelect({ taskId }); };
  const searchClose = useSearchClose(current, layouts, openUserRun);
  // Markdown: Open Preview (#697) and Git: Open Changes (#668): the focused editor names its activity by id; the tab opens in the focused group,
  // as any file does
  // An activity's file by its store id (#697, #668, #225): Open Preview and Open Changes name the focused editor's, a problem names its own
  const openFileOf = (activityId: string, path: string, at?: FileAt, how?: OpenFileHow): void => {
    const target = activities.find((activity) => activity.activity.id === activityId);
    if (target !== undefined) openActivityFile(activityKey(target), path, at, how);
  };
  const openFileAs = (how: OpenFileHow) => (activityId: string, path: string): void => openFileOf(activityId, path, undefined, how);
  const searchHost: SearchHost | undefined = search && {
    state: search.state, effective: search.effective, openShortcuts: search.openShortcuts, activities, shown: selection.center === 'activities' ? current : undefined,
    shownRun: selection.center === 'activities' ? shownRun(layouts.layout) : undefined, // the split-terminal keys' run (#641)
    nav: {
      openActivity: open, showFlow, startTask: ({ itemId, title }) => openStart({ taskId: itemId, title }), openSettings: search.openSettings,
      openRun: openUserRun, openDiff: openTaskDiff, openPr, openConsole, openStarted, closeTab: searchClose.close,
      openPreview: openFileAs({ preview: true }), openChanges: openFileAs({ changes: true }),
    },
  };
  const quick = useQuickActions({ workspaces, current, openRun: openUserRun, newActivity: openNewActivity, hasKeys: hasHeader, search: searchHost });
  // The home has no worktree to show files or details of (redesign 08): its right side is hidden, not closed, so the saved layout keeps it
  // A local activity shows its checkout there (#633)
  const isHome = selection.center === 'activities' && current === undefined;
  const frameLayout = isHome ? { ...layout, open: { ...layout.open, right: false } } : layout;
  const shown = shownBySide(frameLayout, dock.active);
  const isLive = (taskId: string): boolean => activities.some((activity) => activity.kind === 'task' && activity.task.item.itemId === taskId);
  // The home's recents resume a stopped task's last session: an activity with only its worktree left has nothing to show yet
  const isRunning = (taskId: string): boolean => activities.some((activity) => activity.kind === 'task' && activity.task.item.itemId === taskId && activity.runs.length > 0);
  const home = (
    <Home
      tasks={tasks} stages={stages} workers={workers} liveActivities={liveActivities} activityRecords={activityRecords ?? NO_RECORDS} workspaces={workspaces} sourceWorkspaces={sourceWorkspaces}
      nav={{ openActivity: open, isLive: isRunning, newActivity: () => openNewActivity(), localTerminal: quick.localTerminal, addWorkspace: onAddWorkspace }}
    />
  );
  const nav: DetailNav = {
    center: selection.center,
    canOpenActivity: isLive,
    openActivity: open,
    showFlow: () => (selected?.taskId === undefined ? activateTab('automation') : showFlow(selected.taskId)),
  };
  const activitiesNav: ActivitiesNav = {
    newActivity: openNewActivity, addWorkspace: onAddWorkspace,
    menu: activityMenu && ((task, row) => activityMenu(task, () => showFlow(task.item.itemId), row)),
    localMenu: (activity, row) => <LocalMenu activity={activity}>{row}</LocalMenu>, // needs no State: its sessions are the activity's (#590)
  };
  // The picked activity's bar (#536), the header's center (#221): parar reads the run the focused group shows; ver no fluxo is a task's (#590)
  const bar = current && activityBar?.(current, shownRun(layouts.layout), () => (current.kind === 'task' ? showFlow(current.task.item.itemId) : activateTab('automation')));
  const pane = current && paneContext?.(current);
  const isFlow = selection.center === 'automation';
  const automationPanel: DockPanel[] = automation === undefined ? [] : [{
    id: 'automation', title: t('dock.automation'), ownHeader: true, body: <FlowShownContext.Provider value={isFlow}>{automation(open)}</FlowShownContext.Provider>,
  }];
  const plugins = usePluginsDock({ isShown: selection.center === 'plugins', workspaces, activate, fontFamily }); // #313: the third view, wired beside MainDock
  const panels: DockPanel[] = [
    // First in the list, as in PANELS: the tab a shared side opens on (#457, #746)
    activitiesPanel({ activities, selection, layouts, workspaces, sourceWorkspaces, stages: stages ?? NO_STAGES, workers, nav: activitiesNav, isShown: shown[layout.docks.activities] === 'activities' }),
    ...automationPanel,
    ...(hasHeader ? [plugins.panel] : []), // #313: reached only through the rail and ⌘3, which only a window with a header has
    selection.center === 'plugins' ? plugins.right : detailPanel({ current: selection.center === 'activities' ? current : undefined, isShown: shown[detailSide] === 'detail', sideTab, detail, onClose: closeDetail, nav }),
  ];
  // #220: the rail's dot reads every workspace, as the window shows them all; the map opens through ⌘/'s own listener (search.openShortcuts is Settings › atalhos)
  const hasWaiting = hasHeader && pendingSessions({ tasks, workers, activityRecords: activityRecords ?? NO_RECORDS }).length > 0;
  const shell = useHeaderShell({ center: selection.center, current, layout: frameLayout, isHome, bar, sideTab, setSideTab, activateTab, close });
  const content = (
    <>
      {header?.(shell)}
      <DockBody rail={hasHeader ? { center: selection.center, onView: activateTab, hasWaiting, onOpenShortcuts: () => runShortcut('shortcutMap'), onOpenSettings: search?.openSettings } : undefined}>
        <DockFrame layout={frameLayout} shown={shown} panels={panels} onActivate={activateTab} onResize={dock.resize} onClose={close}>
          <ConsoleChannelsContext.Provider value={consoleChannels}>
            <CenterWithConsole selection={selection} layouts={layouts} fileLinks={fileLinks} fontFamily={fontFamily} flow={children} home={home} console={consoleChannels} pane={pane} openProblem={openFileOf} plugins={plugins.center} />
          </ConsoleChannelsContext.Provider>
        </DockFrame>
      </DockBody>
      {footer?.(shownIdOf(selection), shownIdOf(selection) === undefined ? undefined : shownFile(layouts.layout))}
      {quick.dialogs}
      {searchClose.dialog}
      {newIn && newActivity?.({ ...newIn, onStarted: openStarted, onClose: () => setNewIn(undefined) })}
    </>
  );
  const shownActivity = selection.center === 'activities' && current ? activityKey(current) : undefined; // where a copy opens as a tab (#587, #590)
  return (
    <Openers openRun={openUserRun} openStarted={openStarted} openDiff={openTaskDiff} openPr={openPr} openIssue={openIssue} openFile={openActivityFile} openConsole={openConsole} openStageOutput={openStageOutput}>
      {copySession ? copySession(shownActivity, content) : content}
    </Openers>
  );
}
