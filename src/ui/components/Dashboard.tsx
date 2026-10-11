import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ProjectItem, RepoSummary, SidebarsPerView, SourceConfig, SourceSync, EffectiveLimits, State, Task } from '../../types';
import { issueOfLink } from '../../repos/issue-task';
import { prNumber, prRepo } from '../../pull-requests';
import { HIVE_SOURCE, sourceOf } from '../../tasks';
import { CreateTargetsContext, createTargetsOf } from '@/lib/create-targets';
import { ActivityBar } from '@/components/ActivityBar';
import { ActivityMenu } from '@/components/ActivityMenu';
import { AutomationPanel } from '@/components/AutomationPanel';
import { MainDock } from '@/components/MainDock';
import { CopySessionHost } from '@/components/CopySession';
import { ConsoleChip } from '@/components/ConsoleDrawer';
import { CrashDialog } from '@/components/CrashDialog';
import { DetailPanel, type Selection } from '@/components/DetailPanel';
import type { SourcesNav } from '@/components/FlowSources';
import { FlowHeader, type RepoHeader, type RepoTab, type SourceTab, type SourceTabs } from '@/components/FlowHeader';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { IssuePage, type IssueRef } from '@/components/IssuePage';
import { activityPane } from '@/components/PaneHeader';
import { StartDialog } from '@/components/StartDialog';
import { Flow } from '@/components/Flow';
import { PrPage, type PrRef } from '@/components/PrPage';
import { ProjectTable } from '@/components/ProjectTable';
import { RepoIssueTable } from '@/components/RepoIssueTable';
import { RepoPrTable } from '@/components/RepoPrTable';
import { t } from '@/i18n';
import { useConsoleChannels } from '@/hooks/use-console';
import { useRepositories } from '@/hooks/use-repositories';
import { FONT_FAMILY } from '@/lib/xterm-setup';

// tick is not read: its only job is to change every RERENDER_MS so elapsed()/relative readings redraw between events.
export interface DashboardProps {
  state: State | undefined; effective?: EffectiveLimits; selected?: Selection; locale: string; tick: number; hasSource?: boolean; fileLinks?: boolean; fontFamily?: string; sources?: SourcesNav; onSelect(selection?: Selection): void; onEditRules?(): void; onAddWorkspace?(): void; onOpenSettings?(): void; openShortcuts?(): void;
  sidebarsPerView?: SidebarsPerView; // #821: what each view keeps of its sidebars; absent (the tests' harness): every side shared
}

// The fallback signal (#357): without an effective reading yet, the footer's pill colors by the manual signal alone.
const manualSignal = (state: State): EffectiveLimits => ({ signal: state.signal, floor: { signal: 'green' }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} });

const NO_SOURCES: SourcesNav = { sources: [], auth: 'cli' }; // no config handed (the tests' harness): only todas and hive

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

