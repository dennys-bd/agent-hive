import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { Flow, ProjectItem, RepoSummary, SourceConfig, State, Task } from '../../types';
import { taskOfPr } from '../../activities';
import { flowOf } from '../../flows';
import { issueOfLink, issueUrl, taskOfIssue } from '../../repos/issue-task';
import { buildPrLink, GITHUB_HOST, parsePrLink, repoKey } from '../../repo-host';
import { HIVE_SOURCE } from '../../tasks';
import type { DetailPage, Selection } from '@/components/DetailPanel';
import type { BackLink, RepoTab } from '@/components/FlowHeader';
import type { SourcesNav } from '@/components/FlowSources';
import type { IssueRef } from '@/components/IssuePage';
import type { PrRef } from '@/components/PrPage';
import { t } from '@/i18n';

export type TasksView = 'list' | 'flow' | 'outside';
/** What the Tarefas view's center shows (#571, decomposition §Navigation): a view of the tasks, a source's table or one of its issues, or a
 * repository's list on a tab or one of its pages. In memory only: a reload starts on the first flow. */
export type TasksCenter =
  | { kind: 'tasks'; view: TasksView; flow?: string } // flow: the flowchart's flow; absent = the first
  | { kind: 'source'; source: string; issue?: IssueRef }
  | { kind: 'repo'; host: string; repository: string; tab: RepoTab; issue?: IssueRef; pr?: PrRef }; // #1045: the repository by its host and path

export const FIRST_CENTER: TasksCenter = { kind: 'tasks', view: 'flow' };

/** Decision 7 (#571): a center whose flow, source or repository a Settings save or the last read removed reads as the first flow, so a stale
 * one never renders. #572: the hive source is a source while it is on, with no SourceConfig of its own. */
export function resolveCenter(center: TasksCenter, flows: readonly Flow[], sources: readonly SourceConfig[], repositories: readonly RepoSummary[], hasHive: boolean): TasksCenter {
  if (center.kind === 'tasks') return center.flow === undefined || flows.some((f) => f.name === center.flow) ? center : FIRST_CENTER;
  if (center.kind === 'source') return (hasHive && center.source === HIVE_SOURCE) || sources.some((s) => s.name === center.source) ? center : FIRST_CENTER;
  return repositories.some((r) => repoKey(r) === repoKey(center)) ? center : FIRST_CENTER;
}

// Stage names are unique across the comb (#564), so a task's stage alone names its flow; a stage of no flow is outside every flowchart
export function centerOfTask(flows: readonly Flow[], task: Pick<Task, 'stage'>): TasksCenter {
  const flow = flowOf(flows, task.stage);
  return flow ? { kind: 'tasks', view: 'flow', flow: flow.name } : { kind: 'tasks', view: 'outside' };
}

export const centerOfRepo = (host: string, repository: string): TasksCenter => ({ kind: 'repo', host, repository, tab: 'prs' });

// Decision 1-2 (#921): a list's way back, to the last flow shown while it exists, else the first; none with no flow (TasksSoon)
function flowBack(flows: readonly Flow[], lastFlow: string | undefined, show: (next: TasksCenter) => void): BackLink | undefined {
  const flow = flows.find((f) => f.name === lastFlow) ?? flows[0];
  return flow && { label: flow.name, toFlow: true, onBack: () => show({ kind: 'tasks', view: 'flow', flow: flow.name }) };
}

/** Decision 3 (#571): a page goes back to the list it was opened from, a source's issue to its table, a repository's page to its list on the
 * same tab. #921: todas em lista, a source's table and a repository's list go back to the last flow; a flow and sem fluxo have no way back. */
export function backOf(center: TasksCenter, show: (next: TasksCenter) => void, flows: readonly Flow[], lastFlow: string | undefined): BackLink | undefined {
  if (center.kind === 'source') return center.issue ? { label: t('back.list'), onBack: () => show({ kind: 'source', source: center.source }) } : flowBack(flows, lastFlow, show);
  if (center.kind === 'repo') {
    return center.issue || center.pr ? { label: t('back.list'), onBack: () => show({ kind: 'repo', host: center.host, repository: center.repository, tab: center.tab }) } : flowBack(flows, lastFlow, show);
  }
  return center.view === 'list' ? flowBack(flows, lastFlow, show) : undefined;
}

