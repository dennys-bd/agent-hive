import { type ReactNode, useState } from 'react';
import type { RepoSummary, SidebarsPerView, SourceConfig, SourceSync, EffectiveLimits, State } from '../../types';
import { behaviourOf } from '../../signals';
import { HIVE_SOURCE, inFlow } from '../../tasks';
import { CreateTargetsContext, createTargetsOf } from '@/lib/create-targets';
import { WorkspaceColorsContext } from '@/lib/workspace-color';
import { ActivityBar } from '@/components/ActivityBar';
import { ActivityMenu } from '@/components/ActivityMenu';
import { AutomationPanel } from '@/components/AutomationPanel';
import { MainDock } from '@/components/MainDock';
import { CopySessionHost } from '@/components/CopySession';
import { ConsoleChip } from '@/components/ConsoleDrawer';
import { RunBand } from '@/components/benchmark/run-mode/RunChrome';
import { RunModeHost } from '@/components/benchmark/run-mode/RunModeHost';
import { CrashDialog } from '@/components/CrashDialog';
import { DetailPanel, type Selection } from '@/components/DetailPanel';
import { DetailSlotProvider } from '@/components/DetailSlot';
import { HeaderSlotProvider } from '@/components/HeaderSlot';
import type { SourcesNav } from '@/components/FlowSources';
import { FlowHeader, type HeaderMode } from '@/components/FlowHeader';
import { Footer } from '@/components/Footer';
import { Checkers } from '@/components/footer/Checkers';
import { ProblemsButton } from '@/components/footer/ProblemsButton';
import { Header } from '@/components/Header';
import { IssuePage, type IssueRef } from '@/components/IssuePage';
import { activityPane } from '@/components/PaneHeader';
import { StartDialog } from '@/components/StartDialog';
import { TreeHoverContext } from '@/components/tree-hover';
import { Flow } from '@/components/Flow';
import { displayProps } from '@/components/tasks/DisplayPopover';
import { WorkerlessContext } from '@/components/FlowTask';
import { PrPage } from '@/components/PrPage';
import { ProjectTable } from '@/components/ProjectTable';
import { RepoIssueTable } from '@/components/RepoIssueTable';
import { RepoPrTable } from '@/components/RepoPrTable';
import { t } from '@/i18n';
import { hasTree } from '@/lib/tree-groups';
import { consoleRunsOf, useConsoleChannels } from '@/hooks/use-console';
import { type DisplayControls, useDisplayOptions } from '@/hooks/use-flow-view';
import { useRepositories } from '@/hooks/use-repositories';
import { centerOfRepo, type TasksCenter, type TasksNav, useTasksCenter } from '@/hooks/use-tasks-center';
import { FONT_FAMILY } from '@/lib/xterm-setup';

// tick is not read: its only job is to change every RERENDER_MS so elapsed()/relative readings redraw between events.
export interface DashboardProps {
  state: State | undefined; effective?: EffectiveLimits; selected?: Selection; locale: string; tick: number; hasSource?: boolean; fileLinks?: boolean; fontFamily?: string; sources?: SourcesNav; onSelect(selection?: Selection): void; onEditRules?(): void; onAddWorkspace?(): void; onOpenSettings?(): void; openShortcuts?(): void; onOpenFlowSettings?(): void; onNewFlow?(): void; // #536: the benchmark base dialog's link to Settings > fluxo; #565: onNewFlow is the tasks sidebar's +, landing on a new flow
  sidebarsPerView?: SidebarsPerView; // #821: what each view keeps of its sidebars; absent (the tests' harness): every side shared
}

// The fallback signal (#357): without an effective reading yet, the footer's pill colors by the manual signal alone.
const manualSignal = (state: State): EffectiveLimits => ({ signal: state.signal, floor: { signal: 'green' }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} });

const NO_SOURCES: SourcesNav = { sources: [], auth: 'cli' }; // no config handed (the tests' harness): only hive