// The flow sidebar's pick (redesign 09): a source or a repository (#757), one at a time; for an external source its header's tab (#756);
// and the issue or the PR whose page shows (#757, #758). A new pick starts on its default tab with no page, a tab's click closes the page, and nothing of it
// is saved. A pick whose source a Settings save renamed or removed reads as todas, not as an empty flow; hive is a row while it is on (#665, #846). A
// repository the last read no longer lists reads as no pick
function useSourcePick(sources: SourcesNav | undefined, repositories: RepoSummary[]) {
  const [source, setSource] = useState<string>();
  const [repository, setRepository] = useState<string>();
  const [tab, setTab] = useState<SourceTab>('flow');
  const [repoTab, setRepoTab] = useState<RepoTab>('prs');
  const [issue, setIssue] = useState<IssueRef>();
  const [pr, setPr] = useState<PrRef>();
  const repo = repositories.find((r) => r.repository === repository);
  const hasHive = sources?.hiveSource !== false;
  const picked = (source === HIVE_SOURCE && hasHive) || sources?.sources.some((b) => b.name === source) ? source : undefined;
  const external: SourceConfig | undefined = sources?.sources.find((b) => b.name === picked); // todas and hive have no native view
  const choose = (next: { source?: string; repository?: string }, page: { repoTab?: RepoTab; issue?: IssueRef; pr?: PrRef } = {}): void => {
    setSource(next.source);
    setRepository(next.repository);
    setTab('flow');
    setRepoTab(page.repoTab ?? 'prs');
    setIssue(page.issue);
    setPr(page.pr);
  };
  const onRepoTab = (next: RepoTab): void => {
    setIssue(undefined);
    setPr(undefined);
    setRepoTab(next);
  };
  const onTab = (next: SourceTab): void => {
    setIssue(undefined); // the active tab again: back to its list
    setTab(next);
  };
  const tabs: SourceTabs | undefined = external ? { label: t(`flow.tab.native.${external.type}`), active: tab, onPick: onTab } : undefined;
  return {
    picked, external, tabs, repo, issue, pr, repoTab, onRepoTab, openIssue: setIssue,
    pick: (name?: string) => choose({ source: name }), pickRepository: (name: string) => choose({ repository: name }),
    showFlow: () => choose({ source }), // the flow, keeping the source pick
    openPrPage: (ref: PrRef) => choose({ repository: ref.repository }, { pr: ref }), // #758: a PR's page under its repository's PRs tab
    openIssueIn: (ref: IssueRef) => choose({ repository: ref.repository }, { repoTab: 'issues', issue: ref }), // #758: the PR page's task #N
  };
}
type SourcePick = ReturnType<typeof useSourcePick>;

// fluxo ›, a task's row and a task created from the native view or an issue page (#756, #757): the flow tab, then the task in the detail
// panel once the state holds it. A task just created reaches the state after POST /tasks answers, and App drops a selection whose task the
// state lacks. A task of another source than the picked one (a hive task made from an issue) moves the pick to its source, or the flow would hide it
function useGoTo(state: State | undefined, picked: string | undefined, follow: (source: string) => void, onSelect: (selection: Selection) => void, showFlow: () => void): (taskId: string) => void {
  const [goingTo, setGoingTo] = useState<string>();
  useEffect(() => {
    const task = goingTo === undefined ? undefined : state?.tasks.find((c) => c.item.itemId === goingTo);
    if (!task) return;
    setGoingTo(undefined);
    if (picked !== undefined && sourceOf(task) !== picked) follow(sourceOf(task));
    onSelect({ taskId: task.item.itemId });
  }, [state, goingTo, picked, follow, onSelect]);
  return (taskId) => {
    showFlow();
    setGoingTo(taskId);
  };
}

// A native view row (#757): its issue's page when the Hive lists the issue's repository; otherwise GitHub, as before, since every
// repository route answers 404 outside the list
function projectOpener(picks: SourcePick, repositories: RepoSummary[], goTo: (taskId: string) => void): (item: ProjectItem, task?: Task) => void {
  return (item, task) => {
    const { repository } = item;
    if (repository === undefined || !repositories.some((r) => r.repository === repository)) {
      // not listed, not read yet or its read failed: a task still has its detail to go to; only a row out of the flow falls back to GitHub
      return task ? goTo(task.item.itemId) : void window.open(item.url, '_blank', 'noreferrer');
    }
    picks.openIssue({ repository, number: Number(item.id), itemId: item.itemId }); // #686: its fields, Priority among them, are read by the page
  };
}

// The PR page's task #N (#758): its issue's page under its repository when the Hive lists it, else GitHub
function issueOpener(picks: SourcePick, repositories: RepoSummary[]): (url: string) => void {
  return (url) => {
    const ref = issueOfLink(url);
    if (ref !== undefined && repositories.some((r) => r.repository === ref.repository)) return picks.openIssueIn(ref);
    window.open(url, '_blank', 'noreferrer');
  };
}

/** Every way into a PR (#758): its page under its repository when the Hive lists it; else GitHub, saying why. ponytail: decided on the list as
 * read; a PR opened before the sidebar's first read opens on GitHub */