const isSamePr = (a: PrRef | undefined, b: PrRef): boolean => a !== undefined && repoKey(a) === repoKey(b) && a.number === b.number;

// openIssue: under a source its issue page, under a repository its issue page on the tab it is on; the tasks view opens none
function withIssue(center: TasksCenter, issue: IssueRef): TasksCenter {
  if (center.kind === 'source') return { kind: 'source', source: center.source, issue };
  if (center.kind === 'repo') return { kind: 'repo', host: center.host, repository: center.repository, tab: center.tab, issue };
  return center;
}

// The page the details panel hosts (#64), read from the resolved center, so the panel never hosts a page that is not on screen
function shownPage(state: State, center: TasksCenter): DetailPage | undefined {
  if (center.kind === 'repo' && center.pr) {
    const url = buildPrLink(center.pr);
    return { kind: 'pr', url, task: taskOfPr(state, url) };
  }
  const issue = center.kind === 'tasks' ? undefined : center.issue;
  if (issue === undefined) return undefined;
  const url = issueUrl(issue.repository, issue.number);
  return { kind: 'issue', url, task: taskOfIssue(state.tasks, url, issue.itemId) };
}

type IsListed = (ref: { host: string; repository: string }) => boolean;

// A native view row (#757): its issue's page when the Hive lists the issue's repository on github.com, a source's issue being GitHub's until
// #792 (#1045); otherwise GitHub, as before, since every repository route answers 404 outside the list
function projectOpener(isListed: IsListed, openIssue: (ref: IssueRef) => void, goTo: (taskId: string) => void): (item: ProjectItem, task?: Task) => void {
  return (item, task) => {
    const { repository } = item;
    if (repository === undefined || !isListed({ host: GITHUB_HOST, repository })) {
      // not listed, not read yet or its read failed: a task still has its detail to go to; only a row out of the flow falls back to GitHub
      return task ? goTo(task.item.itemId) : void window.open(item.url, '_blank', 'noreferrer');
    }
    openIssue({ host: GITHUB_HOST, repository, number: Number(item.id), itemId: item.itemId }); // #686: its fields, Priority among them, are read by the page
  };
}

// The PR page's task #N (#758): its issue's page under its repository when the Hive lists it on github.com (#1045), else GitHub
function issueOpener(isListed: IsListed, openIssueIn: (ref: IssueRef) => void): (url: string) => void {
  return (url) => {
    const ref = issueOfLink(url);
    if (ref !== undefined && isListed({ host: GITHUB_HOST, repository: ref.repository })) return openIssueIn({ ...ref, host: GITHUB_HOST });
    window.open(url, '_blank', 'noreferrer');
  };
}

/** Every way into a PR (#758): its page under its repository when the Hive lists the link's host and path (#1045); else GitHub, saying why.
 * ponytail: decided on the list as read; a PR opened before the sidebar's first read opens on GitHub */
function prOpener(isListed: IsListed, openPr: (ref: PrRef) => void): (url: string) => void {
  return (url) => {
    const link = parsePrLink(url);
    if (link !== undefined && isListed(link)) return openPr(link);
    toast(t('pr.notListed'));
    window.open(url, '_blank', 'noreferrer');
  };
}

// Decision 10: the task's flow, or outside when its stage is in none, then the task selected once the state holds it (a task just created
// arrives after POST /tasks answers, and App drops a selection whose task the state lacks); until then the first flow
function useGoTo(state: State | undefined, show: (next: TasksCenter) => void, onSelect: (selection: Selection) => void): (taskId: string) => void {
  const [goingTo, setGoingTo] = useState<string>();
  useEffect(() => {
    const task = goingTo === undefined ? undefined : state?.tasks.find((c) => c.item.itemId === goingTo);
    if (!task || !state) return;
    setGoingTo(undefined);
    show(centerOfTask(state.flows, task));
    onSelect({ taskId: task.item.itemId });
  }, [state, goingTo, show, onSelect]);
  return (taskId) => {
    const known = state?.tasks.find((c) => c.item.itemId === taskId);
    show(known && state ? centerOfTask(state.flows, known) : FIRST_CENTER);
    setGoingTo(taskId);
  };
}