// A source whose last poll failed says so above the flow (#180, #533); a status a source no longer configured left in state.json stays hidden
function SyncErrors({ syncs }: { syncs: Record<string, SourceSync> }) {
  const errors = Object.entries(syncs).flatMap(([name, { error }]) => (error ? [{ name, error }] : []));
  if (errors.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 px-3.5 pt-2 text-xs text-destructive">
      {errors.map(({ name, error }) => <span key={name}>{t('header.sourceError', { name, error })}</span>)}
    </div>
  );
}

interface CenterProps { state: State; selected?: Selection; nav: TasksNav; repositories: RepoSummary[]; onSelect(selection: Selection): void; stageCaps: Record<string, number>; sources: SourcesNav; display: DisplayControls }
type RepoCenter = Extract<TasksCenter, { kind: 'repo' }>;

// The center under a repository (#757, #758): its PR list or one PR's page under PRs, its issues or one issue's page under issues. A page keeps
// the header; #911: only a page's header carries the way back; #69: a merge goes back as that button does, to the PR list (decision 3)
function repoCenter(state: State, nav: TasksNav, repo: RepoSummary, center: RepoCenter): ReactNode {
  const onRepository = (name: string): void => nav.show(centerOfRepo(name));
  const mode: HeaderMode = { kind: 'repo', header: { summary: repo, tab: center.tab, onTab: nav.onRepoTab, onRepository } };
  const header = (reload: () => Promise<void>, github: string) => <FlowHeader state={state} mode={mode} tasks={[]} onRefresh={reload} back={nav.back} github={github} />;
  const { issue, pr } = center;
  if (pr) return <PrPage key={`${pr.repository}#${pr.number}`} state={state} pr={pr} header={header} onGoTo={nav.goTo} onOpenIssue={nav.openIssueUrl} onOpenPr={nav.openPrUrl} onMerged={nav.back?.onBack} />;
  if (issue) return <IssuePage key={`${issue.repository}#${issue.number}`} state={state} issue={issue} meta={repo.repository} workspace={repo.workspace} header={header} onGoTo={nav.goTo} onOpenPr={nav.openPrUrl} />;
  if (center.tab === 'prs') return <RepoPrTable key={repo.repository} state={state} summary={repo} onTab={nav.onRepoTab} onRepository={onRepository} onOpen={(row) => nav.openPr({ repository: repo.repository, number: row.number })} />;
  return <RepoIssueTable key={repo.repository} state={state} summary={repo} onTab={nav.onRepoTab} onRepository={onRepository} onOpen={(read) => nav.openIssue({ repository: repo.repository, number: read.number })} />;
}

// A source's table (#756, handoff §5), or one of its issues' pages (#757) under the source header
function sourceCenter(state: State, nav: TasksNav, source: SourceConfig, repositories: RepoSummary[], issue?: IssueRef): ReactNode {
  if (!issue) return <ProjectTable state={state} source={source} onGoTo={nav.goTo} onOpenIssue={nav.openProjectItem} />;
  return (
    <IssuePage
      key={`${issue.repository}#${issue.number}`} state={state} issue={issue} meta={source.name}
      workspace={repositories.find((r) => r.repository === issue.repository)?.workspace}
      header={(reload, github) => <FlowHeader state={state} mode={{ kind: 'source', source }} tasks={[]} onRefresh={reload} back={nav.back} github={github} />}
      onGoTo={nav.goTo} onOpenPr={nav.openPrUrl}
    />
  );
}

// Decision 11 (#571): the list and outside-flow views, until 3.2 / 3.3: the tasks header, with exibir minus its voltas rows (#574), over one
// muted line. The popover counts what the view will show: every task, or the stageless ones outside
function TasksSoon({ state, isOutside, display, sources }: { state: State; isOutside: boolean; display: DisplayControls; sources: SourcesNav }) {
  const tasks = isOutside ? state.tasks.filter((c) => !inFlow(c)) : state.tasks;
  const isTree = display.options.tree ?? hasTree(state.tasks);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FlowHeader state={state} tasks={[]} {...displayProps({ display, sources, tasks, isTree, hasLoops: false })} />
      <p className="px-3.5 py-3 text-muted-foreground text-xs">{t('tasks.center.soon')}</p>
    </div>
  );
}