function prOpener(picks: SourcePick, repositories: RepoSummary[]): (url: string) => void {
  return (url) => {
    const repository = prRepo(url);
    if (repositories.some((r) => r.repository === repository)) return picks.openPrPage({ repository, number: Number(prNumber(url)) });
    toast(t('pr.notListed'));
    window.open(url, '_blank', 'noreferrer');
  };
}

interface CenterProps { state: State; locale: string; selected?: Selection; picks: SourcePick; repositories: RepoSummary[]; onSelect(selection: Selection): void; goTo(taskId: string): void; stageCaps: Record<string, number> }

interface RepoCenterArgs { state: State; locale: string; picks: SourcePick; repo: RepoSummary; goTo(taskId: string): void; onOpenIssue(url: string): void; onOpenPr(url: string): void }

// The center under a repository (#757, #758): its PR list or one PR's page under PRs; its issues or one issue's page under issues. A page
// keeps the header
function repoCenter({ state, locale, picks, repo, goTo, onOpenIssue, onOpenPr }: RepoCenterArgs): ReactNode {
  const heading: RepoHeader = { summary: repo, tab: picks.repoTab, onTab: picks.onRepoTab, onRepository: picks.pickRepository };
  const header = (reload: () => Promise<void>) => <FlowHeader state={state} tasks={[]} repository={heading} onRefresh={reload} />;
  const { issue, pr } = picks;
  if (pr) return <PrPage key={`${pr.repository}#${pr.number}`} state={state} locale={locale} pr={pr} summary={repo} header={header} onGoTo={goTo} onOpenIssue={onOpenIssue} onOpenPr={onOpenPr} />;
  if (issue) {
    return <IssuePage key={`${issue.repository}#${issue.number}`} state={state} locale={locale} issue={issue} meta={repo.repository} workspace={repo.workspace} header={header} onGoTo={goTo} />;
  }
  if (picks.repoTab === 'prs') {
    return <RepoPrTable key={repo.repository} state={state} summary={repo} onTab={picks.onRepoTab} onRepository={picks.pickRepository} onOpen={(row) => picks.openPrPage({ repository: repo.repository, number: row.number })} />;
  }
  return (
    <RepoIssueTable
      key={repo.repository} state={state} summary={repo} onTab={picks.onRepoTab} onRepository={picks.pickRepository}
      onOpen={(read) => picks.openIssue({ repository: repo.repository, number: read.number })}
    />
  );
}

// The center under Automação: a repository's lists and pages (#757, #758), a source's native view or one issue's page (#756, #757), else the
// flow. A page keeps the header it was opened from
function Center({ state, locale, selected, picks, repositories, onSelect, goTo, stageCaps }: CenterProps) {
  const { picked, external, tabs, repo, issue } = picks;
  if (repo) return repoCenter({ state, locale, picks, repo, goTo, onOpenIssue: issueOpener(picks, repositories), onOpenPr: prOpener(picks, repositories) });
  if (external && tabs?.active === 'native') {
    if (issue) {
      return (
        <IssuePage
          key={`${issue.repository}#${issue.number}`} state={state} locale={locale} issue={issue} meta={external.name}
          workspace={repositories.find((r) => r.repository === issue.repository)?.workspace}
          header={(reload) => <FlowHeader state={state} source={external.name} tasks={[]} tabs={tabs} onRefresh={reload} />} onGoTo={goTo}
        />
      );
    }
    return <ProjectTable state={state} source={external} tabs={tabs} onGoTo={goTo} onOpenIssue={projectOpener(picks, repositories, goTo)} />;
  }
  return <Flow state={state} source={picked} selectedId={selected?.taskId} onOpen={(taskId) => onSelect({ taskId })} tabs={tabs} stageCaps={stageCaps} />;
}

/** The dashboard, with the create destinations (#846) its dialogs and popovers read from the context. */
export function Dashboard(props: DashboardProps) {
  return <CreateTargetsContext.Provider value={createTargetsOf(props.sources ?? NO_SOURCES)}><DashboardView {...props} /></CreateTargetsContext.Provider>;
}

