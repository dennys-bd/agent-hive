import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { taskOfPr } from '../../activities';
import { prLink, prRepo, repoName } from '../../pull-requests';
import { issueOfLink } from '../../repos/issue-task';
import type { PrData, State, Task } from '../../types';
import { DetailSlot } from '@/components/DetailSlot';
import { useIsFlowShown } from '@/components/MainDock';
import { closingLabel } from '@/components/PrBlock';
import { PrConversation } from '@/components/PrConversation';
import { PrTitle } from '@/components/PrDescription';
import { PrFiles, PrStatus } from '@/components/PrFiles';
import { PrProperties } from '@/components/PrProperties';
import { ReviewBar } from '@/components/ReviewBar';
import { ReviewPopover } from '@/components/ReviewPopover';
import { ReviewSurfaceContext } from '@/components/review-surface';
import { usePr } from '@/hooks/use-pr';
import { type PrReviewView, usePrView } from '@/hooks/use-pr-view';
import { t } from '@/i18n';
import { timelineItems } from '@/lib/pr-timeline';

/** The PR a page shows (#758): its repository and number. */
export interface PrRef { repository: string; number: number }
type PageTab = 'conversation' | 'files';

export interface PrPageProps {
  state: State; pr: PrRef;
  header(reload: () => Promise<void>, github: string): ReactNode; // the repository header; its atualizar reads the PR again, its GitHub ↗ opens `github` (#352)
  onGoTo(taskId: string): void; // a task with no GitHub issue: its detail in the flow
  onOpenIssue(url: string): void; // task #N: its issue's page
  onOpenPr(url: string): void; // a stack's part: its PR's page, or GitHub
  onMerged?(): void; // #69: a merge with the Hive's button goes back as the header's does; absent (a page outside the Dashboard), the page reads the PR again
}