// #572 decision 14: the hive source's center until 4.2 builds its table: the source header naming hive, over one muted line
function HiveSoon({ state }: { state: State }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FlowHeader state={state} tasks={[]} mode={{ kind: 'source', source: HIVE_SOURCE }} />
      <p className="px-3.5 py-3 text-muted-foreground text-xs">{t('tasks.center.soon')}</p>
    </div>
  );
}

// The center under Tarefas (#571): what the resolved TasksCenter names. Flow is the same element across flows, so a switch keeps it mounted (decision 9)
function Center({ state, selected, nav, repositories, onSelect, stageCaps, sources, display }: CenterProps) {
  const { center, repo, source } = nav;
  if (center.kind === 'repo' && repo) return repoCenter(state, nav, repo, center);
  if (center.kind === 'source' && center.source === HIVE_SOURCE) return <HiveSoon state={state} />;
  if (center.kind === 'source' && source) return sourceCenter(state, nav, source, repositories, center.issue);
  if (center.kind === 'tasks' && center.view === 'flow' && nav.flow) return <Flow state={state} flow={nav.flow} selectedId={selected?.taskId} onOpen={(taskId) => onSelect({ taskId })} stageCaps={stageCaps} display={display} sources={sources} />;
  return <TasksSoon state={state} isOutside={center.kind === 'tasks' && center.view === 'outside'} display={display} sources={sources} />;
}

// #36: the details' tree row under the pointer, shared by the details (which set it) and the flow's cards (which light up). A component of its
// own around DashboardView: a hover re-renders only the context's readers, never the whole dashboard
function TreeHoverHost({ children }: { children: ReactNode }) {
  const [hoveredId, setHoveredId] = useState<string>();
  return <TreeHoverContext.Provider value={{ hoveredId, setHoveredId }}>{children}</TreeHoverContext.Provider>;
}

const NO_COLORS: Readonly<Record<string, string>> = {};

/** The dashboard, with the workspaces' colours (#78), the create destinations (#846) its dialogs and popovers read from the context, the tree row the details hover (#36), and
 * the details panel's slot (#64) and the header's center slot (#295) around the dock, which a page's block and the flow's bar land in. */
export function Dashboard(props: DashboardProps) {
  return <CreateTargetsContext.Provider value={createTargetsOf(props.sources ?? NO_SOURCES)}><WorkspaceColorsContext.Provider value={props.state?.workspaceColors ?? NO_COLORS}><TreeHoverHost><DetailSlotProvider><HeaderSlotProvider><DashboardView {...props} /></HeaderSlotProvider></DetailSlotProvider></TreeHoverHost></WorkspaceColorsContext.Provider></CreateTargetsContext.Provider>;
}