function DashboardView({ state, effective, selected, locale, hasSource, fileLinks, fontFamily, sources, onSelect, onEditRules, onAddWorkspace, onOpenSettings, openShortcuts, sidebarsPerView }: DashboardProps) {
  const repositories = useRepositories();
  const picks = useSourcePick(sources, repositories);
  const goTo = useGoTo(state, picks.picked, picks.pick, onSelect, picks.showFlow);
  // #353: the live command runs, and #351: the running worktree setups, as one key, so a run or a setup starting or ending anywhere reads
  // the console's channels again. Before the early return: a hook runs on every render.
  const consoleChannels = useConsoleChannels([
    ...(state?.terminals ?? []).flatMap((s) => (s.command === undefined ? [] : [s.terminalId])),
    ...(state?.activities ?? []).flatMap((a) => (a.setup ? [a.setup.consoleId] : [])),
  ].join(' '));
  if (!state) return null;
  const limits = effective ?? manualSignal(state); // the header's hexagon and the footer show the same signal (#533)
  return (
    // relative + overflow-hidden: an absolute element with no positioned ancestor (a disabled remover's sr-only reason) escaped every
    // clipping panel and grew the page, which then scrolled whole
    <div className="relative flex h-screen flex-col overflow-hidden">
      {/* the dock frame between the header and the footer (#342): the flow, with the Automação tab (#456), the Activities list (#457) and
          the task's detail (#341) each docked as a tab on the left or the right (a run's terminal is a tab of its activity, redesign 07); the console (#353) a drawer over the center, opened by its chip in the footer (redesign 05). Detalhes is always a tab (#452): App drops a selection whose task went, a render late, and the detail
          shows its empty state meanwhile */}
      <MainDock
        sidebarsPerView={sidebarsPerView}
        fileLinks={fileLinks ?? false} fontFamily={fontFamily ?? FONT_FAMILY} workspaces={state.workspaces} sourceWorkspaces={state.sourceWorkspaces} liveActivities={state.activities} activityRecords={state.activityRecords} slept={state.slept} stages={state.stages} onAddWorkspace={onAddWorkspace} openPr={prOpener(picks, repositories)} openIssue={issueOpener(picks, repositories)}
        tasks={state.tasks} workers={state.workers} terminals={state.terminals} selected={selected} onSelect={onSelect} consoleChannels={consoleChannels}
        header={(center, go) => <Header state={state} signal={limits.signal} center={center} onView={go} />}
        automation={() => (
          <AutomationPanel
            state={state} effective={effective} sources={sources ?? NO_SOURCES} source={picks.picked} onSource={picks.pick}
            repository={picks.repo?.repository} onRepository={picks.pickRepository}
          />
        )}
        search={{ state, effective: limits, openSettings: onOpenSettings, openShortcuts }}
        newActivity={(dialog) => <StartDialog state={state} {...dialog} />}
        activityMenu={(task, showFlow, row) => <ActivityMenu task={task} state={state} onShowFlow={showFlow}>{row}</ActivityMenu>}
        activityBar={(activity, focusedRun, showFlow) => <ActivityBar activity={activity} state={state} focusedRun={focusedRun} onShowFlow={showFlow} />}
        paneContext={(activity) => activityPane(activity, state)}
        copySession={(shown, children) => <CopySessionHost state={state} shown={shown}>{children}</CopySessionHost>}
        detail={(view) => <DetailPanel state={state} selected={selected} locale={locale} isShown={view.isShown} onClose={view.onClose} nav={view.nav} />}
      >
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {hasSource && <SyncErrors syncs={state.syncs} />}
          <Center state={state} locale={locale} selected={selected} picks={picks} repositories={repositories} onSelect={onSelect} goTo={goTo} stageCaps={limits.stageCaps} />
        </main>
      </MainDock>
      {/* redesign 02: the signal, the workers, the rules with their pause popover and shut down when done; the manual signal and the
          worker cap stay in the flow sidebar (redesign 09) */}
      <Footer state={state} effective={limits} locale={locale} onEditRules={onEditRules} console={<ConsoleChip console={consoleChannels} />} />
      <CrashDialog state={state} onSelect={(taskId) => onSelect({ taskId })} />
    </div>
  );
}