// The inner tabs (handoff 03 "Topo"): conversation N and files N, a spacer, then what the page puts on the right
function PageTabs({ tab, pr, onTab, children }: { tab: PageTab; pr: PrData; onTab(tab: PageTab): void; children: ReactNode }) {
  const item = (id: PageTab, label: string, n: number) => (
    <button
      key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onTab(id)}
      className={`border-b-2 px-3 py-2 font-medium text-[13px] ${tab === id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      {label} <span className="font-normal text-muted-foreground text-xs">{n}</span>
    </button>
  );
  return (
    <div className="flex shrink-0 items-center gap-3 border-b px-6">
      <div role="tablist" className="flex">{item('conversation', t('pr.tab.conversation'), timelineItems(pr).length)}{item('files', t('pr.tab.files'), pr.files.length)}</div>
      <span className="flex-1" />
      {children}
    </div>
  );
}

// task #N · {repo} (handoff 03): the task's issue page, or the task's detail when it has no GitHub issue
function TaskLink({ task, pr, onGoTo, onOpenIssue }: { task: Task; pr: PrData; onGoTo(taskId: string): void; onOpenIssue(url: string): void }) {
  const issue = issueOfLink(task.item.url);
  const open = (): void => (issue === undefined ? onGoTo(task.item.itemId) : onOpenIssue(task.item.url));
  return (
    <button type="button" className="text-muted-foreground text-xs hover:text-foreground" onClick={open}>
      {t('pr.task', { n: task.item.id, repo: repoName(issue?.repository ?? prRepo(pr.url)) })}
    </button>
  );
}

// closes #458, #460 (handoff 7 "Na conversa"): a PR no task holds names the issues it closes where a task's PR names its task; each opens its
// page. The list sits inside the message where {list} is, as the description splits its {id}
function ClosesLink({ pr, onOpenIssue }: { pr: PrData; onOpenIssue(url: string): void }) {
  if (pr.closes.length === 0) return null;
  const [before, after] = t('pr.closes').split('{list}');
  return (
    <span className="text-muted-foreground text-xs">
      {before}
      {pr.closes.map((issue, i) => (
        <Fragment key={issue.url}>
          {i > 0 && ', '}
          <button type="button" className="hover:text-foreground" onClick={() => onOpenIssue(issue.url)}>{closingLabel(issue, pr.url)}</button>
        </Fragment>
      ))}
      {after}
    </span>
  );
}

// files (handoff 03 "Aba arquivos"): 12px 16px 16px, no properties; the bar's counts, layout and hide reviewed over the diff
function FilesTab({ pr, view, onRefresh }: { pr: PrData; view: PrReviewView; onRefresh(): void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pt-3 pb-4 text-xs">
      <ReviewBar
        label={t('pr.tab.files')} left={null} files={pr.files} notice={pr.truncated ? <span>{t('pr.truncated')}</span> : undefined}
        layout={view.layout} reviewed={view.reviewedCount} hideReviewed={view.nav.hideReviewed} onLayout={view.setLayout} onRefresh={onRefresh} onHideReviewed={view.nav.setHideReviewed}
      />
      <PrFiles pr={pr} view={view} />
    </div>
  );
}

/** A PR's own page (#758, handoff 03) under its repository's header: its title, the inner tabs, then conversation or files. Read on opening,
 * on the header's atualizar and after every write; neither read nor polled while hidden under Atividades. Its properties are its block in
 * the details panel's slot on both tabs (#64), the this PR box on a task's PR (#66), the PR without activity on a PR no task holds, whose tab bar
 * names the issues it closes (#68); before the PR is read, the read line. */
export function PrPage({ state, pr: ref, header, onGoTo, onOpenIssue, onOpenPr, onMerged }: PrPageProps) {
  const url = prLink(ref.repository, ref.number);
  const isShown = useIsFlowShown();
  const { load, refresh, review, reread } = usePr(url, isShown);
  const [tab, setTab] = useState<PageTab>('conversation');
  const pr = load.status === 'ready' ? load.pr : undefined;
  // #352: GitHub's own URL once read, the ref's before, so the button is there from the first frame; the files tab has its own page there
  const github = `${pr?.url ?? url}${tab === 'files' ? '/files' : ''}`;
  const reload = async (): Promise<void> => {
    reread();
    await refresh();
  };
  const view = usePrView(pr, review, reread, () => void reload());
  const [jump, setJump] = useState<string>();
  // open in diff (#758): once files has drawn its sections, the thread's file comes into view, as ] and [ bring one
  useEffect(() => {
    if (tab !== 'files' || jump === undefined) return;
    view.nav.show(jump);
    setJump(undefined);
  }, [tab, jump, view.nav]);
  const openInDiff = (path: string): void => {
    setTab('files');
    setJump(path);
  };
  if (pr === undefined || view.surface === undefined) {
    return <div className="flex min-h-0 flex-1 flex-col">{header(reload, github)}<PrStatus load={load} /><DetailSlot><PrStatus load={load} /></DetailSlot></div>;
  }
  const task = taskOfPr(state, url);
  const drafts = review?.drafts.length ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header(reload, github)}
      <div className="px-6 pt-4 pb-2"><PrTitle pr={pr} onChanged={reload} /></div>
      <PageTabs tab={tab} pr={pr} onTab={setTab}>
        {pr.state === 'open' && <ReviewPopover pr={pr} drafts={drafts} onSent={() => void reload()} />}
        {task ? <TaskLink task={task} pr={pr} onGoTo={onGoTo} onOpenIssue={onOpenIssue} /> : <ClosesLink pr={pr} onOpenIssue={onOpenIssue} />}
      </PageTabs>
      <ReviewSurfaceContext.Provider value={view.surface}>
        {tab === 'conversation'
          ? <div className="flex min-h-0 flex-1"><PrConversation pr={pr} task={task} state={state} onChanged={reload} onOpenPr={onOpenPr} onOpenInDiff={openInDiff} onMerged={onMerged} /></div>
          : <FilesTab pr={pr} view={view} onRefresh={() => void refresh()} />}
      </ReviewSurfaceContext.Provider>
      <DetailSlot>
        <PrProperties pr={pr} task={task} state={state} drafts={drafts} onGoTo={onGoTo} onReloaded={() => void reload()} onOpenIssue={onOpenIssue} onOpenPr={onOpenPr} />
      </DetailSlot>
    </div>
  );
}