function DashboardView({ state, effective, selected, locale, hasSource, fileLinks, fontFamily, sources, onSelect, onEditRules, onAddWorkspace, onOpenSettings, openShortcuts, onOpenFlowSettings, onNewFlow, sidebarsPerView }: DashboardProps) {
  const repositories = useRepositories();
  const centerNav = useTasksCenter(state, sources, repositories, onSelect); // #571
  const display = useDisplayOptions(); // #574 decision 13, #572 decision 17: one owner for the center and the sidebar's mostrar só esta
  // #353: the live command runs, and #351: the running worktree setups, as one key, so a run or a setup starting or ending anywhere reads
  // the console's channels again. Before the early return: a hook runs on every render.
  const consoleChannels = useConsoleChannels(consoleRunsOf(state));
  if (!state) return null;
  const limits = effective ?? manualSignal(state); // the header's hexagon and the footer show the same signal (#533)
  return (
    // relative + overflow-hidden: an absolute element with no positioned ancestor (a disabled remover's sr-only reason) escaped every
    // clipping panel and grew the page, which then scrolled whole
    <div className="relative flex h-screen flex-col overflow-hidden">
      {/* the dock frame between the header and the footer (#342): the flow, with the Automação tab (#456), the Activities list (#457) and
          the task's detail (#341) each docked as a tab on the left or the right (a run's terminal is a tab of its activity, redesign 07); the console (#353) a drawer over the center, opened by its chip in the footer (redesign 05). Detalhes is always a tab (#452): App drops a selection whose task went, a render late, and the detail
          shows its empty state meanwhile */}
      {/* #304: the cards hide a CI stage's button while the wait starts on its own, by the reducer's own rule (gateOf's workerless row) */}
      <WorkerlessContext.Provider value={behaviourOf(limits.signal, state.signals).workerless}>
        <MainDock
          showTask={centerNav.goTo}
          sidebarsPerView={sidebarsPerView}
          fileLinks={fileLinks ?? false} fontFamily={fontFamily ?? FONT_FAMILY} workspaces={state.workspaces} sourceWorkspaces={state.sourceWorkspaces} liveActivities={state.activities} activityRecords={state.activityRecords} slept={state.slept} stages={state.stages} experiments={state.benchmark.experiments} rateLimits={state.rateLimits} onAddWorkspace={onAddWorkspace} openPr={centerNav.openPrUrl} openIssue={centerNav.openIssueUrl} openFlowSettings={onOpenFlowSettings}
          tasks={state.tasks} workers={state.workers} terminals={state.terminals} selected={selected} onSelect={onSelect} consoleChannels={consoleChannels} pageKey={centerNav.page?.url}
          // redesign 02 and #225: the signal, the workers, the rules, the shown activity's checkers and problems, the console and shut down; the manual
          // signal and the worker cap stay in the flow sidebar (redesign 09)
          footer={(shown, file) => (
            <Footer
              state={state} effective={limits} locale={locale} onEditRules={onEditRules} console={<ConsoleChip console={consoleChannels} />}
              checkers={<Checkers activityId={shown} path={file} />} problems={<ProblemsButton activityId={shown} console={consoleChannels} />}
            />
          )}
          header={(shell) => <><Header shell={shell} state={state} effective={limits} /><RunBand /></>} // #469: the run's band under the header
          automation={() => <AutomationPanel state={state} effective={effective} sources={sources ?? NO_SOURCES} nav={centerNav} display={display} onNewFlow={onNewFlow} />}
          search={{ state, effective: limits, openSettings: onOpenSettings, openShortcuts }}
          newActivity={(dialog) => <StartDialog state={state} {...dialog} />}
          activityMenu={(task, showFlow, row) => <ActivityMenu task={task} state={state} onShowFlow={showFlow}>{row}</ActivityMenu>}
          activityBar={(activity, focusedRun, showFlow) => <ActivityBar activity={activity} state={state} focusedRun={focusedRun} onShowFlow={showFlow} />}
          paneContext={(activity) => activityPane(activity, state)}
          copySession={(shown, children) => <CopySessionHost state={state} shown={shown}>{children}</CopySessionHost>}
          detail={(view) => <DetailPanel state={state} selected={selected} locale={locale} isShown={view.isShown} onClose={view.onClose} nav={view.nav} onOpenTask={(taskId) => onSelect({ taskId })} page={view.nav.center === 'automation' ? centerNav.page : undefined} onOpenIssue={centerNav.openIssueUrl} />}
        >
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {hasSource && <SyncErrors syncs={state.syncs} />}
            <Center state={state} selected={selected} nav={centerNav} repositories={repositories} onSelect={onSelect} stageCaps={limits.stageCaps} sources={sources ?? NO_SOURCES} display={display} />
          </main>
        </MainDock>
      </WorkerlessContext.Provider>
      <CrashDialog state={state} onSelect={(taskId) => onSelect({ taskId })} />
      <RunModeHost />
    </div>
  );
}