export interface TasksNav {
  center: TasksCenter; flow?: Flow; source?: SourceConfig; repo?: RepoSummary;
  show(next: TasksCenter): void; goTo(taskId: string): void;
  openIssue(ref: IssueRef): void; // a page under the current source or repository
  openIssueIn(ref: IssueRef): void; // an issue page under its repository's issues tab (the PR page's task #N)
  openPr(ref: PrRef): void; // a PR page under its repository's PRs tab
  onRepoTab(tab: RepoTab): void; // a tab's click: its list, closing the page
  onMerged(pr: PrRef): void; // #921: a merge's back, only while the stored center is still that PR's page
  openPrUrl(url: string): void; openIssueUrl(url: string): void; openProjectItem(item: ProjectItem, task?: Task): void;
  back?: BackLink; page?: DetailPage;
}

function resolvedOf(center: TasksCenter, flows: readonly Flow[], sources: readonly SourceConfig[], repositories: readonly RepoSummary[]): Pick<TasksNav, 'flow' | 'source' | 'repo'> {
  if (center.kind === 'source') return { source: sources.find((s) => s.name === center.source) };
  if (center.kind === 'repo') return { repo: repositories.find((r) => repoKey(r) === repoKey(center)) };
  return center.view === 'flow' ? { flow: flows.find((f) => f.name === center.flow) ?? flows[0] } : {};
}

export function useTasksCenter(state: State | undefined, sources: SourcesNav | undefined, repositories: RepoSummary[], onSelect: (selection: Selection) => void): TasksNav {
  const [stored, setCenter] = useState<TasksCenter>(FIRST_CENTER);
  const flows = state?.flows ?? [];
  const external = sources?.sources ?? [];
  const center = resolveCenter(stored, flows, external, repositories, sources?.hiveSource !== false); // #846: absent (a harness) = hive on
  // Decision 2 (#921): the flow last shown, in memory as the center is. Set during render, so every way into a flow (show, goTo, a back,
  // the first center) records it; React re-renders before painting
  const [lastFlow, setLastFlow] = useState<string>();
  const shownFlow = center.kind === 'tasks' && center.view === 'flow' ? (center.flow ?? flows[0]?.name) : undefined;
  if (shownFlow !== undefined && shownFlow !== lastFlow) setLastFlow(shownFlow);
  // Decision 12 (#921): read when the merge lands, so a merge the user walked away from leaves the center where they took it
  const onMerged = (pr: PrRef): void => setCenter((c) => (c.kind === 'repo' && isSamePr(c.pr, pr) ? { kind: 'repo', host: c.host, repository: c.repository, tab: c.tab } : c));
  const goTo = useGoTo(state, setCenter, onSelect);
  const isListed: IsListed = (ref) => repositories.some((r) => repoKey(r) === repoKey(ref));
  const openIssue = (ref: IssueRef): void => setCenter((c) => withIssue(c, ref));
  const openIssueIn = (ref: IssueRef): void => setCenter({ kind: 'repo', host: ref.host, repository: ref.repository, tab: 'issues', issue: ref });
  const openPr = (ref: PrRef): void => setCenter({ kind: 'repo', host: ref.host, repository: ref.repository, tab: 'prs', pr: ref });
  return {
    center, ...resolvedOf(center, flows, external, repositories),
    show: setCenter, goTo, openIssue, openIssueIn, openPr,
    onRepoTab: (tab) => setCenter((c) => (c.kind === 'repo' ? { kind: 'repo', host: c.host, repository: c.repository, tab } : c)),
    openPrUrl: prOpener(isListed, openPr), openIssueUrl: issueOpener(isListed, openIssueIn), openProjectItem: projectOpener(isListed, openIssue, goTo),
    onMerged, back: backOf(center, setCenter, flows, lastFlow), page: state && shownPage(state, center),
  };
}
